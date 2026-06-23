# pastebin-event-hub

Shared EventBridge bus for the `pastebin-app` system.

Forked from `jgilbert01/templates/template-event-hub/`. This stack contains only AWS infrastructure (an EventBridge bus and an event archive) — no business logic and no Lambda functions. The other three stacks in the system (`pastebin-author-bff`, `pastebin-public-bff`, `pastebin-reaper`) publish to this bus and consume events from it.

## What gets created

| Resource  | CFN type                | Name                              |
| --------- | ----------------------- | --------------------------------- |
| `Bus`     | `AWS::Events::EventBus` | `pastebin-event-hub-dev-bus`      |
| `Archive` | `AWS::Events::Archive`  | `pastebin-event-hub-dev-archive`  |

The archive is configured with `EventPattern: { detail: { type: [{ "anything-but": "fault" }] } }` so every event on the bus is captured EXCEPT fault events (book Ch. 4, "Systemwide Event Sourcing"). This gives a complete event-sourced log of every domain event in the system, for replay and debugging.

## Outputs

- `busName` — `${service}-${stage}-bus` (e.g. `pastebin-event-hub-dev-bus`)
- `busArn` — full ARN
- `archiveName`, `archiveArn` — archive identifier

Other stacks consume `busName` via cross-stack reference:

```yaml
EventBusName: ${cf:pastebin-event-hub-${opt:stage}.busName}
```

## Deploy

```bash
yarn nx run pastebin-event-hub:deploy -- --stage dev --region ap-southeast-1
```

Or from this directory:

```bash
serverless deploy --stage dev --region ap-southeast-1
```

## Stack name and naming

- **CloudFormation stack**: `pastebin-event-hub-dev` (for stage `dev`)
- **Service name** (in `serverless.yml`): `pastebin-event-hub`
- **Bus name**: `pastebin-event-hub-dev-bus`

The `${self:custom.subsys}-${self:custom.role}` convention in `serverless/config.yml` is what produces the service name. To add another role, copy this directory and change `custom.role` in `serverless/config.yml`.

## See also

- `../design-research.md` — system architecture and resolved design decisions
- `../../url-shortener-app/url-shortener-event-hub/` — sibling repo's bus, same shape