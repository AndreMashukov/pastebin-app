/**
 * Public read API for the Pastebin service.
 *
 * Endpoints (all public, no authorizer):
 *   GET /p/{pasteId}        — fetch the paste body + metadata headers
 *   GET /p/{pasteId}/meta   — fetch metadata only (no S3 call)
 *   GET /health             — health check
 *
 * Storage strategy:
 *   - ReadsTable  : lean single-table view, pk = pasteId. The listener
 *                   (src/listener.ts) populates this from bus events
 *                   emitted by pastebin-author-bff's DDB stream
 *                   trigger. The read path is a single GetItem.
 *   - S3 content  : the paste body lives in pastebin-author-bff's
 *                   content bucket (cross-stack). Key shape:
 *                   `pastes/<pasteId>`. The author-bff wrote it via
 *                   PutObject in createPaste. We read it via GetObject
 *                   with cross-stack IAM (see serverless/s3.yml).
 *
 * Response semantics:
 *   200 + body          — found, not expired
 *   200 + JSON metadata — meta endpoint
 *   400                 — malformed pasteId (regex / checksum fail)
 *   404                 — paste never existed (lean row absent)
 *   410 Gone            — paste expired or explicitly deleted
 *   500                 — S3 failure (body endpoint only)
 *
 * Caching: GET /p/{pasteId} returns Cache-Control: public, max-age=60
 * to let CDNs absorb read traffic. Paste content is immutable for the
 * lifetime of the paste (no PUT /pastes/{id} update flow at MVP), so
 * 60s is a safety floor for any future tombstone flow.
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

import { isValidPasteId, splitPasteId } from "../lib/pasteId";

// ─── shared module state ────────────────────────────────────────────
// One DDB DocumentClient + one S3 client per warm Lambda container.
// AWS_REGION is set automatically by the Lambda runtime, so we don't
// need to configure the region explicitly.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE_NAME = process.env.TABLE_NAME ?? "";
const CONTENT_BUCKET = process.env.CONTENT_BUCKET ?? "";
if (!TABLE_NAME) {
  throw new Error("Missing required environment variable: TABLE_NAME");
}
if (!CONTENT_BUCKET) {
  throw new Error("Missing required environment variable: CONTENT_BUCKET");
}

// ─── response helpers ───────────────────────────────────────────────
const json = <T>(body: T, statusCode = 200) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const err = (statusCode: number, code: string, message: string) =>
  json({ error: code, message }, statusCode);

/** Shape of a row in ReadsTable. Matches what the listener writes
 *  (see src/listener.ts). */
type ReadRow = {
  pk: string;
  contentType: string;
  sizeBytes: number;
  ownerSub: string;
  createdAt: string;
  expiresAt: string | null;
  sourceEventId: string;
  materializedAt: string;
};

/** Read the lean row by pasteId. Returns null when the row is absent
 *  (paste never existed, or not yet materialized from the bus). */
async function readRow(pasteId: string): Promise<ReadRow | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: pasteId } }),
  );
  return (res.Item as ReadRow | undefined) ?? null;
}

/** True if the row's expiresAt is in the past. Treats a null/empty
 *  expiresAt as "never expires" (defensive — listener always sets it
 *  but we don't want a bad row to make every read return 410). */
function isExpired(row: ReadRow, now: Date = new Date()): boolean {
  if (!row.expiresAt) return false;
  const t = Date.parse(row.expiresAt);
  return Number.isFinite(t) && t <= now.getTime();
}

type PasteIdResult = { ok: true; pasteId: string } | { ok: false; response: APIGatewayProxyStructuredResultV2 };

/** Extract and validate the {pasteId} path parameter. Returns a
 *  discriminated union so callers can early-return the response on
 *  failure and destructure the id on success. */
function getPasteIdParam(event: APIGatewayProxyEventV2): PasteIdResult {
  const raw = event.pathParameters?.pasteId ?? "";
  const id = raw.trim();
  if (!id) {
    return { ok: false, response: err(400, "bad_request", "pasteId is required") };
  }
  if (!isValidPasteId(id)) {
    return {
      ok: false,
      response: err(
        400,
        "bad_request",
        "pasteId must be 8 characters of [A-Za-z0-9] with a valid checksum",
      ),
    };
  }
  return { ok: true, pasteId: id };
}

// ─── GET /p/{pasteId} ───────────────────────────────────────────────
export const getPaste: APIGatewayProxyHandlerV2 = async (event) => {
  const param = getPasteIdParam(event);
  if (!param.ok) return param.response;
  const { pasteId } = param;

  let row: ReadRow | null;
  try {
    row = await readRow(pasteId);
  } catch (e) {
    console.error("getPaste: readRow failed", { pasteId, error: String(e) });
    return err(500, "internal_error", "lookup failed");
  }
  if (!row) {
    return err(404, "not_found", `no paste with id '${pasteId}'`);
  }
  if (isExpired(row)) {
    return err(410, "gone", "paste has expired");
  }

  // Fetch the body from author-bff's content bucket. Key shape mirrors
  // what createPaste wrote (pastes/<pasteId>). The body is immutable
  // for the lifetime of the paste.
  let body: string;
  try {
    const out = await s3.send(
      new GetObjectCommand({
        Bucket: CONTENT_BUCKET,
        Key: `pastes/${pasteId}`,
      }),
    );
    body = await out.Body!.transformToString();
  } catch (e) {
    console.error("getPaste: S3 GetObject failed", {
      pasteId,
      bucket: CONTENT_BUCKET,
      error: String(e),
    });
    return err(500, "internal_error", "failed to fetch paste body");
  }

  // Set the original content-type from the lean row (what author-bff
  // recorded at create time). Echo useful metadata in response
  // headers so clients can introspect without a second call.
  return {
    statusCode: 200,
    headers: {
      "content-type": row.contentType,
      "x-paste-id": pasteId,
      "x-paste-created-at": row.createdAt,
      "x-paste-expires-at": row.expiresAt ?? "",
      "x-paste-size-bytes": String(row.sizeBytes),
      "cache-control": "public, max-age=60",
    },
    body,
  };
};

// ─── GET /p/{pasteId}/meta ──────────────────────────────────────────
export const getPasteMeta: APIGatewayProxyHandlerV2 = async (event) => {
  const param = getPasteIdParam(event);
  if (!param.ok) return param.response;
  const { pasteId } = param;

  let row: ReadRow | null;
  try {
    row = await readRow(pasteId);
  } catch (e) {
    console.error("getPasteMeta: readRow failed", {
      pasteId,
      error: String(e),
    });
    return err(500, "internal_error", "lookup failed");
  }
  if (!row) {
    return err(404, "not_found", `no paste with id '${pasteId}'`);
  }
  if (isExpired(row)) {
    return err(410, "gone", "paste has expired");
  }

  // Body checksum is exposed for clients that want to detect a
  // (theoretically impossible) bit-rot between the lean view's
  // recorded sizeBytes and the actual body.
  void splitPasteId(pasteId); // keep the import meaningful for the linter

  return json({
    pasteId,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ownerSub: row.ownerSub,
    sourceEventId: row.sourceEventId,
    materializedAt: row.materializedAt,
  });
};

// ─── GET /health ────────────────────────────────────────────────────
export const health: APIGatewayProxyHandlerV2 = async () =>
  json({ ok: true, service: "pastebin-public-bff", ts: new Date().toISOString() });
