/**
 * The closed vocabularies of historical fiscal import, and their normalizers.
 *
 * Everything here is a LOOKUP, never a guess. No fuzzy matching, no edit
 * distance, no "closest known value", no model. A term the table does not know
 * is refused with the list of terms it does know, because an import that
 * silently relabels somebody's credit note as an invoice is worse than one that
 * stops and asks.
 */

/**
 * The four document types historical import accepts in v1.
 *
 * Deliberately NOT `BillingDocumentType`. That enum means "a document Dubiz
 * issued" and reusing it would put historical records into the vocabulary of
 * Dubiz issuance, which is the confusion this whole layer exists to prevent.
 * The values happen to read the same because they name the same fiscal
 * artefacts in Israeli practice; the meaning attached to them does not.
 *
 * `QUOTE` is absent on purpose. A quote is not a fiscal document: it carries no
 * VAT that was reported, no number that must be kept, and no retention duty. It
 * belongs to a sales history, not a fiscal one.
 */
export const HISTORICAL_DOCUMENT_TYPES = [
  "TAX_INVOICE",
  "RECEIPT",
  "TAX_INVOICE_RECEIPT",
  "CREDIT_NOTE",
] as const;

export type HistoricalDocumentType = (typeof HISTORICAL_DOCUMENT_TYPES)[number];

/** The Hebrew the owner is asked to write, one canonical label per type. */
export const HISTORICAL_TYPE_LABELS: Record<HistoricalDocumentType, string> = {
  TAX_INVOICE: "חשבונית מס",
  RECEIPT: "קבלה",
  TAX_INVOICE_RECEIPT: "חשבונית מס/קבלה",
  CREDIT_NOTE: "חשבונית זיכוי",
};

/**
 * The spellings a real Israeli export actually contains.
 *
 * Every entry is an EXACT term after whitespace collapsing and lowercasing —
 * this is a dictionary, not a matcher. The list is short because it was written
 * from the forms these documents are actually labelled with, and it grows only
 * when a real file proves a form is missing.
 */
const TYPE_ALIASES: Record<string, HistoricalDocumentType> = {
  "חשבונית מס": "TAX_INVOICE",
  "חשבונית מס ממוחשבת": "TAX_INVOICE",
  "חשבונית": "TAX_INVOICE",
  "tax invoice": "TAX_INVOICE",
  "קבלה": "RECEIPT",
  "receipt": "RECEIPT",
  "חשבונית מס/קבלה": "TAX_INVOICE_RECEIPT",
  "חשבונית מס קבלה": "TAX_INVOICE_RECEIPT",
  "חשבונית מס-קבלה": "TAX_INVOICE_RECEIPT",
  "חשבונית מס / קבלה": "TAX_INVOICE_RECEIPT",
  "tax invoice receipt": "TAX_INVOICE_RECEIPT",
  "חשבונית זיכוי": "CREDIT_NOTE",
  "זיכוי": "CREDIT_NOTE",
  "תעודת זיכוי": "CREDIT_NOTE",
  "credit note": "CREDIT_NOTE",
};

/**
 * Currencies v1 accepts.
 *
 * ILS only, and that is an audit result rather than a preference: the only
 * currency any Dubiz code path writes is `"ILS"` — `billing-draft.service.ts`
 * hardcodes it and `BillingDocument.currency` defaults to it. There is no
 * screen, service or export that produces or consumes another one. Listing USD
 * and EUR here would advertise support the product does not have.
 *
 * The field is REQUIRED and there is no silent default: an owner whose history
 * is in shekels says so, and an owner whose history is not gets a clear refusal
 * instead of an invoice quietly relabelled as ILS. Widening this list is a
 * product decision for the increment that gives foreign currency a consumer.
 */
export const HISTORICAL_CURRENCIES = ["ILS"] as const;

export type HistoricalCurrency = (typeof HISTORICAL_CURRENCIES)[number];

/** Ways an owner might write the shekel. Exact terms, as above. */
const CURRENCY_ALIASES: Record<string, HistoricalCurrency> = {
  ils: "ILS",
  "₪": "ILS",
  "שח": "ILS",
  'ש"ח': "ILS",
  "שקל": "ILS",
  "שקלים": "ILS",
  nis: "ILS",
};

/**
 * The source system a document came from.
 *
 * `manual` is the canonical fallback and means exactly "the owner did not name
 * a system". It is a real value rather than a blank because the column is NOT
 * NULL and because it participates in fiscal identity: two systems can both
 * have an invoice numbered 1001, and without a code they would look like one
 * document.
 *
 * There is deliberately no vendor catalogue. Dubiz does not integrate with
 * these systems, and a hardcoded list of competitors would be a maintenance
 * burden that buys nothing — the owner's own words are kept verbatim in
 * `sourceSystemNameRaw`, so a canonical code can be assigned later without
 * touching a single stored row.
 */
export const HISTORICAL_SOURCE_MANUAL = "manual";

/** How the owner writes "no particular system". */
const SOURCE_MANUAL_ALIASES = new Set([
  "manual",
  "ידני",
  "הזנה ידנית",
  "אחר",
  "לא ידוע",
]);

/** Collapse whitespace and case so a lookup is about the term, not the typing. */
function term(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase();
}

export type VocabularyResult<T> =
  | { ok: true; value: T; raw: string }
  | { ok: false; raw: string; reason: string };

/**
 * Canonical type plus the owner's own words.
 *
 * Both are returned because they are SEPARATE TRUTHS: `documentTypeCode` is
 * what Dubiz decided this is, `sourceDocumentTypeRaw` is what the other system
 * called it. Keeping the second means a normalization can be re-examined years
 * later without the original wording being gone.
 */
export function normalizeHistoricalDocumentType(
  cell: unknown
): VocabularyResult<HistoricalDocumentType> {
  const raw = cell == null ? "" : String(cell).trim();
  if (raw === "") {
    return { ok: false, raw, reason: "סוג מסמך חסר" };
  }
  const hit = TYPE_ALIASES[term(raw)];
  if (!hit) {
    return {
      ok: false,
      raw,
      reason: `סוג מסמך לא מוכר. הערכים המותרים: ${Object.values(HISTORICAL_TYPE_LABELS).join(" · ")}`,
    };
  }
  return { ok: true, value: hit, raw };
}

export function normalizeHistoricalCurrency(
  cell: unknown
): VocabularyResult<HistoricalCurrency> {
  const raw = cell == null ? "" : String(cell).trim();
  if (raw === "") {
    return { ok: false, raw, reason: "מטבע חסר. יש לציין את המטבע במפורש" };
  }
  const hit = CURRENCY_ALIASES[term(raw)];
  if (!hit) {
    return {
      ok: false,
      raw,
      reason: `מטבע לא נתמך. נתמך כרגע: ${HISTORICAL_CURRENCIES.join(" · ")}`,
    };
  }
  return { ok: true, value: hit, raw };
}

/**
 * Source system: a stable code plus the owner's words.
 *
 * Anything that is not one of the "no particular system" spellings becomes a
 * slug of what the owner wrote. The slug is stable for the same input, which is
 * what fiscal identity needs, and the raw text is preserved beside it.
 */
export function normalizeHistoricalSourceSystem(
  cell: unknown
): VocabularyResult<string> {
  const raw = cell == null ? "" : String(cell).trim();
  if (raw === "") {
    return { ok: false, raw, reason: "מערכת מקור חסרה" };
  }
  if (SOURCE_MANUAL_ALIASES.has(term(raw))) {
    return { ok: true, value: HISTORICAL_SOURCE_MANUAL, raw };
  }
  const slug = term(raw)
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (slug === "") {
    return { ok: false, raw, reason: "מערכת מקור לא תקינה" };
  }
  return { ok: true, value: slug, raw };
}

/**
 * Customer tax id, as a SNAPSHOT.
 *
 * Digits only, 8 or 9 of them, which is the shape of an Israeli ח.פ. or עוסק
 * מורשה number. This checks SHAPE and says so: it deliberately does not verify
 * the check digit, because a historical record must be storable even when the
 * source held something imperfect, and claiming validation we do not perform
 * would be worse than performing none.
 *
 * It looks nothing up and creates nothing. `HistoricalFiscalDocument` has no
 * relation to `Customer` by design — the snapshot is what the document said at
 * the time, and it must not change because somebody edited a customer years
 * later.
 */
export function normalizeCustomerTaxIdSnapshot(
  cell: unknown
): VocabularyResult<string | null> {
  const raw = cell == null ? "" : String(cell).trim();
  if (raw === "") {
    return { ok: true, value: null, raw };
  }
  const digits = raw.replace(/[\s-]/g, "");
  if (!/^\d{8,9}$/.test(digits)) {
    return { ok: false, raw, reason: "מספר עוסק / ח.פ. אמור להיות 8 או 9 ספרות" };
  }
  return { ok: true, value: digits, raw };
}
