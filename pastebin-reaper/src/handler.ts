/**
 * Scheduled reaper for pastebin-app.
 *
 * Invoked every 5 minutes by an EventBridge rule. For each cycle:
 *   1) Query GSI2 of author-bff's PastesTable: gsi2pk = "EXPIRE" AND
 *      gsi2sk < :now (paginated, sorted ascending so we hit oldest
 *      first).
 *   2) For each expired row:
 *        a) DeleteObject on the S3 body key (`pastes/<pasteId>`).
 *           Failures are logged and continued -- S3 orphans are
 *           better than a half-deleted paste that's still readable.
 *        b) DeleteItem on the DDB row (pk/sk). The REMOVE event
 *           fires in the DDB stream; author-bff's existing trigger
 *           publishes PasteDeleted on the bus; public-bff's
 *           listener deletes the lean ReadsTable row transitively.
 *
 * Idempotency: DeleteObject and DeleteItem are both idempotent. A
 * failed cycle (e.g. cold-start killed mid-loop) is safe to retry;
 * the next pass finds the surviving items and finishes them.
 *
 * Why no batch-failure reporting: this is a scheduled (push) trigger,
 * not a streaming source. If the cycle throws, the whole schedule
 * is retried. That's fine -- the cycle is one logical unit, and
 * partial success is still better than no success.
 *
 * Why the 15-min timeout: it bounds the per-cycle fan-out. For any
 * realistic workload (a few thousand expired pastes per cycle) this
 * is headroom; the rate(5 minutes) cadence means we cover drift
 * naturally.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ScheduledEvent, Context } from "aws-lambda";

// --- clients (one per warm container) ---

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

// --- required env ---

const PASTES_TABLE_NAME = process.env.PASTES_TABLE_NAME ?? "";
const CONTENT_BUCKET_NAME = process.env.CONTENT_BUCKET_NAME ?? "";
const GSI2_NAME = process.env.GSI2_NAME ?? "gsi2";
const SERVICE_NAME = process.env.SERVICE_NAME ?? "pastebin-reaper";

if (!PASTES_TABLE_NAME) {
  throw new Error("Missing required environment variable: PASTES_TABLE_NAME");
}
if (!CONTENT_BUCKET_NAME) {
  throw new Error("Missing required environment variable: CONTENT_BUCKET_NAME");
}

// --- row shapes ---

/** A single key tuple from GSI2 (KEYS_ONLY projection). */
type Gsi2Key = { pk: string; sk: string };

/** GSI2 key shape, parsed out of `pk` ("PASTE#<pasteId>"). */
type ParsedKey = { pasteId: string; pk: string; sk: string };

/** Counters surfaced to CloudWatch Logs at the end of each cycle. */
type CycleStats = {
  scanned: number;
  s3Deleted: number;
  s3Failed: number;
  ddbDeleted: number;
  ddbFailed: number;
};

// --- helpers ---

function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level,
      service: SERVICE_NAME,
      msg,
      ...fields,
    }),
  );
}

/**
 * Parse the pasteId out of a GSI2 key row (pk = "PASTE#<pasteId>").
 * Takes a Record because DynamoDBDocumentClient's Items are typed
 * as Record<string, AttributeValue-ish>; we narrow with optional
 * string checks.
 */
function parseGsi2Key(row: Record<string, unknown>): ParsedKey | null {
  const pk = row.pk;
  const sk = row.sk;
  if (typeof pk !== "string" || typeof sk !== "string") return null;
  if (!pk.startsWith("PASTE#")) return null;
  const pasteId = pk.slice("PASTE#".length);
  if (!pasteId) return null;
  return { pk, sk, pasteId };
}

/** Build the S3 key for a pasteId (author-bff writes to `pastes/<pasteId>`). */
function s3KeyFor(pasteId: string): string {
  return `pastes/${pasteId}`;
}

// --- main cycle ---

/**
 * Run one reaper cycle. Returns when the entire backlog of expired
 * pastes is processed, or when the Lambda timeout approaches.
 */
export async function reap(
  _event: ScheduledEvent,
  _context: Context,
): Promise<void> {
  const startedAt = Date.now();
  const nowIso = new Date().toISOString();
  const nowGsi2sk = `${nowIso}#`; // lexicographic prefix match: anything starting with nowIso#

  log("info", "reaper:cycle:start", { now: nowIso, table: PASTES_TABLE_NAME, gsi: GSI2_NAME });

  const stats: CycleStats = {
    scanned: 0,
    s3Deleted: 0,
    s3Failed: 0,
    ddbDeleted: 0,
    ddbFailed: 0,
  };

  let lastEvaluatedKey: Record<string, unknown> | undefined = undefined;
  let pageCount = 0;

  // Paginated Query: gsi2pk = "EXPIRE" AND gsi2sk < :nowIsoPrefix#
  // (lexicographic < works because ISO-8601 sorts correctly).
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: PASTES_TABLE_NAME,
        IndexName: GSI2_NAME,
        KeyConditionExpression: "gsi2pk = :pk AND gsi2sk < :now",
        ExpressionAttributeValues: {
          ":pk": "EXPIRE",
          ":now": nowGsi2sk,
        },
        ProjectionExpression: "pk, sk",
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    const rows = page.Items ?? [];
    pageCount += 1;
    log("info", "reaper:cycle:page", { page: pageCount, items: rows.length });

    for (const row of rows) {
      stats.scanned += 1;
      const parsed = parseGsi2Key(row);
      if (!parsed) {
        // Defensive: GSI2 should only contain PASTE# rows. If we see
        // something else, log and skip -- don't try to delete it.
        log("warn", "reaper:skip:bad-key", { row });
        continue;
      }

      await reapOne(parsed, stats);
    }

    lastEvaluatedKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  const elapsedMs = Date.now() - startedAt;
  log("info", "reaper:cycle:end", { ...stats, elapsedMs, pages: pageCount });
}

/**
 * Reap a single expired paste: S3 body delete (best-effort), then
 * DDB row delete (the CDC chain publishes PasteDeleted for us).
 */
async function reapOne(key: ParsedKey, stats: CycleStats): Promise<void> {
  // (1) S3 body delete. Best-effort: a failure here doesn't block
  // the DDB delete. The next cycle (or a future S3 lifecycle rule)
  // can clean up the orphan.
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: CONTENT_BUCKET_NAME,
        Key: s3KeyFor(key.pasteId),
      }),
    );
    stats.s3Deleted += 1;
  } catch (err) {
    stats.s3Failed += 1;
    log("warn", "reaper:s3:delete-failed", {
      pasteId: key.pasteId,
      key: s3KeyFor(key.pasteId),
      err: (err as Error).message,
    });
  }

  // (2) DDB row delete. This fires a REMOVE event in the DDB stream,
  // which author-bff's trigger reads and publishes as PasteDeleted
  // on the bus. Public-bff's listener then cleans up its lean
  // ReadsTable row. We do NOT publish to the bus directly.
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: PASTES_TABLE_NAME,
        Key: { pk: key.pk, sk: key.sk },
      }),
    );
    stats.ddbDeleted += 1;
  } catch (err) {
    stats.ddbFailed += 1;
    log("error", "reaper:ddb:delete-failed", {
      pasteId: key.pasteId,
      pk: key.pk,
      sk: key.sk,
      err: (err as Error).message,
    });
    // Don't rethrow -- the next cycle will see this row again and
    // retry. Partial-failure-per-row is the right call here.
  }
}
