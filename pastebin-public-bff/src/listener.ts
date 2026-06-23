/**
 * Listener leg of pastebin-public-bff — sole consumer of
 * PasteCreated / PasteDeleted emitted by pastebin-author-bff's DDB
 * stream trigger.
 *
 * Wired to an SQS queue fed by an EventBridge rule on the bus
 * (see serverless/resources.yml). For each event:
 *   - PasteCreated → upsert a lean row into ReadsTable
 *   - PasteDeleted → delete the corresponding row
 *
 * Idempotency: PutCommand (no condition) for upserts is safe here
 * because the input is a pure function of the bus event; replaying
 * the same SQS message just rewrites the same row. DeleteCommand on
 * a missing key is a no-op. So at-least-once delivery becomes
 * effectively exactly-once at the row level.
 *
 * Batch failure reporting (functionResponseType:
 * ReportBatchItemFailures) means a single bad record does not
 * poison the whole batch. We only fail a record when (a) the JSON
 * parse fails, (b) the detail-type is unexpected, or (c) the
 * pasteId is missing. Any transient DDB error is also a per-record
 * failure and will retry up to maxReceiveCount=5 (queue redrive).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

// One DocumentClient per warm Lambda container. AWS_REGION is set
// automatically by the Lambda runtime.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME ?? "";
if (!TABLE_NAME) {
  throw new Error("Missing required environment variable: TABLE_NAME");
}

export const handle = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  log("info", "listener invoked", {
    table: TABLE_NAME,
    recordCount: event.Records.length,
  });

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      log("error", "listener record failed", {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  log("info", "listener done", {
    succeeded: event.Records.length - batchItemFailures.length,
    failed: batchItemFailures.length,
  });

  return { batchItemFailures };
};

/** Detail shape produced by pastebin-author-bff's trigger.ts:buildEntry.
 *  We re-derive the read-row from this — the lean view is a strict
 *  subset of the bus detail. */
type PasteEventDetail = {
  eventName?: string;
  pasteId?: string;
  ownerSub?: string;
  contentType?: string;
  sizeBytes?: number;
  createdAt?: string;
  expiresAt?: string | null;
  approximateCreationDateTime?: string;
  sequenceNumber?: string;
};

async function processRecord(record: SQSRecord): Promise<void> {
  // EventBridge -> SQS delivers a body that looks like:
  //   { "version": "0", "id": "...", "detail-type": "...",
  //     "source": "...", "account": "...", "time": "...",
  //     "region": "...", "resources": [...], "detail": { ... } }
  const body = JSON.parse(record.body) as Record<string, unknown>;
  const detailType = (body["detail-type"] as string | undefined) ?? "";
  const detail = (body.detail as PasteEventDetail | undefined) ?? {};
  const pasteId = detail.pasteId;

  if (!pasteId) {
    throw new Error(
      `listener: missing pasteId in detail (messageId=${record.messageId})`,
    );
  }

  // EventBridge time is when the event was emitted. Fall back to
  // ApproximateCreationDateTime on the DDB record (which is millis
  // since epoch) and finally to "now".
  const materializedAt = new Date().toISOString();

  if (detailType === "PasteCreated") {
    await upsertRead({
      pasteId,
      detail,
      materializedAt,
    });
    log("info", "lean row upserted", {
      messageId: record.messageId,
      pasteId,
      contentType: detail.contentType,
      sizeBytes: detail.sizeBytes,
    });
  } else if (detailType === "PasteDeleted") {
    await deleteRead({ pasteId });
    log("info", "lean row deleted", {
      messageId: record.messageId,
      pasteId,
    });
  } else {
    // We filter to PasteCreated / PasteDeleted at the EventBridge
    // rule level, but defend against misconfiguration here. Throwing
    // puts the record in the failure list so it's surfaced in DLQ
    // metrics and the rule can be re-tuned.
    throw new Error(
      `listener: unexpected detail-type '${detailType}' (messageId=${record.messageId})`,
    );
  }
}

async function upsertRead(args: {
  pasteId: string;
  detail: PasteEventDetail;
  materializedAt: string;
}): Promise<void> {
  const { pasteId, detail, materializedAt } = args;
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: pasteId,
        contentType: detail.contentType ?? "text/plain",
        sizeBytes: detail.sizeBytes ?? 0,
        ownerSub: detail.ownerSub ?? "",
        createdAt: detail.createdAt ?? materializedAt,
        // expiresAt may be null on detail (the author-bff always sets
        // it from the row, but if a future code path omits it we
        // store null and the read handler treats it as "never
        // expires").
        expiresAt: detail.expiresAt ?? null,
        sourceEventId:
          detail.sequenceNumber ?? (detail as Record<string, unknown>)["sourceEventId"] as string ?? "unknown",
        materializedAt,
      },
    }),
  );
}

async function deleteRead(args: { pasteId: string }): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: args.pasteId },
    }),
  );
}

function log(
  level: "info" | "error",
  message: string,
  extra: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    level,
    service: "pastebin-public-bff",
    fn: "listener",
    message,
    ...extra,
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}
