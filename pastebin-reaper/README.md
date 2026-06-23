# pastebin-reaper

Scheduled reaper for expired pastes. Cross-stack cleanup of:
- **DDB** PastesTable (author-bff) — DeleteItem on the META row, which fires a REMOVE event in the DDB stream → author-bff's existing trigger publishes PasteDeleted on the bus → public-bff's listener cleans up its lean ReadsTable transitively.
- **S3** content bucket (author-bff) — DeleteObject on the body key.

No API surface, no bus publish — invariant: **DDB stream is the sole event producer** for paste changes.

## Why this design

- **GSI2 query**: PastesTable's GSI2 is sparse KEYS_ONLY, keyed on `gsi2pk = "EXPIRE"` + `gsi2sk = "<expiresAt>#<pasteId>"`. One Query per cycle: `gsi2pk = "EXPIRE" AND gsi2sk < :now`, paginated. Sub-millisecond on small result sets, scales with expired-paste count.
- **No bus publish from reaper**: the DDB REMOVE event naturally flows through author-bff's existing CDC trigger. Reaper only deletes state; it never publishes events. This keeps the producer-of-truth invariant intact.
- **S3 failures are non-fatal**: S3 keys that can't be deleted don't block DDB cleanup. The next sweep retries the S3 delete (idempotent). A future S3 lifecycle rule can also backstop.
- **Idempotency**: DeleteObject and DeleteItem are both idempotent. Re-running a cycle is safe; a partially-deleted paste simply gets re-queried and the remaining action completes.

## Schedule

`rate(5 minutes)` via EventBridge rule → Lambda. Lambda timeout 15 min is the de-facto upper bound on items processed per cycle (in practice << 5 min for any realistic workload). DDB TTL on `expires_at` is a secondary backstop — it does the metadata row at 48 hr past expiry, but the reaper is what deletes the body and removes the row promptly.

## Deploy order

1) `pastebin-event-hub`
2) `pastebin-author-bff`
3) `pastebin-public-bff`
4) `pastebin-reaper` (this stack) — depends on cross-stack outputs from author-bff (`PastesTableName`, `PastesTableArn`, `ContentBucketName`, `ContentBucketArn`).

## Stack

- 1 Lambda (the reaper itself)
- 1 EventBridge rule (schedule)
- 1 IAM role (cross-stack DDB + S3 perms)
- 0 HTTP API routes
- 0 authorizers
- 0 bus subscriptions
