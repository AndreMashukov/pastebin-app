# pastebin-public-bff

Public read path for the Pastebin service. Anonymous HTTP API (no Cognito authorizer) that resolves a `pasteId` to its content + metadata via a lean DynamoDB view materialized from the bus.

## Endpoints

- `GET /p/{pasteId}` — fetch the raw paste body (content-type echoes what the author set: `text/plain`, `text/html`, etc.). `200` on hit, `404` on missing/never-existed, `410` on deleted/expired, `400` on malformed id, `500` on S3 failure. Sets `Cache-Control: public, max-age=60`.
- `GET /p/{pasteId}/meta` — fetch metadata only (no S3 call). `200` with `{pasteId, contentType, sizeBytes, createdAt, expiresAt, ownerSub}`. Same 404/410 semantics.
- `GET /health` — `{ ok: true, service, ts }`.

## Architecture

```
author-bff DDB stream → trigger → bus PasteCreated / PasteDeleted
                                            ↓
                          pastebin-public-bff EventBridge rule
                          (source: pastebin.author, detail-type: *)
                                            ↓
                                    SQS listener queue
                                            ↓
                                listener lambda (handles both events)
                                INSERT → PutCommand lean row
                                REMOVE  → DeleteCommand lean row
                                            ↓
                          ReadsTable (lean single-table view, pasteId → meta)

client → GET /p/{id} → read handler
                                ↓
              GetItem ReadsTable (pasteId → contentType/ownerSub/...)
                                ↓
              S3 GetObject (cross-stack bucket from author-bff)
                                ↓
                       200 with paste body + headers
```

## Why a lean view (not cross-stack reads on author-bff's PastesTable)

- Public-bff is the read-heavy leg (design §1: ~10:1 read:write).
- A single GetItem on a tight DDB table is sub-millisecond.
- Cross-stack reads would force author-bff's `PastesTable` to scale with public read volume even though author-bff's handlers don't need it.
- This is the same separation `url-shortener-redirect-bff` uses for `MappingCreated` → `RedirectsTable`.

## Cross-stack wiring (read-only, CFN outputs only)

| Input | Source stack | Used for |
|---|---|---|
| `pastebin-event-hub-{stage}-bus` | `pastebin-event-hub` (CFN output `busName`) | EventBridge rule `EventBusName` |
| `pastebin-author-bff-{stage}-content` | `pastebin-author-bff` (CFN output `ContentBucketName`) | S3 GetObject in the read handler |
| `pastebin-author-bff-{stage}-content` ARN | `pastebin-author-bff` (CFN output `ContentBucketArn`) | IAM `s3:GetObject` resource scope |

The public-bff does **not** read from `pastebin-author-bff-{stage}-pastes` directly. CDC on the bus is the integration channel — the listener is the only consumer of `PasteCreated`/`PasteDeleted`.

## Deploy order

1. `pastebin-event-hub` (creates bus)
2. `pastebin-author-bff` (creates PastesTable + ContentBucket + DDB stream + trigger that emits events)
3. `pastebin-public-bff` ← this stack

## Local dev

```bash
yarn typecheck
yarn package:public-bff
yarn deploy:public-bff
```

Default stage: `dev` · Region: `ap-southeast-1`.
