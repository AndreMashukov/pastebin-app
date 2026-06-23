/**
 * pastebin-author-bff — entrypoint index.
 *
 * The actual handlers live in `src/rest/handlers.ts` and `src/trigger.ts`
 * and are referenced by name in `serverless.yml` (handler: src/rest/handlers.createPaste,
 * etc.). This file exists so `tsc --noEmit` has an entry point to walk
 * the source tree from, and so future cross-cutting concerns (logging
 * setup, error normalizers, request-id correlation) have an obvious
 * place to land without changing the per-function handler imports in
 * serverless.yml.
 *
 * Nothing is exported here yet — see src/rest/handlers.ts and
 * src/trigger.ts for the actual business logic.
 */

export {};
