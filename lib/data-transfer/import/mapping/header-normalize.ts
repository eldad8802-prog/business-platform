/**
 * Header normalization for matching — SAFE transformations only.
 *
 * The job is to make "Customer Name", " customer_name " and "customer name"
 * compare equal, and nothing more. Every rule here is reversible in meaning:
 * none of them can turn one field's name into another field's name.
 *
 * What is deliberately NOT done, because each can map a column to the wrong
 * field and a wrong mapping writes real values into the wrong place:
 *
 *  - no stemming, lemmatizing or transliteration
 *  - no edit-distance / fuzzy matching ("מחיר" is not "מחירון")
 *  - no substring containment ("שם" would then match "שם ספק")
 *  - no translation
 *  - no dropping of Hebrew letters
 *
 * Hebrew specifics that ARE safe:
 *  - geresh/gershayim (׳ ״) and the ASCII quotes people type instead are
 *    unified, so 'מק״ט', 'מק"ט' and 'מקט' compare equal.
 *  - niqqud is stripped; it is decoration, never distinction, in a header.
 *  - the RTL/LTR marks Excel likes to inject are removed.
 */

/** Bidi and zero-width marks that survive a copy-paste out of Excel. */
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

/** Hebrew niqqud and cantillation. */
const NIQQUD = /[֑-ׇ]/g;

/** Geresh, gershayim, and the ASCII quotes typed in their place. */
const QUOTE_LIKE = /['"׳״‘’“”]/g;

/** Separators a header might use between words. */
const SEPARATORS = /[_\-–—.,;:/\\|()[\]{}]+/g;

/**
 * Reduce a header to its comparison form.
 *
 * Stable and total: any string in, a string out, never throws. An empty or
 * whitespace-only header normalizes to "" and can therefore never match a
 * field — an unnamed column is not a mapping candidate.
 */
export function normalizeHeaderForMatch(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(INVISIBLE, "")
    .replace(NIQQUD, "")
    .replace(QUOTE_LIKE, "")
    .replace(SEPARATORS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when two headers are the same label written differently. */
export function headersMatch(a: unknown, b: unknown): boolean {
  const left = normalizeHeaderForMatch(a);
  if (left === "") return false;
  return left === normalizeHeaderForMatch(b);
}
