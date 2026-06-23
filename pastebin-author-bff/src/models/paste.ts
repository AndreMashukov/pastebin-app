/**
 * Paste entity (Single-Table Design).
 *
 * Stored in PastesTable. The DDB row shape:
 *   pk       = "PASTE#<pasteId>"
 *   sk       = "META"
 *   gsi1     = ownerSub (HASH) + gsisk (RANGE)   - GET /me/pastes
 *   gsi2     = gsi2pk (HASH) + gsi2sk (RANGE)    - reaper expiry scan
 *
 *   pk         = "PASTE#<pasteId>"            - primary key
 *   sk         = "META"                       - sort key (always META)
 *   pasteId    = <crypto.randomBytes(6)>       - public, in row (8 chars total w/ checksum)
 *   ownerSub   = <cognito sub>                - GSI1 HASH key
 *   gsisk      = "<expiresAt>#<pasteId>"      - GSI1 RANGE key
 *   gsi2pk     = "EXPIRE"                     - GSI2 HASH key (sparse - only when expiresAt set)
 *   gsi2sk     = "<expiresAt>#<pasteId>"      - GSI2 RANGE key
 *
 * GSI1 enables GET /me/pastes: query GSI1 with KeyConditionExpression
 * `ownerSub = :sub` to list all pastes owned by the caller, sorted
 * newest-first by expiresAt (gaps indicate never-expires pastes sort
 * last under empty-string sort).
 *
 * GSI2 is the reaper's index: it scans gsi2pk = "EXPIRE" AND
 * gsi2sk < :now to find all expired pastes in one query.
 *
 * The bus event shape (`detail` field of Paste.* events) is the
 * `PasteEvent` type below.
 *
 * Design doc: ../design-research.md §4.
 */

export type Discriminator = "META";

/** Persistence row in PastesTable.
 *
 * NOTE: `expires_at` (snake_case) is the actual DDB attribute name
 * used by the table's TimeToLiveSpecification (DDB TTL requires the
 * attribute name in the item to match what's declared on the table).
 * `expiresAt` (camelCase) is the event-bus detail field convention
 * for downstream consumers -- we map between the two at the bus
 * boundary in src/trigger.ts. The DDB stream record (NEW_AND_OLD_IMAGES)
 * carries the row as-is, so the trigger's `unmarshall` will see
 * `expires_at` and we re-emit it as `expiresAt` in the detail JSON.
 *
 * DDB row shape:
 *   pk         = "PASTE#<pasteId>"            (HASH)
 *   sk         = "META"                       (RANGE)
 *   ownerSub   = <cognito sub>                (GSI1 HASH)
 *   gsisk      = "<expires_at>#<pasteId>"     (GSI1 RANGE) -- never-expires pastes use createdAt#pasteId
 *   gsi2pk     = "EXPIRE"                     (GSI2 HASH, sparse -- only when expires_at set)
 *   gsi2sk     = "<expires_at>#<pasteId>"     (GSI2 RANGE)
 *   expires_at = <iso-8601>                   (TTL, sparse -- only when set)
 *
 * GSI1 enables GET /me/pastes: query GSI1 with KeyConditionExpression
 * `ownerSub = :sub` to list all pastes owned by the caller, sorted
 * newest-first.
 *
 * GSI2 is the reaper's index: it scans gsi2pk = "EXPIRE" AND
 * gsi2sk < :now to find all expired pastes in one query.
 */
export interface PasteRow {
  pk: string;
  sk: Discriminator;
  pasteId: string;
  ownerSub: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  expires_at?: string;
  gsisk: string;
  gsi2pk?: "EXPIRE";
  gsi2sk?: string;
}

/** Paste detail payload carried on EventBridge as `detail` of `Paste.*`. */
export interface PasteEvent {
  pasteId: string;
  ownerSub: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt?: string;
}

/** Paste change kind emitted as `detail-type`. */
export type PasteEventType = "PasteCreated" | "PasteDeleted";
