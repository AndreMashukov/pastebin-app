/**
 * pasteId validation ported VERBATIM from
 * pastebin-author-bff/src/lib/pasteId.ts.
 *
 * The author-bff generates 8-char pasteIds: 6 random Base62 chars +
 * 2 Base62 chars of checksum2 of the first 6. We need the same
 * generation logic on the read side so:
 *   (a) we can validate the id format (cheap pre-DDB check),
 *   (b) we can verify the checksum (cheap typo pre-DDB check),
 *   (c) the S3 key construction matches what author-bff wrote.
 *
 * The code is duplicated rather than imported from author-bff because
 * (i) the bffs are independent deployable units, (ii) sharing via a
 * `libs/` package would create a new npm workspace we don't need for
 * a 30-line file, and (iii) the algorithm is stable — porting it once
 * to a "second source" is acceptable risk. The two copies MUST stay
 * byte-identical; if we ever change the algorithm, change both.
 */

// IMPORTANT: the BASE62 order MUST match pastebin-author-bff
// character-for-character. If we change one, we change both.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Length of a generated pasteId (6 random + 2 checksum). */
export const PASTE_ID_LENGTH = 8;

/** Permitted character set: Base62 (a-z 0-9 A-Z). */
const PASTE_ID_PATTERN = /^[A-Za-z0-9]{8}$/;

/** 2-character Base62 checksum of an input string.
 *  Same algorithm as pastebin-author-bff/src/lib/pasteId.ts
 *  (and url-shortener-app-bff/src/lib/code.ts) — sum mod 3844 (62^2),
 *  encoded as two Base62 chars. `noUncheckedIndexedAccess` still types
 *  the indexed lookup as `string | undefined`; we use non-null
 *  assertions because the modulo bounds the index inside
 *  BASE62.length. */
function checksum2(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    sum = (sum * 31 + s.charCodeAt(i)) & 0x7fffffff;
  }
  const mod = sum % (BASE62.length * BASE62.length);
  const hi = Math.floor(mod / BASE62.length);
  const lo = mod % BASE62.length;
  return BASE62[hi]! + BASE62[lo]!;
}

/** True iff `id` is a syntactically well-formed pasteId and the
 *  trailing 2 chars are the correct checksum2 of the leading 6. */
export function isValidPasteId(id: string): boolean {
  if (!PASTE_ID_PATTERN.test(id)) return false;
  const body = id.slice(0, 6);
  const checksum = id.slice(6, 8);
  return checksum2(body) === checksum;
}

/** Split a pasteId into its (body, checksum) halves. Caller is
 *  expected to have already validated with `isValidPasteId`; we
 *  don't re-validate here for speed. */
export function splitPasteId(id: string): { body: string; checksum: string } {
  return { body: id.slice(0, 6), checksum: id.slice(6, 8) };
}
