/**
 * WP2.1 — ISO-8859-8-i encoder (spec 1.31 §2.4.ח: Windows charset = ISO-8859-8-i).
 *
 * Single-byte encoding: every source character becomes exactly ONE byte, so a
 * record padded to N characters is exactly N bytes — which is what the
 * fixed-width record layout requires.
 *
 * Mapping:
 *  - ASCII 0x00–0x7F → identical byte.
 *  - Hebrew letters U+05D0..U+05EA (א..ת, incl. final forms) → 0xE0..0xFA.
 *  - A small set of common Unicode punctuation → ASCII equivalents.
 *  - Anything else → '?' (0x3F) fallback.
 *
 * "-i" (logical) means characters are stored in logical/reading order — which is
 * exactly how JS strings already hold them, so no reversal is performed.
 */

const HEBREW_START_CP = 0x05d0; // א
const HEBREW_END_CP = 0x05ea; // ת
const HEBREW_START_BYTE = 0xe0;

/** Fallback byte for characters not representable in ISO-8859-8. */
export const ISO_8859_8_FALLBACK_BYTE = 0x3f; // '?'

/** Common Unicode → ASCII substitutions before fallback. */
const SUBSTITUTIONS: Record<number, number> = {
  0x00a0: 0x20, // NBSP → space
  0x05f3: 0x27, // ׳ geresh → '
  0x05f4: 0x22, // ״ gershayim → "
  0x2013: 0x2d, // – en dash → -
  0x2014: 0x2d, // — em dash → -
  0x2018: 0x27, // ' → '
  0x2019: 0x27, // ' → '
  0x201c: 0x22, // " → "
  0x201d: 0x22, // " → "
  0x20aa: 0x24, // ₪ → $ (no NIS glyph in ISO-8859-8)
};

/** Encode a logical-order string to ISO-8859-8-i bytes (1 byte per char). */
export function encodeIso8859_8i(input: string): Buffer {
  const bytes = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i++) {
    const cp = input.charCodeAt(i);
    let b: number;
    if (cp <= 0x7f) {
      b = cp;
    } else if (cp >= HEBREW_START_CP && cp <= HEBREW_END_CP) {
      b = HEBREW_START_BYTE + (cp - HEBREW_START_CP);
    } else if (SUBSTITUTIONS[cp] !== undefined) {
      b = SUBSTITUTIONS[cp];
    } else {
      b = ISO_8859_8_FALLBACK_BYTE;
    }
    bytes[i] = b;
  }
  return bytes;
}
