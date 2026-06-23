# Pastebin — Architectural Research

> Companion to `system_design__architecting_a_pastebin_service.md` (the
> generic textbook design school brief).
>
> **Scope:** This research proposes a concrete AWS architecture for the
> pastebin, names the specific templates in `templates/` to fork, lists
> the per-stack resources that will be created, and surfaces the design
> decisions the system-design docs left implicit (random Base62 paste ids,
> S3-primary content storage, GSI2 expiry reaper, database-first CDC
> publish, no Redis at MVP). See §10 for resolved architecture concerns.
>
> **Cost note:** prod at the course reference scale (1 M pastes/day) is
> estimated **~$70–95/month** (§7) — mostly S3 storage, not Lambda.
> Dev/smoke traffic is **< $10/month**. Budget for prod accordingly
> before step 7 in §8.
> The goal is a build plan that drops into
> the existing `templates/` repo and follows the `simple-bff` /
> `url-shortener-app/` patterns we already have working.
>
> **Sibling reference:** `../url-shortener-app/design-research.md` —
> the format of this file mirrors that document one-for-one, since
> pastebin and shortener are sister CQRS apps in the same monorepo.

## 0. Where this fits in the existing repo

The repo already has everything needed for the pastebin without new
template work. The pastebin can be assembled from existing building
blocks:

| Building block                              | Comes from                                    |
| ------------------------------------------- | --------------------------------------------- |
| Service skeleton (Lambda + HTTP API + IAM)  | `templates/template-bff-service/`             |
| EventBridge bus (per subsystem)             | `templates/template-event-hub/`               |
| Single-Table Design DDB table + stream      | `templates/template-bff-service/serverless/dynamodb.yml` |
| Listener + trigger leg (CDC + materialize)  | `templates/template-bff-service/src/{listener,trigger}/` |
| Cognito User Pool + JWT authorizer          | `templates/template-bff-service/serverless/cognito.yml` (see `product-catalog-bff` for the production version) |
| S3 bucket + IAM statements                  | `templates/template-bff-service/serverless/s3.yml` |
| Idempotency, order tolerance, single-table  | _Software Architecture Patterns for Serverless_, Ch. 4–5 |
| Anti-corruption layer at the read edge      | _Book_, Ch. 7 (ESG pattern)                   |
| Working examples to compare against         | `simple-bff/` and `url-shortener-app/` (the production forks) |

> The system-design doc sketches a KGS, a Redis cache, and a CDN as
> separate components. The book explicitly rejects that model: each
> service has its own data store, and **the data store _is_ the cache**
> (Ch. 1, p. 2069, "CPCQ" flow). A pastebin on this template set reads
> lean replicated views from DDB; it does not need Redis. See §3 below
> for the full rationale.

## 1. The right primitive: a BFF per access pattern, not a monolith

The system-design doc draws the pastebin as a single three-tier app
(client → load balancer → app server → KGS / DB / S3). The book
argues for the opposite: **one concern per service**, with each
service owning its own data store, its own listener (if it caches
upstream events), and its own trigger (if it publishes events of its
own) (book, Ch. 1, p. 2717).

A pastebin has three distinct concerns, not one:

1. **Authoring** (creating pastes) — write-heavy, user-driven,
   JWT-protected. Cognito identity required.
2. **Public read** (fetching a paste by ID) — read-heavy,
   machine-driven, latency-critical. Must be anonymous.
3. **Reaping** (deleting expired pastes from DDB and S3) —
   scheduled, low-frequency, no HTTP API. **Separate
   `pastebin-reaper` stack** — cross-stack delete access to
   author-bff's pastes table + S3 only (§4).

Authoring owns the source data; public read owns a lean view;
reaper is a scheduled worker, not a BFF. **Four deployable stacks**
plus the event hub.

### Proposed service decomposition

```
pastebin-app/
├── pastebin-event-hub/                 # EventBridge bus, archive, DLQ
│   # forked from templates/template-event-hub/
│
├── pastebin-author-bff/                # Authoring API (POST /pastes)
│   # forked from templates/template-bff-service/
│   # sync API: POST /pastes, GET /me/pastes, GET /health
│   # data: pastes table (single-table, DDB stream enabled) + S3 bucket
│   # command: createPaste → S3 PutObject + PutItem metadata
│   # publish: author-trigger (CDC) → paste.created, paste.deleted
│
├── pastebin-public-bff/                # Public read API (GET /p/{id})
│   # sync API: GET /p/{id}, GET /health
│   # data: paste view table (metadata only, listener-write)
│   # consume: public-listener ← paste.created, paste.deleted
│   # read: GetItem view → S3 GetObject for body
│
└── pastebin-reaper/                    # Scheduled expiry (no HTTP)
    # forked from templates/template-bff-service/ (functions only)
    # scheduled: reaper (GSI2 Query, every 15 min)
    # cross-stack: Query/DeleteItem on author pastes table + S3 DeleteObject
    # side-effect: DDB REMOVE → author-trigger → PasteDeleted → public-listener
```

Both BFFs share the same `event-hub`. public-bff has its own DDB
table and materializes only from bus events (inbound bulkhead).
author-bff owns the pastes table and S3 bucket. **reaper** is the
only stack with cross-service table access — a deliberate exception
for a scheduled control worker (§4, §10 §5).

**Naming follows the existing convention** from `simple-bff` and
`url-shortener-app`:
`${self:service}-${self:provider.stage}-<suffix>` (e.g.
`pastebin-author-bff-dev-pastes`,
`pastebin-public-bff-dev-views`).

## 2. Event topology

### Domain events

| Event             | Source                       | Detail                                                                                  | Consumed by         |
| ----------------- | ---------------------------- | --------------------------------------------------------------------------------------- | ------------------- |
| `paste.created`   | `pastebin.author`            | `{ pasteId, ownerSub, createdAt, expiresAt, contentType, sizeBytes, s3Key }`   | public-bff          |
| `paste.deleted`   | `pastebin.author`            | `{ pasteId, deletedAt, reason: "expired" \| "user" }`                                   | public-bff          |

> Source naming follows the trigger convention from `simple-bff`:
> `<service>.<entity>` (e.g. `pastebin.author`). Reaper does not
> emit bus events — `PasteDeleted` is published by **author-trigger**
> on DDB stream REMOVE after reaper deletes a row.
> The `ListenerRule` in `pastebin-public-bff` uses
> `source: [{"prefix": "pastebin."}]` plus
> `detail-type: ["paste.*"]` to scope consumption. The
> `anything-but: ["<self>"]` anti-feedback guard from `simple-bff`
> applies to every BFF.

### Event shape (aligned with `aws-lambda-stream`)

```jsonc
// Following the template's conventions in
// url-shortener-app/url-shortener-app-bff/src/models/mapping.js
{
  "id": "<uuidv4>",                  // unique per event
  "type": "paste-created",            // dash-separated, not dot-separated
  "detail-type": "PasteCreated",      // EventBridge detail-type
  "source": "pastebin.author",
  "time": "2026-06-22T10:00:00.000Z",
  "account": "123456789012",
  "region": "ap-southeast-1",
  "resources": [],
  "detail": {
    "pk": "PASTE#<pasteId>",
    "sk": "META",
    "pasteId": "a1B2c3d4",
    "ownerSub": "<cognito-sub>",
    "createdAt": "2026-06-22T10:00:00.000Z",
    "expiresAt": "2026-07-22T10:00:00.000Z",   // optional
    "contentType": "text/plain",
    "sizeBytes": 8421,
    "s3Key": "pastes/a1B2c3d4",
    "version": 1
  }
}
```

The wrapper shape is the EventBridge envelope; the `detail` object is
the systemwide event-sourced fact (book, Ch. 4, p. 675, "Systemwide
Event Sourcing"). Every event has a unique `id` so the listener can
idempotently absorb duplicates — SQS gives at-least-once, and the book
explicitly rejects exactly-once in favor of idempotency (p. 2141,
"Idempotence and ordered tolerance").

## 3. No Redis, no separate KGS, no CDN at MVP

The system-design doc specifies three components we deliberately
**do not** build in v1:

### No standalone Key Generation Service

The reference doc draws a standalone KGS with its own DB, in-memory
cache, and refill loop that pre-generates Base62 strings. On this
template set that is a second stack plus sync coupling on every write
(`createPaste` → wait for a key). We do not build it.

**Replacement:** **48-bit random → Base62 (+ 2-char checksum)** in
`createPaste` — shares `checksum2` with
`url-shortener-app/url-shortener-app-bff/src/lib/code.ts`, but **does
not** use ULID for the payload (see §10 §1).

- `crypto.randomBytes(6)` → 48 bits of entropy → 6 Base62 data chars +
  2-char checksum → 8 chars total (e.g. `a1B2c3d4`). 62⁸ ≈ 218 T
  combinations; no timestamp in the id, no same-ms collision clumping.
- **Non-guessable** (course NFR): not sequential; no creation time in URL.
- Uniqueness: `PutItem` with
  `ConditionExpression: attribute_not_exists(pk) AND attribute_not_exists(sk)`.
  Retry with fresh random bytes on collision (up to 5 attempts).
- **No custom aliases at MVP** — paste ids are always system-generated.
  The course brief lists custom aliases as optional; we omit them to
  keep ids non-guessable and avoid alias squatting / reserved-word
  policy. Reject unknown body fields (`alias`, `custom_alias`) with 400.

A serverless **embedded key pool** (scheduled refill Lambda + claim
via `TransactWrite`) remains an option if write volume ever demands
sub-ms id allocation; at ~12 writes/sec it is unnecessary.

### Paste id generation (handler sketch)

```ts
// pastebin-author-bff/src/lib/pasteId.ts
// checksum2 ported verbatim from url-shortener src/lib/code.ts;
// payload uses crypto.randomBytes — NOT decodeUlid(ulid()) (§10 §1–2).

import { randomBytes } from "node:crypto";

export const generatePasteId = (): string => {
  const payload = randomBytesToBase62(randomBytes(6), 6);
  return payload + checksum2(payload);
};

// public-bff: isValidChecksum(pasteId) before GetItem — cheap typo 404

export const createPaste = async (req, res) => {
  const { content, expiresAt } = req.body;
  if ("alias" in (req.body ?? {}) || "custom_alias" in (req.body ?? {})) {
    return err(400, "bad_request", "custom aliases are not supported");
  }

  let pasteId = "";
  for (let i = 0; i < 5; i++) {
    const candidate = generatePasteId();
    try {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { pk: `PASTE#${candidate}`, sk: "META", /* ... */ },
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }));
      pasteId = candidate;
      break;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) continue;
      throw e;
    }
  }
  if (!pasteId) return err(503, "unavailable", "could not allocate paste id");

  // PutObject s3://…/pastes/<pasteId> then PutItem metadata (§10 §4)
  // No PutEvents — author-trigger publishes PasteCreated via CDC.
  return res.status(201).json({ pasteId, url: `https://${DOMAIN}/p/${pasteId}`, ... });
};
```

### No Redis cache

The reference doc specifies Redis for read-heavy traffic. **For an
AWS-native pastebin on this template set, Redis adds a second failure
mode and a second billing line for marginal gain.** The book is
explicit (p. 857, "Live cache") that the inbound bulkhead **is** the
cache: the public read service maintains a lean replicated view of
the pastes table in its own DDB, and the read path is one `GetItem`.

**Latency budget for `GET /p/{id}`:**

- DDB `GetItem` on a hot partition: p99 ~5–10 ms
- Lambda cold start: ~200 ms (irrelevant; warm container p99 ~1 ms)
- HTTP API + Lambda: 1–2 ms of API Gateway overhead

Total warm: **~10–15 ms** for view metadata `GetItem`, **+30–50 ms**
for S3 `GetObject` (v1 always reads content from S3 — §10 §4). Still
within the course "low latency" target for a 10 KB average paste.
Redis would shave single-digit ms at most, at the cost of another service
to operate.

**When Redis _would_ be the right answer:**

- Read volume exceeds DDB on-demand capacity on the **metadata** table
- S3 GET p99 exceeds budget and CloudFront/DAX hasn't helped
- The team is willing to operate ElastiCache failover, shard
  rebalancing, and cross-AZ replication

None of those apply at MVP. **Recommendation: skip the cache tier
entirely. If/when the read p99 budget is exceeded, add DAX in front
of the public view DDB table as a transparent read-through cache.**
DAX is the AWS-native answer to "Redis in front of DDB" and requires
no application changes.

### No CDN at MVP

The reference doc specifies a CDN for viral pastes. CloudFront is
the right answer *if* a paste goes viral — but it is not worth
operating the distribution config + cache invalidation logic until
we have a paste that genuinely exceeds what DDB + S3 can serve.
**Recommendation: add CloudFront in front of the public HTTP API
on demand, keyed by path, with a `Cache-Control: max-age=300` on
the response.** Do not pre-build it.

## 4. The full architecture

```
  EDGE LAYER                                  APPLICATION LAYER                              DATA + EVENT LAYER
  ──────────                                  ────────────────                              ──────────────────

 ┌──────────────┐       POST /pastes      ┌─────────────────────────┐     PutItem       ┌──────────────────────────┐
 │              │  ─────────────────────▶ │  pastebin-author-bff    │ ───────────────▶ │ DDB pastes table          │
 │   (future:   │   GET /me/pastes       │  (write path)           │                  │ pk=PASTE#<pasteId>        │
 │   CloudFront │  ─────────────────────▶ │                         │     stream       │ sk=META                   │
 │   + Route 53 │   GET /health (public) │  4 Lambdas:             │ ───────────────▶ │ GSI2: EXPIRE→expiresAt   │
 │   + WAF)     │  ─────────────────────▶ │   createPaste  (JWT)    │                  └───────────┬──────────────┘
 │              │                         │   listMyPastes (JWT)    │                              │
 │              │                         │   health        (pub)   │                              │
 │              │                         │   author-trigger (CDC)  │                              ▼
 └──────────────┘                         └────────────┬────────────┘                  ┌────────────────────────┐
        ▲                                              │ PutEvents                    │  EventBridge bus        │
        │                                              └─────────────────────────────▶│  (pastebin-event-hub-   │
        │                                                                                │   dev-bus)              │
        │                                                                                │  + Archive (S3)         │
        │                                                                                └─────────┬──────────────┘
        │                                                                                          │
        │      GET /p/{id}                              ┌─────────────────────────┐                │ bus rules
        │     (no auth, public)                  ──────▶│  pastebin-public-bff    │◀── PasteCreated │
        │                                              │  (read path)             │    PasteDeleted │
        │                                              │                         │                ▼
        │                                              │  3 Lambdas:             │      ┌──────────────────────┐
        │                                              │   public        (pub)   │      │ public-listener-      │
        │                                              │   health        (pub)   │      │   queue               │
        │                                              │   public-listener       │      └──────────┬───────────┘
        │                                              │                         │                 │
        │                                              │                         │                 ▼
        │                                              └────────────┬────────────┘      ┌──────────────────────────┐
        │                                                           │ GetItem             │ DDB paste view table     │
        │                                                           │ + S3 GetObject       │ pk=PASTE#<pasteId>       │
        │                                                           ▼                     │ sk=META (metadata only)  │
        │                                              ┌─────────────────────────┐        │ s3_key, expires_at, …    │
        │                                              │ S3 bucket               │◀───────└──────────────────────────┘
        │                                              │ pastebin-content-<stage>│
        │                                              │ pastes/<pasteId>        │
        │                                              └─────────────────────────┘
        │
        │                                           ┌─────────────────────────────────────┐
        └─────── (no HTTP; schedule only) ──────────▶│  pastebin-reaper                    │
                                                     │  1 Lambda (scheduled, every 15 min): │
                                                     │   reaper — Query GSI2, delete DDB+S3 │
                                                     │  (cross-stack IAM on author table)   │
                                                     └─────────────────────────────────────┘

  Cognito User Pool is owned by the pastebin-author-bff stack
  (not shown — referenced by author-bff itself via JWT authorizer)
```

### Why this shape

**4 stacks (event-hub + author-bff + public-bff + reaper), 2 DDB
tables, 1 S3 bucket, 1 bus, 0 Redis, 0 standalone KGS.** author-bff:
4 Lambdas (rest + CDC trigger, no listener). public-bff: 3 Lambdas.
reaper: 1 scheduled Lambda, no HTTP, no bus. public-bff owns its view
table; author-bff owns pastes + S3 (inbound bulkhead on the read path).

**Each BFF exposes its own HTTP API** — there is no shared gateway.
This is the deliberate anti-monolith choice (§1). author-bff's API
is Cognito-protected for the write path; public-bff's API is public
(read access must be anonymous for shared links to work).

**The bus is the only integration point between BFFs.** author-bff
follows the book's **database-first** variant (Ch. 4–5): the
`createPaste` handler writes metadata to its pastes table and **always**
stores body text in S3; the **author-trigger** Lambda consumes the DDB
stream (CDC) and publishes `PasteCreated` to the bus. public-bff's
**public-listener** materializes a metadata-only lean view.
**pastebin-reaper** (separate stack) queries **GSI2** every 15 min,
deletes expired S3 objects + DDB rows; author-trigger publishes
`PasteDeleted` from the stream REMOVE → public-listener (§10 §3–5).

**Integration rule:** BFFs talk only through the bus. Reaper is the
sole exception — it needs delete IAM on author-bff's table and bucket,
not event consumption.

**`author-bff` has a trigger leg and DDB stream, but no listener.**
The handler never calls `PutEvents` — publish is CDC-only. §6
explains why author-bff has no listener (nothing in this stack
consumes its own events).

**Cognito is in the author-bff stack** because that's where the
user identity is created (sign-up / sign-in / hosted UI).
`pastebin-public-bff` references the UserPoolId / ClientId via CFN
outputs only if it ever needs to surface owner info; v1 does not.

### Content storage (v1: S3-primary, textbook-aligned)

**v1:** all paste bodies live in S3; both DDB tables hold **metadata
only** (`s3_key`, `size_bytes`, `content_type`, etc.). Read path:
`GetItem` view row → `GetObject` from S3 (~40–60 ms warm p99 for 10 KB).

Why not inline in DDB at MVP: at 1 M pastes/day × 10 KB, duplicating
content into the view table roughly **doubles** DDB write bytes vs
metadata+S3 (§10 §4). The latency win of one-hop reads is real but
not needed until metrics say S3 p99 is too slow.

**v2 (optional):** inline pastes ≤ 64 KB into `PasteViewTable` when
read p99 or cost models justify it; keep S3 as source of truth on
author-bff regardless.

| Paste body | v1 storage | v1 read path |
| --- | --- | --- |
| any size ≤ 10 MB | S3 `pastes/<pasteId>` + metadata in both tables | DDB GetItem → S3 GetObject |
| (v2) ≤ 64 KB | optional copy in `content_inline` on view row | GetItem only if inlined flag set |

### Per-stack resources (what `sls deploy` creates)

#### `pastebin-event-hub` (forked from `template-event-hub`)
- `AWS::Events::EventBus` named `pastebin-event-hub-<stage>-bus`
- `AWS::Events::Archive` (everything-but-fault) → S3
- Optional Kinesis ingress for cross-account / cross-region
  (commented out in the template by default — leave it that way for
  single-region, single-account MVP)
- Outputs: `busName`, `busArn`

#### `pastebin-author-bff` (forked from `template-bff-service`)
- `AWS::DynamoDB::Table` `pastebin-author-bff-<stage>-pastes`
  - `pk` (S, HASH) = `PASTE#<pasteId>`, `sk` (S, RANGE) = `META`
  - GSI1: `ownerSub` (HASH) + `gsisk` (RANGE) — for `GET /me/pastes`
  - GSI2: `gsi2pk` (HASH) = `EXPIRE`, `gsi2sk` (RANGE) = `<expiresAt>#<pasteId>`
    — sparse: only rows with `expires_at` set; reaper queries
    `gsi2sk < :now` (§10 §3)
  - **Stream enabled** (`NEW_AND_OLD_IMAGES`) — feeds `author-trigger`
  - TTL on `expires_at` — eventually-consistent metadata cleanup
- `AWS::S3::Bucket` `pastebin-author-bff-<stage>-content` (forked
  from `s3.yml`) — **all** paste bodies; lifecycle rule aligned with
  `expires_at`
- Lambdas (4, shared IAM role):
  - `createPaste` — `POST /pastes` (Cognito JWT); S3 PutObject then
    PutItem metadata; `generatePasteId()` (random Base62 + checksum)
  - `listMyPastes` — `GET /me/pastes` (Cognito JWT)
  - `health` — `GET /health` (public, no authorizer)
  - `author-trigger` — DDB stream consumer; maps INSERT/MODIFY/REMOVE
    to `PasteCreated` / `PasteDeleted` and `PutEvents` to the bus
    (book Ch. 5, "Database-first event sourcing") — see
    `src/trigger.ts`
- HTTP API with explicit per-route method+path declarations
  (no `/{proxy+}` catch-all; see url-shortener PR #2 fix)
- Cognito User Pool + App Client + Hosted UI domain
- IAM: `events:PutEvents` on the bus (trigger only — not rest),
  `s3:PutObject` on content bucket (createPaste)
- **Outputs** (CloudFormation `${cf:...}` — same as url-shortener-app;
  no SSM at MVP; see §10 §8):
  | Output | Imported by |
  | --- | --- |
  | `PastesTableName` | reaper (`TABLE_NAME` env) |
  | `PastesTableArn` | reaper (IAM) |
  | `ContentBucketName` | public-bff, reaper (`BUCKET` env) |
  | `ContentBucketArn` | public-bff, reaper (IAM) |

> Why no `listener` SQS / bus rule on author-bff: nothing in this
> stack consumes its own events. See §6.

#### `pastebin-public-bff`
- `AWS::DynamoDB::Table` `pastebin-public-bff-<stage>-views`
  - `pk` (S, HASH) = `PASTE#<pasteId>` — single row per paste
  - `sk` (S, RANGE) = `META`
  - Lean view: `{ pk, sk, pasteId, contentType, expiresAt, s3Key,
    sizeBytes, materializedAt, sourceEventId }` — **no body inline**
  - GSI1 not needed — read path is `GetItem` then S3
  - **No stream** — listener is the only write path into this table
- `AWS::S3::Bucket` reference (cross-stack, from author-bff outputs)
  — read-only IAM (`s3:GetObject`) for all reads
- Lambdas (3, shared IAM role):
  - `public` (HTTP API) — `GET /p/{id}`; **public**; validates
    checksum on 8-char ids; 404 if expired; GetItem view → S3 GetObject;
    `Cache-Control: public, max-age=60` on success
  - `health` (HTTP API) — `GET /health` (public)
  - `public-listener` (SQS worker) — consumes `PasteCreated` and
    `PasteDeleted` from the bus; upserts the lean row via idempotent
    `PutCommand` (`ConditionExpression: attribute_not_exists(pk)` so
    re-deliveries are no-ops); reports batch failures so a single
    bad message does not poison the batch
- HTTP API (regional, public)
- EventBridge rule → SQS → `public-listener` ESM with
  `ReportBatchItemFailures` on
- IAM role with `dynamodb:GetItem` + `dynamodb:PutItem` on the views
  table, `s3:GetObject` on the content bucket, `sqs:ReceiveMessage`/
  `DeleteMessage`/`GetQueueAttributes` on the listener queue,
  `sqs:SendMessage` on the DLQ (from SF-generated redrive policy)

#### `pastebin-reaper` (forked from `template-bff-service`, functions only)
- No DDB table, no HTTP API, no EventBridge bus subscription
- One Lambda:
  - `reaper` — EventBridge schedule `rate(15 minutes)`; paginated
    **Query on GSI2** of author-bff's pastes table
    (`gsi2pk=EXPIRE`, `gsi2sk < now`); per row: **S3 DeleteObject
    first**, then DDB DeleteItem (§10 §7). Stream REMOVE →
    author-trigger → `PasteDeleted` → public-listener.
- Cross-stack imports — `${cf:pastebin-author-bff-${opt:stage}.PastesTableArn}`
  etc. (§10 §8); wired in `serverless/config.yml` like
  `url-shortener-redirect-bff`
- IAM: `dynamodb:Query` on pastes table + GSI2, `dynamodb:DeleteItem`
  on pastes table, `s3:DeleteObject` on content bucket — **no
  UpdateItem** at MVP (§10 §7)
- Observability: CloudWatch alarms on Lambda `Errors` and `Duration`
  (§10 §9) — not an SQS DLQ on the schedule path
- Why separate: reaper deploy cadence and failure domain must not
  touch the JWT write path; room for EventBridge invocation DLQ and
  metrics without coupling to author-bff releases

### Stack deployment order

```
1. pastebin-event-hub                  (no dependencies)
2. pastebin-author-bff                 (depends on busName; exports table + bucket)
3. pastebin-public-bff                 (depends on busName + bucket outputs)
4. pastebin-reaper                     (depends on pastesTableArn + contentBucketArn)
```

Cross-stack references use `${cf:pastebin-event-hub-${opt:stage}.busName}`
and `${cf:pastebin-author-bff-${opt:stage}.PastesTableArn}` exactly
the way `url-shortener-redirect-bff` imports from `url-shortener-app-bff`
(see §10 §8). No SSM Parameter Store at MVP.

## 5. Idempotency, expiry, and the reaper loop

The textbook design assumes pastes are immortal unless explicitly
deleted. The reality of a public pastebin is that pastes expire —
either by user request (TTL set at create time) or by the system
(no TTL = default expiry, configurable per stage).

### Two layers of expiry

1. **DynamoDB TTL** on `expires_at` — eventually-consistent (within
   48 hours), free, idempotent. Removes metadata but cannot touch S3.
2. **Scheduled reaper** (`pastebin-reaper` stack) — every 15 minutes,
   **Query GSI2** on author-bff's pastes table (`gsi2pk=EXPIRE`,
   `gsi2sk < now`); deletes S3 + DDB row. Never a full-table Scan (§10 §3).

Why both: TTL alone leaves orphan S3 objects forever. The reaper
alone misses the case where the user expected silent cleanup without
our Lambda scanning for it. Together: TTL gives free, idempotent
metadata cleanup within AWS's SLO; the reaper guarantees S3 cleanup
within 15 minutes and keeps the public view consistent.

### Idempotency

- `author-trigger` (CDC): each DDB stream record has a unique
  `SequenceNumber`; we put it on the event as `id`; the
  `public-listener` ignores events whose `id` matches a row's
  `sourceEventId` attribute.
- `public-listener` writes: `PutCommand` with
  `ConditionExpression: attribute_not_exists(pk)` so re-deliveries
  from SQS are no-ops. For `PasteDeleted`, `DeleteCommand` is
  idempotent by definition.
- `reaper`: idempotent because DDB `DeleteItem` is idempotent and
  S3 `DeleteObject` returns success for non-existent keys.

### Reaper failure modes

| Symptom | Cause | Recovery |
| :--- | :--- | :--- |
| Reaper times out | Too many expired rows in one 15 min window | Paginate GSI2 Query; raise `memorySize`; shrink schedule interval |
| S3 delete fails (DDB row kept) | Transient S3 error | In-invocation retry (3× backoff); row stays in GSI2 → retried next schedule. Orphan S3 N/A — DDB not deleted yet |
| DDB delete fails (S3 already gone) | Transient DDB throttle | In-invocation retry; row remains expired in GSI2 → next pass. S3 lifecycle rule is backstop for any stray object |
| Stream REMOVE → public-listener lag | Normal eventual consistency | Stale view ≤ SQS visibility; client retry |

## 6. Why author-bff has no listener

Same rule as `url-shortener-app` (see
`../url-shortener-app/design-research.md` §13): **database-first CDC
on the write path** — the handler does `PutItem` (+ optional S3);
**author-trigger** publishes `PasteCreated` / `PasteDeleted` from the
DDB stream. The handler never calls `PutEvents`.

author-bff has **no listener** because nothing in this stack consumes
its own bus events. **public-bff's public-listener** materializes the
lean view. If we add analytics or search later, they subscribe from the
bus — not from the handler.

**Do not** combine handler `PutEvents` with CDC trigger (duplicate
events). **Do not** add an app-listener that discards events locally.

## 7. Operational notes

### Per-stage configuration

Inherits from url-shortener-app:
- `dev`: pastes table wiped between deploys (acceptable); log retention
  3 days; no CloudFront.
- `prod`: `DeletionPolicy: Retain` on pastes table and content bucket;
  log retention 30 days; CloudFront added when traffic warrants.

### Cost posture (1 M pastes/day, 10 KB average, 10:1 read/write)

Assumes **S3-primary** (metadata-only DDB rows, no content inlining).

| Service                       | Monthly cost (rough, ap-southeast-1) |
| ----------------------------- | ------------------------------------ |
| Lambda (author write path)    | < $5                                 |
| Lambda (reaper, ~3k inv/mo)   | < $1                                 |
| Lambda (read path, 115 rps)   | < $20                                |
| DynamoDB (metadata only, 2 tables) | ~$15–25 on-demand (WCU for ~1 M × ~1 KB metadata writes/day + reads) |
| S3 (10 GB/day ingest, IA lifecycle) | ~$25–40 storage + requests         |
| EventBridge                   | < $1                                 |
| Cognito (MAU < 50 K)          | free                                 |
| **Total**                     | **~$70–95/month prod at reference scale** |

**Prod cost context:** this is the course **reference** load (1 M
pastes/day, 10 GB/day S3 growth) — not typical dev/smoke traffic.
~60–70 % of prod estimate is **S3 storage + requests**; DDB metadata
and Lambda are the rest. Deliberately higher than the old ~$30 figure
(which assumed DDB-inlined bodies). **Dev stays < $10/month.** Flag
this before prod cutover (§8 step 7), not at first deploy.

Compare to a Redis cache: ElastiCache t4g.small is ~$25/month just
to have it running, before data transfer. The "no Redis" choice pays
for the entire bus + Lambda layer.

### Known gaps to track

- **Quota enforcement:** the design doc doesn't say how to cap paste
  size. We enforce `size_bytes <= 10 MB` (S3 hard limit) at the
  handler; for v1 there is no per-user quota.
- **Abuse / spam:** HTTP API **stage throttle** (e.g. 50 req/s burst,
  10 req/s steady on `POST /pastes`) ships with author-bff deploy —
  before smoke test (§10 §6). Per-user paste quota (e.g. 100/hour via
  a `USAGE#<sub>` counter row) is **post-smoke, pre-prod** if needed.
- **Custom aliases:** explicitly out of scope. Only `generatePasteId()`
  ids; return 400 if the client sends `alias` / `custom_alias`.
- **Custom domain:** the public BFF's HTTP API will eventually get a
  custom domain (`paste.<our-domain>`) via API Gateway domain
  mappings. v1 uses the auto-generated `*.execute-api.<region>.amazonaws.com`
  URL; not user-facing.
- **CloudFront:** add when read p99 exceeds ~50 ms sustained or a
  paste genuinely goes viral. Until then, no distribution.

## 8. Build order

1. Fork `template-event-hub` → `pastebin-event-hub`, deploy.
2. Fork `template-bff-service` → `pastebin-author-bff`, wire to the
   bus, pastes table (GSI1 + GSI2) + content bucket + `pasteId.ts`,
   HTTP API throttle on `POST /pastes`, deploy.
3. Fork `template-bff-service` → `pastebin-public-bff`, wire to the
   bus + content bucket, add views table, deploy.
4. Fork `template-bff-service` → `pastebin-reaper`, wire to pastes
   table + content bucket ARNs from author-bff outputs, deploy.
5. Smoke test: deploy to `dev`, exercise POST /pastes, GET /p/{id},
   expiry (reaper), reject custom alias with 400.
6. L4 verification (browser): confirm Hosted UI redirect works, public
   read returns expected content.
7. Stage to `prod` after dev is green for one week — **review §7 cost
   estimate** (~$70–95/mo at reference scale) before enabling prod traffic.

## 9. Summary

The textbook pastebin design is a generic three-tier answer. For
this monorepo, the right shape is **four stacks** on one EventBridge
bus (event-hub + author-bff + public-bff + reaper), copying patterns
url-shortener-app already validated: random Base62 paste ids, DDB
metadata + S3 bodies, DDB stream CDC, lean metadata view on the public
read path, GSI2-backed reaper in its own deploy unit.
We drop the standalone KGS and Redis; random id generation and S3-primary
storage keep moving parts minimal at MVP cost.

| Textbook concept | Our equivalent |
|---|---|
| KGS pre-generated Base62 keys | `crypto.randomBytes` → Base62 + checksum |
| Metadata DB | PastesTable + stream CDC; GSI2 for expiry |
| Object storage | S3 for all paste bodies (v1) |
| Redis cache | None at MVP; DAX/CloudFront later if metrics demand |
| CDN | CloudFront when a paste goes viral |

Author and public BFFs integrate **only through the bus**. Reaper
integrates via cross-stack IAM on author-bff's table and bucket — the
one deliberate bulkhead exception for scheduled cleanup.

## 10. Resolved design concerns

Decisions from architecture review (2026-06).

### 1. ULID timestamp leakage — use random payload, not ULID

url-shortener uses `decodeUlid(ulid())` because sortable codes help
`GET /me/urls`. Pastebin ids are not used for ordering; encoding the
ULID timestamp into the first Base62 chars leaks creation time into the
URL and increases same-millisecond collision pressure on a 6-char slice.

**Decision:** `generatePasteId()` draws **48 bits from
`crypto.randomBytes(6)`** and Base62-encodes to 6 data chars. Same
8-char wire format; no timing metadata in the id.

### 2. Checksum — port `checksum2` verbatim from url-shortener

`checksum2` in `code.ts` is a lightweight mod-3844 hash: good for
single-character typos before a DDB/S3 round-trip; weak on adjacent
transpositions. **Decision:** reuse **unchanged** for monorepo
consistency. public-bff calls `isValidChecksum(pasteId)` on
`GET /p/{id}` and returns 404 on mismatch. Stronger schemes (Luhn mod
62, 3 check chars) deferred — not worth an extra URL character at MVP.

### 3. Reaper — GSI2 in v1, Query not Scan

Full-table Scan every 15 min does not scale to years of retention.
**Decision:** sparse **GSI2** on author `pastes` table from day one:
`gsi2pk=EXPIRE`, `gsi2sk=<ISO expiresAt>#<pasteId>` on rows with
`expires_at`. Reaper runs paginated `Query` with
`KeyConditionExpression: gsi2pk = :expire AND gsi2sk < :now`. Write
amplifier is one extra attribute per expiring paste — negligible at
12 writes/sec.

### 4. Content inlining — S3-primary at v1

Inlining up to 400 KB duplicated ~10 GB/day into the view table and
understated DDB cost. **Decision:** **v1 = textbook split** (metadata
in DDB, body in S3). Optional v2: inline ≤ 64 KB into the view when
metrics show S3 latency or cost warrants it.

### 5. Reaper stack placement — separate `pastebin-reaper` from v1

**Decision:** **`pastebin-reaper` is its own stack** — one scheduled
Lambda, no HTTP, no bus. Cross-stack IAM on author-bff's pastes table
(GSI2 Query + DeleteItem) and content bucket (DeleteObject). Reaper
deploys independently of the JWT write path. `PasteDeleted` still
flows through **author-trigger** CDC on stream REMOVE — reaper never
calls `PutEvents`. See §10 §7–§9 for partial-failure and observability.

### 6. Rate limits — stage throttle before smoke; per-user after

**Decision:** configure HTTP API route throttling on `POST /pastes`
in step 2 (author-bff deploy), before §8 smoke test. Per-user quotas
(`USAGE#<ownerSub>` counter or authorizer-side check) are **post-smoke,
pre-prod** — not blocking first end-to-end loop.

### 7. Reaper partial S3 failure — no UpdateItem at MVP

**Decision:** **drop `pending_s3_cleanup` and `UpdateItem` IAM.** Reaper
deletes **S3 first, then DDB**. If S3 fails, the DDB row remains and
GSI2 picks it up on the next 15 min pass (plus 3 in-invocation retries).
If DDB fails after S3 succeeded, same — retry next pass; S3 lifecycle
rule on the content bucket is the orphan-object backstop. No row
mutation needed.

### 8. Cross-stack wiring — CFN outputs only (like url-shortener)

**Decision:** all cross-stack refs via **`${cf:pastebin-author-bff-${opt:stage}.…}`**
in each consumer's `serverless/config.yml` — same pattern as
`url-shortener-redirect-bff` importing `MappingsTableName` from
app-bff. **No SSM Parameter Store at MVP.** A future analytics-bff
adds a new stack that imports the same CFN outputs (or subscribes to
the bus only). Export names: `PastesTableName`, `PastesTableArn`,
`ContentBucketName`, `ContentBucketArn`.

### 9. Reaper observability — CloudWatch alarms, not an SQS DLQ

Scheduled EventBridge → Lambda is not an SQS consumer; there is no
listener DLQ. **Decision for v1:** CloudWatch alarms on reaper Lambda
`Errors > 0` and `Duration` approaching timeout; optional **EventBridge
rule target DLQ** (SQS) for **failed async invocations** in v2 if we
need to capture poison schedules — not the same as public-listener's
message DLQ.