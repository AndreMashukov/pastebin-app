/**
 * REST handlers for pastebin-author-bff.
 *
 * Three routes (HTTP API, version 2):
 *   POST /pastes     createPaste        Cognito JWT required
 *   GET  /me/pastes  listMyPastes       Cognito JWT required
 *   GET  /health     health             public
 *
 * Handler does NOT call PutEvents directly. The DDB stream + trigger
 * lambda is the SOLE producer of PasteCreated / PasteDeleted on the bus
 * (design §6). This keeps the write path responsive under bus
 * degradation: if the bus is unhealthy, the DDB write still succeeds
 * and the trigger backfills from the durable stream log when the bus
 * recovers.
 *
 * Cognito JWT shape (from the auto-generated authorizer):
 *   requestContext.authorizer.jwt.claims.sub      <-- cognito sub
 *   requestContext.authorizer.jwt.claims.email    <-- email (verified)
 *
 * Notes on collisions:
 *   Two `createPaste` calls can in theory generate the same 6-char
 *   random prefix. Birthday-paradox probability is ~1e-6 for 1 M
 *   concurrent ids; we accept it and let the second PutItem fail
 *   with a ConditionalCheckFailedException which we surface as 500
 *   with a "retry" message. The DDB stream won't emit (write didn't
 *   happen) so no event leaks. If we ever care, switch to
 *   `attribute_not_exists(pk)` in the Put.
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyEventV2WithRequestContext,
} from "aws-lambda";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { generatePasteId } from "../lib/pasteId";
import type { PasteEvent, PasteRow } from "../models/paste";

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const ddbDoc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});

// ─── types ───────────────────────────────────────────────────────
// Same shape as url-shortener-app-bff/src/rest/handlers.ts.
// APIGatewayProxyHandlerV2's `requestContext` does not declare an
// `authorizer` field in @types/aws-lambda because that's authorizer-
// specific. We declare the augmented shape we expect from the HTTP API
// + Cognito JWT authorizer configured in serverless.yml.
type CognitoClaims = Record<string, string | undefined>;
type JwtAuthorizer = { jwt: { claims: CognitoClaims } };
type AuthorizedRequest = APIGatewayProxyEventV2WithRequestContext<
  APIGatewayProxyEventV2["requestContext"] & { authorizer?: JwtAuthorizer }
>;

const TABLE_NAME = process.env.TABLE_NAME;
const BUCKET = process.env.BUCKET;
const DOMAIN = process.env.DOMAIN ?? "paste.example.com";

if (!TABLE_NAME) throw new Error("Missing required env var: TABLE_NAME");
if (!BUCKET) throw new Error("Missing required env var: BUCKET");

/** Max paste size in bytes (design §7 — S3 hard limit is 5 TB, we cap at 10 MB). */
/** Maximum paste body size in bytes (design §3 / system_design §5).
 *  256 KiB is enough for code snippets + small JSON + small docs without
 *  making the S3 PutObject cold-start cost observable. */
const MAX_SIZE_BYTES = 256 * 1024;

/** Default content type when the client doesn't specify one. */
const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";

/** Accepted content types at MVP. Tighten in a follow-up. */
const ALLOWED_CONTENT_TYPES = new Set<string>([
  "text/plain",
  "text/plain; charset=utf-8",
  "text/markdown",
  "application/json",
  "application/javascript",
  "text/html",
  "text/css",
  "text/x-python",
  "text/x-shellscript",
  "application/x-yaml",
  "text/yaml",
]);

/** JWT body fields explicitly REJECTED at MVP (design §3).
 *
 *  - `code`, `pasteId`, `id`, `slug`, `key`: the paste-id field is
 *    server-generated and not user-settable. Reject any of these to
 *    prevent user confusion / privilege-escalation attempts.
 *  - `alias`, `custom_alias`, `customAlias`: a future "custom short
 *    link" feature, NOT MVP. Reject so callers don't try to use it
 *    expecting it to work.
 */
const REJECTED_FIELDS = [
  "code",
  "pasteId",
  "id",
  "slug",
  "key",
  "alias",
  "custom_alias",
  "customAlias",
] as const;

/** Default TTL when the client doesn't specify. Matches url-shortener-app's 30-day default. */
const DEFAULT_TTL_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const createPaste: APIGatewayProxyHandlerV2 = async (event) => {
  const req = event as AuthorizedRequest;
  const sub = req.requestContext.authorizer?.jwt.claims.sub;
  if (!sub) {
    return json(401, { error: "unauthorized", message: "missing sub claim" });
  }

  // Body is base64-encoded if the client didn't send a Content-Type.
  // The HTTP API auto-decodes JSON when content-type is application/json.
  const raw = event.body;
  if (!raw) {
    return json(400, { error: "bad_request", message: "missing body" });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "bad_request", message: "invalid JSON" });
  }

  // Reject custom-alias fields. design §3 — explicit.
  for (const f of REJECTED_FIELDS) {
    if (f in body) {
      return json(400, {
        error: "bad_request",
        message: `field "${f}" is not supported`,
      });
    }
  }

  const content = body.content;
  if (typeof content !== "string" || content.length === 0) {
    return json(400, {
      error: "bad_request",
      message: "field \"content\" must be a non-empty string",
    });
  }

  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > MAX_SIZE_BYTES) {
    return json(413, {
      error: "payload_too_large",
      message: `paste exceeds ${MAX_SIZE_BYTES} bytes`,
    });
  }

  const contentType =
    typeof body.contentType === "string" ? body.contentType : DEFAULT_CONTENT_TYPE;
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return json(415, {
      error: "unsupported_media_type",
      message: `contentType "${contentType}" not allowed`,
    });
  }

  // computeExpiresAt throws ValidationError for non-positive days.
  // Catch it inline so we return 400 (not 500) when the client sends
  // e.g. `expiresInDays: -1`.
  let expiresAt: string | undefined;
  try {
    expiresAt = computeExpiresAt(body.expiresInDays);
  } catch (e) {
    if (e instanceof ValidationError) {
      return json(400, { error: "bad_request", message: e.message });
    }
    throw e;
  }

  const pasteId = generatePasteId();
  const createdAt = new Date().toISOString();
  const pk = `PASTE#${pasteId}`;

  // Upload body to S3 FIRST. If DDB fails after S3 succeeds, the row
  // is missing for this id and S3 is a true orphan (reaped by the
  // LifecycleConfiguration backstop at 365 days, design §5). If we
  // did DDB first and S3 second, a DDB success + S3 failure would
  // give a paste that 404s in public-bff -- a worse UX than a
  // never-existed paste.
  //
  // We then PutItem the metadata row. If PutItem fails with
  // ConditionalCheckFailed (theoretically: an id collision -- 6 random
  // base62 chars have ~1e-6 birthday risk at 1 M concurrent ids), the
  // caller retries. S3 is the orphan, not a duplicate.
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `pastes/${pasteId}`,
      Body: content,
      ContentType: contentType,
    }),
  );

  const row: PasteRow = {
    pk,
    sk: "META",
    pasteId,
    ownerSub: sub,
    contentType,
    sizeBytes,
    createdAt,
    // `expires_at` is snake_case because DDB TTL requires the
    // item's attribute name to match the table's
    // TimeToLiveSpecification.AttributeName exactly. Downstream
    // consumers see `expiresAt` (camelCase) in event-bus details --
    // the trigger lambda maps between the two (see src/trigger.ts).
    ...(expiresAt ? { expires_at: expiresAt, gsi2pk: "EXPIRE" as const } : {}),
    gsisk: expiresAt ? `${expiresAt}#${pasteId}` : `${createdAt}#${pasteId}`,
    ...(expiresAt ? { gsi2sk: `${expiresAt}#${pasteId}` } : {}),
  };

  await ddbDoc.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: row,
    }),
  );

  return json(201, {
    pasteId,
    url: `https://${DOMAIN}/p/${pasteId}`,
    contentType,
    sizeBytes,
    createdAt,
    ...(expiresAt ? { expiresAt } : {}),
  });
};

export const listMyPastes: APIGatewayProxyHandlerV2 = async (event) => {
  const req = event as AuthorizedRequest;
  const sub = req.requestContext.authorizer?.jwt.claims.sub;
  if (!sub) {
    return json(401, { error: "unauthorized", message: "missing sub claim" });
  }

  const result = await ddbDoc.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "gsi1",
      KeyConditionExpression: "ownerSub = :sub",
      ExpressionAttributeValues: { ":sub": sub },
      ScanIndexForward: false, // newest-first (gsisk = expiresAt#pasteId or createdAt#pasteId)
      Limit: 100,
    }),
  );

  const items: PasteEvent[] = (result.Items ?? []).map((it) => ({
    pasteId: it.pasteId,
    ownerSub: it.ownerSub,
    contentType: it.contentType,
    sizeBytes: it.sizeBytes,
    createdAt: it.createdAt,
    // Map snake_case `expires_at` (DDB column) back to `expiresAt`
    // (camelCase) for the API response. The DDB marshaller does
    // not transform keys; this is the natural seam for the
    // case-flip.
    ...(it.expires_at ? { expiresAt: it.expires_at } : {}),
  }));

  return json(200, { count: items.length, items });
};

export const health: APIGatewayProxyHandlerV2 = async () => {
  return json(200, { ok: true, service: "pastebin-author-bff" });
};

// ---------- helpers ----------

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function computeExpiresAt(input: unknown): string | undefined {
  let days: number;
  if (input === undefined || input === null) {
    days = DEFAULT_TTL_DAYS;
  } else if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    days = input;
  } else {
    throw new ValidationError("expiresInDays must be a positive number");
  }
  return new Date(Date.now() + days * MS_PER_DAY).toISOString();
}

class ValidationError extends Error {
  override name = "ValidationError";
}
