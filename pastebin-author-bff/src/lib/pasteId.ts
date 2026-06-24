/**
 * Paste ID generation.
 *
 * Format: 8 chars total — 6 random Base62 + 2-char checksum.
 * Example: "aB3xY7" + "9K" -> "aB3xY79K"
 *
 * Why this shape (design §3):
 *   - 6 random Base62 chars give 62^6 = ~56.8 B ids. At 1 M pastes/day
 *     that's ~155 years of headroom before the birthday-paradox
 *     collision probability is meaningful (~1e-6 for 1 M ids). We accept
 *     the tiny collision risk rather than carry a separate KGS service.
 *   - 2-char Base62 checksum catches typos (one of the few UX things a
 *     pastebin can do to make the share-URL not silently 404 because
 *     the user mistyped one char). 62^2 = 3844 possible checksums; with
 *     random ids the chance of a single-char typo producing a valid
 *     checksum is ~0.026%. We accept that.
 *   - Total 8 chars, lowercase + digits, easy to type, URL-safe.
 *
 * `checksum2` is ported VERBATIM from
 * url-shortener-app-bff/src/lib/code.ts: same algorithm, same
 * character set, same forward-compat path. If we ever change one, we
 * change both.
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generate 6 random Base62 characters from `crypto.randomBytes(6)`.
 * Each input byte (0-255) is mapped to a Base62 character by
 * `b % 62` -- 256 mod 62 = 8, so the first 8 chars of BASE62 are
 * slightly biased (5/256 vs 4/256 chance). For paste IDs this bias
 * is invisible; if it ever matters, switch to rejection sampling.
 */
export function randomBase62(bytes: number): string {
  // Lazy import: `crypto` is a Node global so we could `import { randomBytes }
  // from 'crypto'` at the top, but we want this module to stay
  // importable from `aws-lambda-stream` test harnesses that don't
  // require a full Node module loader. Calling it lazily works in
  // both contexts (Node Lambda + test).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  const buf = randomBytes(bytes);
  let out = "";
  for (let i = 0; i < bytes; i++) {
    out += BASE62[buf[i]! % BASE62.length];
  }
  return out;
}

/**
 * 2-character Base62 checksum of an input string. Same algorithm as
 * url-shortener-app-bff/src/lib/code.ts:checksum2 -- 7-bit sum mod 3844
 * (62^2), encoded as two Base62 chars.
 */
export function checksum2(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    sum = (sum * 31 + s.charCodeAt(i)) & 0x7fffffff;
  }
  // mod 62^2 (= 3844) to keep the sum to 2 base62 chars.
  // 3844 < 62^2, so both lookups are in-range, but
  // `noUncheckedIndexedAccess` still types them as `string | undefined`.
  // We compute the two char indices into local consts and use
  // non-null assertions here because the modulo bounds them
  // inside BASE62.length, which is 62.
  const mod = sum % (BASE62.length * BASE62.length);
  const hi = Math.floor(mod / BASE62.length);
  const lo = mod % BASE62.length;
  return BASE62[hi]! + BASE62[lo]!;
}

/**
 * Generate a fresh paste ID: 6 random Base62 chars + 2-char checksum.
 * The function is a fresh-call site (not idempotent on a given input);
 * the caller decides whether to re-derive the ID for retries (we do NOT
 * for paste creation -- see src/rest/handlers.ts for the retry policy).
 */
export function generatePasteId(): string {
  const random = randomBase62(6);
  return random + checksum2(random);
}
