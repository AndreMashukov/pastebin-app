# How the serverless yml files fit together in `pastebin-app`

A working note for anyone editing the four Serverless Framework v4 stacks in
this repo. The stacks ship as a tree of YAML files under each
`pastebin-<role>/serverless/`, glued together by `${file(...)}` references.
This doc explains the pattern, the file-naming convention, and the
ordering rules that make the four stacks deploy in the right order with
the right IAM.

Sibling to `design-research.md` (architecture) and
`system_design__architecting_a_pastebin_service.md` (textbook brief).
The convention is inherited from
[`../url-shortener-app/`](../url-shortener-app/), which is the reference
repo for this template set.

## 1. One stack, many yml files

Each stack has one **root** file (`serverless.yml`) and a tree of
**fragment** files under `serverless/`:

```
pastebin-reaper/
  serverless.yml              ← root (provider, functions, package)
  serverless/
    config.yml                ← params + custom.* + environments
    iam.yml                   ← aggregator for IAM statements
    dynamodb.yml              ← one iamRoleStatement (GSI2 Query)
    dynamodb-delete.yml       ← one iamRoleStatement (DeleteItem)
    s3.yml                    ← one iamRoleStatement (S3 DeleteObject)
    resources.yml             ← CFN resources / Outputs (often a no-op)
    tags.yml                  ← CFN stack tags
```

The root file pulls the fragments in with Serverless v4's
`${file(<path>):<key>}` syntax. For example, the reaper root reads:

```yaml
# pastebin-reaper/serverless.yml
provider:
  environment: ${file(serverless/config.yml):environment}
  iam:
    role: ${file(serverless/iam.yml):role}
resources: ${file(serverless/resources.yml):resources}
```

and `iam.yml` aggregates statements from the per-resource fragments:

```yaml
# pastebin-reaper/serverless/iam.yml
role:
  statements:
    - ${file(serverless/dynamodb.yml):iamRoleStatements}
    - ${file(serverless/dynamodb-delete.yml):iamRoleStatements}
    - ${file(serverless/s3.yml):iamRoleStatements}
```

`${file(...):iamRoleStatements}` resolves to the top-level
`iamRoleStatements:` key in the named file. Serverless merges the
results into `provider.iam.role.statements`. The end CFN template has
one Lambda execution role with one statement per fragment.

This is the **only** way to structure IAM. A list of statements under
`iamRoleStatements:` in a single file is rejected at synthesize time
with *"iamRoleStatements must be object"*. One statement per file is
the contract.

## 2. The "one concern per file" convention

The fragment filename is the resource the file is about:

| File                 | Owns                                                            |
|----------------------|-----------------------------------------------------------------|
| `config.yml`         | `params:`, `custom:`, every `*Environment:` map                 |
| `tags.yml`           | CFN stack tags (`service`, `env`, `subsys`, `role`)             |
| `iam.yml`            | Aggregator — imports per-resource `iamRoleStatements`           |
| `dynamodb.yml`       | One IAM statement for DDB read (Query / GetItem)                |
| `dynamodb-delete.yml`| One IAM statement for DDB write (DeleteItem / PutItem)          |
| `s3.yml`             | One IAM statement for S3, plus the bucket resource + lifecycle  |
| `bus.yml`            | One IAM statement for `events:PutEvents` (and the bus resource) |
| `archive.yml`        | The `AWS::Events::Archive` resource                             |
| `listener.yml`       | One IAM statement for SQS read (listener queue)                 |
| `resources.yml`      | The catch-all for resources + Outputs that don't fit elsewhere  |

Two file-shape rules apply across the repo:

1. **One top-level `iamRoleStatements:` object per IAM fragment.** That
   object has `Effect` / `Action` / `Resource` and contributes exactly
   one CFN statement. If you need two statements, split into two files
   (e.g. `dynamodb.yml` for Query, `dynamodb-delete.yml` for DeleteItem).
2. **`resources.yml` owns CFN resources and Outputs.** Files like
   `s3.yml` and `bus.yml` also define resources, and they are pulled
   in by `serverless.yml`'s `resources:` list (not via `iam.yml`).
   The aggregator and the resource list are two separate trees.

The same file can serve both roles: e.g. author-bff's
`pastebin-author-bff/serverless/s3.yml` defines both the
`AWS::S3::Bucket` resource *and* the IAM statement that grants
`s3:PutObject` to the rest API lambda. The file is included in
`serverless.yml`'s `resources:` list **and** in `iam.yml`'s
`statements:` list.

## 3. The fragment inventory per stack

| File                  | event-hub | author-bff | public-bff | reaper |
|-----------------------|:---------:|:----------:|:----------:|:------:|
| `config.yml`          | ✓         | ✓          | ✓          | ✓      |
| `tags.yml`            | ✓         | ✓          |            |        |
| `iam.yml`             |           | ✓          | ✓          | ✓      |
| `bus.yml`             |           | IAM only   |            |        |
| `archive.yml`         | ✓         |            |            |        |
| `dynamodb.yml`        |           | IAM only   | IAM only   | IAM only |
| `dynamodb-delete.yml` |           |            |            | ✓      |
| `s3.yml`              |           | resource + IAM | IAM only | IAM only |
| `listener.yml`        |           |            | IAM only   |        |
| `resources.yml`       |           | ✓          | ✓          | ✓      |

*"IAM only"* means the file contributes a single `iamRoleStatements`
object and no CFN resource. *resource + IAM* means it defines a CFN
resource (and its Outputs) plus an IAM statement.

Why does event-hub have no `iam.yml`? It owns no compute, so it
needs no Lambda execution role. The bus resource itself is
service-managed; the only IAM that touches it is `events:PutEvents`
in author-bff's `bus.yml` and `events:Describe*` in the
`AWS::Events::Rule` (auto-granted by Serverless).

Why does reaper have no `bus.yml`? It does not publish to the bus.
The bus integration is **transitive** — the reaper's `DeleteItem` on
author-bff's `PastesTable` fires a REMOVE event in the DDB stream;
author-bff's `trigger` lambda reads the CDC record and puts
`PasteDeleted` on the bus; public-bff's `listener` cleans up its
lean `ReadsTable` row. The reaper never calls `PutEvents`. The whole
chain is documented in
`pastebin-reaper/serverless.yml` (header comment) and the design doc
§6, §10 §5.

## 4. Cross-stack wiring — `${cf:...}` with fallback

The four stacks share data via CloudFormation outputs. Consumer
stacks import producer-stack outputs with:

```yaml
busName: ${cf:pastebin-event-hub-${opt:stage}.busName, 'pastebin-event-hub-${opt:stage}-bus'}
```

The second argument after the comma is a **fallback string** that
fires when the upstream stack is not yet deployed. This is what lets
`sls package` (L2) run on a fresh checkout without every other stack
being live. At `sls deploy` (L3) Serverless re-resolves the lookup;
if the upstream stack is missing, deploy fails loudly with a clear
`Cannot resolve ${cf:...}` error.

The `${cf:...}` calls live in `config.yml` under `custom:`, never in
`resources.yml`. The CFN templates reference them through
`${self:custom.busName}` so the substitution happens once, at the
root, and the rest of the template reads a flat string.

This is the **one and only** integration channel for cross-stack
values. No SSM Parameter Store, no `.env` files, no hardcoded ARNs.
The deploy order (event-hub → author-bff → public-bff → reaper) is
derived directly from the dependency graph of `${cf:...}` lookups.

## 5. Worked example: the reaper stack

`pastebin-reaper` is the simplest stack in the repo — one scheduled
function, no HTTP, no SQS, no Cognito. It is a good first read of the
composition pattern.

### 5.1 Root (`serverless.yml`)

```yaml
service: ${self:custom.subsys}-reaper
frameworkVersion: ^4

provider:
  name: aws
  runtime: nodejs20.x
  region: ap-southeast-1
  stage: ${opt:stage, 'dev'}
  endpointType: REGIONAL
  logRetentionInDays: ${opt:logRetentionInDays, 3}
  environment: ${file(serverless/config.yml):environment}
  iam:
    role: ${file(serverless/iam.yml):role}
# (build, package, functions: see full file)

resources: ${file(serverless/resources.yml):resources}
```

Two `${file(...)}` calls in `provider:` and one in `resources:` at
the root. That's the whole composition. `functions:` is inlined
because it has only one entry (the schedule-triggered `reap`
function); a stack with many functions can hoist `functions:` into
`functions.yml` the same way.

### 5.2 `config.yml` — params, custom, environments

```yaml
params:
  stage: { default: dev }
  region: { default: ap-southeast-1 }
  logRetentionInDays: { default: 3 }

custom:
  partition: aws
  subsys: pastebin
  # Cross-stack: author-bff
  pastesTableName:    ${cf:pastebin-author-bff-${opt:stage}.PastesTableName,    '...'}
  pastesTableArn:     ${cf:pastebin-author-bff-${opt:stage}.PastesTableArn,     '...'}
  pastesTableGsi2Arn: "${cf:...PastesTableArn, '...'}/index/gsi2"
  contentBucketName:  ${cf:pastebin-author-bff-${opt:stage}.ContentBucketName,  '...'}
  contentBucketArn:   ${cf:pastebin-author-bff-${opt:stage}.ContentBucketArn,   '...'}

environment: { ... }
reaperEnvironment: { PASTES_TABLE_NAME: ${self:custom.pastesTableName}, ... }
```

Two important things to notice:

- `subsys` is the same value in all four stacks
  (`pastebin`); `role` differs (event-hub, author-bff, public-bff,
  reaper). The service name is `${self:custom.subsys}-${self:custom.role}`
  (event-hub inlines `service:` and the other three read it from
  `custom:`). This is the single source of the `${self:service}`-derived
  resource names.
- `pastesTableGsi2Arn` is constructed locally. Author-bff exports the
  table ARN only; the GSI ARN is the table ARN with `/index/<name>`
  appended, deterministically. The double-quoted outer wrapper keeps
  the `/index/gsi2` suffix as a literal string — without the quotes
  Serverless would try to interpret it as a variable reference.

### 5.3 `iam.yml` — aggregator

```yaml
role:
  statements:
    - ${file(serverless/dynamodb.yml):iamRoleStatements}
    - ${file(serverless/dynamodb-delete.yml):iamRoleStatements}
    - ${file(serverless/s3.yml):iamRoleStatements}
```

Three statements, three files. The order in `statements:` is the
order they end up in the synthesized CFN role — purely cosmetic for
human readers; the CFN engine doesn't care.

### 5.4 IAM fragments — one statement each

`dynamodb.yml` contributes the GSI2 Query permission:

```yaml
iamRoleStatements:
  Effect: Allow
  Action: [dynamodb:Query]
  Resource: ${self:custom.pastesTableGsi2Arn}
```

`dynamodb-delete.yml` contributes the DeleteItem permission:

```yaml
iamRoleStatements:
  Effect: Allow
  Action: [dynamodb:DeleteItem]
  Resource: ${self:custom.pastesTableArn}
```

`s3.yml` contributes the S3 DeleteObject permission, scoped to the
`pastes/*` prefix of the content bucket:

```yaml
iamRoleStatements:
  Effect: Allow
  Action: [s3:DeleteObject]
  Resource:
    - Fn::Join: ['/', [${self:custom.contentBucketArn}, 'pastes/*']]
```

Each file is a single object with `Effect / Action / Resource`. No
arrays of statements. If you need to add an `s3:GetObject` (you
won't — the reaper doesn't read bodies), make a new
`s3-read.yml`, list it in `iam.yml`, leave `s3.yml` alone.

### 5.5 `resources.yml` — usually empty

The reaper's `resources.yml` is a no-op:

```yaml
resources:
  Resources: {}
```

because the EventBridge schedule rule, the Lambda invoke permission,
and the `events.amazonaws.com` → Lambda IAM grant are all
**auto-wired by Serverless v4** from the function's
`events: - schedule:` declaration. Nothing custom is needed. If we
ever add a failed-invocation DLQ or a CloudWatch alarm, that lands
here.

### 5.6 Putting it together

Read the reaper tree top-down:

1. `serverless.yml` sets the service name and pulls in
   `config.yml`'s `environment` and `iam.yml`'s `role`.
2. `iam.yml` pulls in three IAM fragments, each contributing one
   statement to the role.
3. `config.yml` resolves `${cf:...}` against author-bff's deployed
   stack and exposes the result as `custom.*` and
   `reaperEnvironment.*`.
4. `resources.yml` is empty; the schedule is fully driven by
   `functions.reap.events` in the root.
5. At `sls package` the fallbacks make the CFN synthesize even
   without author-bff being live. At `sls deploy` the `${cf:...}`
   lookups resolve, the schedule rule is wired, and the stack goes
   up.

## 6. Differences between the four stacks

| Aspect                      | event-hub           | author-bff                  | public-bff                    | reaper                |
|-----------------------------|---------------------|------------------------------|--------------------------------|-----------------------|
| Service                     | `pastebin-event-hub`| `pastebin-author-bff`        | `pastebin-public-bff`          | `pastebin-reaper`     |
| HTTP API                    | none                | yes (HTTP API + JWT auth)    | yes (HTTP API, no auth)        | none                  |
| Functions                   | 0                   | 3 rest + 1 trigger           | 3 rest + 1 listener            | 1 scheduled           |
| DDB tables                  | 0                   | 1 (PastesTable)              | 1 (ReadsTable)                 | 0                     |
| DDB stream source mapping   | no                  | yes (trigger)                | no                             | no                    |
| SQS source mapping          | no                  | no                           | yes (listener)                 | no                    |
| Bus publisher               | no                  | trigger only                 | no (consumes)                  | no (transitive only)  |
| Bus consumer                | no                  | no                           | EventBridge rule → SQS         | no                    |
| Cognito                     | no                  | yes (UserPool + client)      | no                             | no                    |
| Cross-stack IAM             | none                | events:PutEvents on bus      | s3:GetObject + s3:ListBucket   | DDB + S3 on author-bff |
| Schedules                   | no                  | no                           | no                             | yes (EventBridge)     |
| Bucket                      | no                  | yes (content, owns lifecycle) | no                            | no                    |
| Deploy order                | 1                   | 2                            | 3                              | 4                     |

The reaper is the only stack that **does not** import the busName
from event-hub. The other three either publish to it (author-bff's
trigger) or subscribe from it (public-bff's listener rule).
Reaper's only upstream dependency is author-bff.

## 7. Common edits and where they go

| I want to...                                      | Edit                                               |
|---------------------------------------------------|----------------------------------------------------|
| Add a new env var to all four stacks              | `config.yml:environment` in each stack             |
| Add a per-function env var                        | `config.yml:reaperEnvironment` / `restEnvironment` / etc., reference it from `serverless.yml:functions.<name>.environment` |
| Add a new IAM permission to the rest role         | New `*.yml` with one `iamRoleStatements`, list it in `iam.yml:role.statements` |
| Tighten / loosen an existing IAM permission       | Edit the matching `*.yml` directly                 |
| Add a new DDB table                               | `resources.yml` (resource) + new `dynamodb*.yml` (IAM) + `iam.yml` (aggregator) |
| Add a new route                                   | `serverless.yml:functions.<name>.events.httpApi` — Serverless v4 auto-wires |
| Add a new bus consumer stack                      | New directory, new `serverless.yml`, new `bus.yml` (IAM only) + `listener.yml` (IAM only) + `resources.yml` (rule + SQS + DLQ) |
| Wire a cross-stack ref                            | `config.yml:custom` with `${cf:..., 'fallback'}` and a corresponding Output in the producer's `resources.yml` |
| Change the service name                           | `serverless.yml:service` (and `${self:custom.subsys}-${self:custom.role}` if you've inlined it in the root) |
| Change the bus name pattern                       | `serverless/bus.yml` (event-hub) — its CFN output is consumed as `${cf:...busName}` in three other stacks, so changing the export name requires updating those |

## 8. Conventions summary

These are inherited from `../url-shortener-app/`. If you're changing
the convention, change it there first, then port.

- **Service name:** `${self:custom.subsys}-${self:custom.role}`
  (event-hub, author-bff, public-bff, reaper).
- **Stack name:** `<service>-<stage>` (CloudFormation auto-derives
  from `service` + `stage`).
- **Resource names:** `${self:service}-${opt:stage}-<suffix>`
  (e.g. `pastebin-author-bff-dev-pastes`).
- **Function names:** `${self:service}-${opt:stage}-<role>`
  (e.g. `pastebin-author-bff-dev-createPaste`).
- **Custom exports:** CamelCase (e.g. `PastesTableArn`,
  `ContentBucketName`, `ApiEndpoint`).
- **IAM convention:** one `iamRoleStatements:` object per fragment
  file; `iam.yml` aggregates.
- **Cross-stack convention:** `${cf:..., 'fallback'}` in
  `config.yml:custom`, never in `resources.yml`.
- **No SSM at MVP:** all cross-stack data is CFN outputs.
- **No secrets in yml:** Cognito client secrets, API keys, etc. are
  declared as CFN resources, not hardcoded values.
- **No `UpdateItem` at MVP for the reaper** (design §10 §7): the
  reaper deletes S3 first, then DDB, with the DDB stream's REMOVE
  event as the PasteDeleted producer.
- **DDB stream is the SOLE event producer** (design §6): no handler
  in any BFF calls `PutEvents` directly. Only the `trigger` lambda
  in author-bff publishes, and it publishes from the stream CDC
  record, not from a handler call.

## 9. See also

- `design-research.md` — the architecture, the event topology, the
  reaper loop, and the resolved design concerns (§10).
- `../url-shortener-app/design-research.md` — the reference repo
  whose conventions this stack set mirrors.
- Each stack's `serverless.yml` header comment — a few paragraphs
  explaining the stack's role in the topology.
- `AGENTS.md` at the repo root — build order, deploy commands, and
  the project-level rules an AI agent should follow.
