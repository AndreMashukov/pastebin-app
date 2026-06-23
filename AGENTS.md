# AGENTS.md — Pastebin App

Instructions for AI agents working in this repository.

## Project overview

AWS serverless pastebin built with **Serverless Framework v4** and **Nx**. Event-sourced / CQRS architecture: four CloudFormation stacks share one EventBridge bus in **`ap-southeast-1`**.

Sibling app at `../url-shortener-app/` is the reference for conventions, build order, and bus wiring. This repo mirrors it.

| Stack | Directory | MCP service name (dev) | Status |
|-------|-----------|------------------------|--------|
| Event hub | `pastebin-event-hub/` | `pastebin-event-hub-dev` | scaffolded |
| Author BFF | `pastebin-author-bff/` | `pastebin-author-bff-dev` | pending |
| Public BFF | `pastebin-public-bff/` | `pastebin-public-bff-dev` | pending |
| Reaper | `pastebin-reaper/` | `pastebin-reaper-dev` | pending |

**Deploy order:** event-hub → author-bff → public-bff → reaper
**Default stage:** `dev` · **Region:** `ap-southeast-1`

## Architecture

See `design-research.md` (the build plan) and `system_design__architecting_a_pastebin_service.md` (the textbook brief this repo is implementing).

Key design rules (from `design-research.md` §10):

- **DDB stream is the SOLE event producer.** The handler never calls `PutEvents` directly; the `author-trigger` Lambda consumes the DDB stream and publishes `PasteCreated` / `PasteDeleted` to the bus.
- **No Redis, no standalone KGS, no CDN at v1.** Random 48-bit Base62 + 2-char checksum for paste ids; S3-primary for bodies; add DAX / CloudFront when metrics demand.
- **Reaper is its own stack.** Cross-stack IAM on author-bff's pastes table + content bucket. No `UpdateItem` at MVP — S3 lifecycle rule + DDB TTL are backstops.
- **All cross-stack wiring via `${cf:...}` CFN outputs.** No SSM at MVP.

## Commands

```bash
yarn install
yarn typecheck
yarn package:event-hub && yarn deploy:event-hub   # bus first
yarn deploy:author-bff
yarn deploy:public-bff
yarn deploy:reaper
yarn show:projects
```

Prefer Nx/yarn scripts over invoking `serverless` directly when a target exists.

## Code conventions

- **Node 20+**, TypeScript, yarn workspaces.
- Match the patterns in `../url-shortener-app/` (sister repo) — same conventions, same template set, same bus-archive shape.
- Minimal diffs — only change what the task requires.
- Never commit `.env` or secrets.
- Only create git commits when the user explicitly asks.

## Related docs

- `design-research.md` — architecture deep dive + resolved design decisions
- `system_design__architecting_a_pastebin_service.md` — generic textbook brief this repo maps onto
- `../url-shortener-app/design-research.md` — sibling repo's architecture doc (format reference)