# pastebin-author-bff

Authoring API for the pastebin system.

**Routes (HTTP API, Cognito JWT on `/pastes` and `/me/pastes`):**

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/pastes` | JWT | Create a new paste (S3 PutObject + DDB PutItem) |
| `GET`  | `/me/pastes` | JWT | List caller's pastes via GSI1 |
| `GET`  | `/health` | public | Health check |

**Trigger (DDB stream):** `PasteCreated` (INSERT) and `PasteDeleted` (REMOVE) emitted to the shared bus. The handler never calls `PutEvents` directly — the trigger is the sole producer. See `src/trigger.ts` and `../design-research.md` §6.

**Data model:** single-table DDB. See `../design-research.md` §4 and `serverless/dynamodb.yml`.

| Concern | Implementation |
|---------|----------------|
| Key generation | `src/lib/pasteId.ts` — `crypto.randomBytes(6)` → Base62 + 2-char `checksum2` (ported from `url-shortener-app-bff/src/lib/code.ts`) |
| Custom aliases | **Rejected with 400** — design §3 |
| Content storage | S3 `pastes/<pasteId>`, body in `src/rest/handlers.ts` (`PutObject`) |
| Expiry | GSI2 sparse (`gsi2pk=EXPIRE`, `gsi2sk=<expiresAt>#<pasteId>`) + DDB TTL on `expires_at`; actual delete + S3 cleanup is the `pastebin-reaper` stack |

**Cross-stack imports (CFN outputs only, no SSM — §10 §8):**

| Consumes | From |
|----------|------|
| `busName`, `busArn` | `pastebin-event-hub-${opt:stage}` |

**Cross-stack exports:**

| Output | Consumed by |
|--------|-------------|
| `PastesTableName` | reaper (`TABLE_NAME` env) |
| `PastesTableArn` | reaper (IAM) |
| `ContentBucketName` | public-bff, reaper (`BUCKET` env) |
| `ContentBucketArn` | public-bff, reaper (IAM) |
| `UserPoolId` | (future BFFs needing owner info) |
| `UserPoolClientId` | (future BFFs) |
| `ApiEndpoint` | smoke tests |

**Deploy order:** `pastebin-event-hub` first, then this stack.

```bash
# From pastebin-app/ root:
npx nx run pastebin-author-bff:package   # synth
npx nx run pastebin-author-bff:deploy    # deploy to AWS
```
