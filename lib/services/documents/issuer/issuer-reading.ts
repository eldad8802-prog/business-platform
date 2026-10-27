/**
 * Who ISSUED a document, as read off the document — kept apart from the owner's decision.
 *
 * Pure: no database, no tenant context. The extraction chain calls it after the vendor strategy; the
 * result is stored on ExtractedData (issuerTaxId / issuerTaxIdSource / issuerTaxIdValid / issuerCheck /
 * ownBusinessExcluded) and is only ever a reading. Which supplier the document belongs to is the owner's
 * decision (DocumentSupplierLink), never this.
 *
 * Rules (milestone 1 of supplier linking):
 *   - the business's OWN tax id and name are the RECIPIENT, never the issuer: they are excluded first;
 *   - a tax id only counts when it carries a valid Israeli check digit; an invalid one is reported as such
 *     (TAX_ID_INVALID) and never used to suggest a supplier;
 *   - two or more different valid ids, none tied to the vendor line, are a conflict — no id is chosen;
 *   - nothing here is "certain": the caller still routes the document to review as before.
 */
import { authoritativeTaxId } from "@/lib/identity/tax-id";
import { normalizeVendorForLearning } from "@/lib/services/documents/vendor-normalization.service";
import type { BusinessIdEntity, VendorEntity } from "../entities/document-entities.types";

export type IssuerTaxIdSource = "VENDOR_LINE" | "HEADER" | "ONLY_ON_DOCUMENT";

export type IssuerCheck =
  | "OK"
  | "NO_TAX_ID"
  | "TAX_ID_INVALID"
  | "CONFLICTING_TAX_IDS"
  | "OWN_BUSINESS_ONLY";

export type IssuerReading = {
  taxId: string | null;
  taxIdSource: IssuerTaxIdSource | null;
  taxIdValid: boolean | null;
  check: IssuerCheck;
  /** The business's own name or tax id appeared on the document and was kept out of the issuer. */
  ownBusinessExcluded: boolean;
};

/** What the business is called and registered as — the recipient side of its own documents. */
export type OwnBusinessIdentity = {
  /** Nine-digit forms (padded); valid or not — an own id typed without its check digit is still own. */
  taxIds: string[];
  /** normalizeVendorForLearning keys of the business name and its legal billing name. */
  nameKeys: string[];
};

function digitsOf(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

function nineDigits(value: string): string {
  return value.length === 8 ? value.padStart(9, "0") : value;
}

export function buildOwnBusinessIdentity(input: {
  businessName?: string | null;
  legalName?: string | null;
  taxId?: string | null;
}): OwnBusinessIdentity {
  const taxIds = new Set<string>();
  const raw = digitsOf(input.taxId);
  if (raw.length >= 8 && raw.length <= 9) taxIds.add(nineDigits(raw));
  const valid = authoritativeTaxId(input.taxId);
  if (valid) taxIds.add(valid);

  const nameKeys = new Set<string>();
  for (const name of [input.businessName, input.legalName]) {
    const key = nameKey(name);
    if (key) nameKeys.add(key);
  }
  return { taxIds: [...taxIds], nameKeys: [...nameKeys] };
}

/** Legal-form words: "אלפא בע"מ" and "אלפא" name the same supplier. */
const LEGAL_FORM = new Set(["בעמ", "ltd", "inc", "llc"]);

/** The comparison key of a name, or null when nothing distinctive is left of it. */
export function nameKey(name: string | null | undefined): string | null {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return null;
  const key = normalizeVendorForLearning(trimmed)
    .normalizedKey.split(" ")
    .filter((t) => t && !LEGAL_FORM.has(t))
    .join(" ");
  if (!key || key === "unknown" || key.replace(/\s/g, "").length < 2) return null;
  return key;
}

export function isOwnTaxId(own: OwnBusinessIdentity, value: string): boolean {
  const digits = nineDigits(digitsOf(value));
  return digits.length > 0 && own.taxIds.includes(digits);
}

/**
 * True when a vendor candidate is the business itself: the same name key, or — for an own name of two or
 * more words — a candidate that contains every one of its words ("דוגמה שיווק בע"מ" for "דוגמה שיווק").
 * A one-word own name must match exactly: "דוד" must not exclude "דוד מוצרי חשמל".
 */
export function isOwnName(own: OwnBusinessIdentity, candidate: string | null | undefined): boolean {
  const key = nameKey(candidate);
  if (!key) return false;
  const tokens = new Set(key.split(" "));
  return own.nameKeys.some((ownKey) => {
    if (ownKey === key) return true;
    const ownTokens = ownKey.split(" ");
    return ownTokens.length >= 2 && ownTokens.every((t) => tokens.has(t));
  });
}

function vendorAnchorTaxId(vendor: VendorEntity): string | null {
  for (const signal of vendor.signals) {
    const m = /^business_id=(\d+)$/.exec(signal);
    if (m) return m[1];
  }
  return null;
}

export function readIssuer(input: {
  businessIds: BusinessIdEntity[];
  vendor: VendorEntity;
  headerLines: string[];
  /** Every line of the document: an own id anywhere on it (e.g. the "לכבוד" block) is recorded as excluded. */
  allLines?: string[];
  own: OwnBusinessIdentity;
  /** The vendor strategy skipped a candidate because it was the business's own name. */
  ownNameExcluded: boolean;
}): IssuerReading {
  const { businessIds, vendor, own } = input;
  const header = new Set(input.headerLines.map((l) => l.replace(/\s+/g, " ").trim()));

  const seen = new Map<string, BusinessIdEntity>();
  for (const id of businessIds) {
    const digits = digitsOf(id.value);
    if (digits && !seen.has(digits)) seen.set(digits, id);
  }
  const all = [...seen.keys()];
  const ownIds = all.filter((v) => isOwnTaxId(own, v));
  const others = all.filter((v) => !isOwnTaxId(own, v));
  const ownElsewhere = (input.allLines ?? []).some((line) =>
    (line.match(/\d{8,9}/g) ?? []).some((v) => isOwnTaxId(own, v))
  );
  const ownBusinessExcluded = ownIds.length > 0 || input.ownNameExcluded || ownElsewhere;

  if (all.length === 0) {
    return { taxId: null, taxIdSource: null, taxIdValid: null, check: "NO_TAX_ID", ownBusinessExcluded };
  }
  if (others.length === 0) {
    return { taxId: null, taxIdSource: null, taxIdValid: null, check: "OWN_BUSINESS_ONLY", ownBusinessExcluded };
  }

  const sourceOf = (value: string): IssuerTaxIdSource => {
    const line = seen.get(value)?.line ?? "";
    return header.has(line.replace(/\s+/g, " ").trim()) ? "HEADER" : "ONLY_ON_DOCUMENT";
  };

  const anchor = vendorAnchorTaxId(vendor);
  if (anchor && others.includes(anchor)) {
    const valid = authoritativeTaxId(anchor) !== null;
    return {
      taxId: anchor,
      taxIdSource: "VENDOR_LINE",
      taxIdValid: valid,
      check: valid ? "OK" : "TAX_ID_INVALID",
      ownBusinessExcluded,
    };
  }

  const valid = others.filter((v) => authoritativeTaxId(v) !== null);
  if (valid.length === 1) {
    return { taxId: valid[0], taxIdSource: sourceOf(valid[0]), taxIdValid: true, check: "OK", ownBusinessExcluded };
  }
  if (valid.length === 0 && others.length === 1) {
    return {
      taxId: others[0],
      taxIdSource: sourceOf(others[0]),
      taxIdValid: false,
      check: "TAX_ID_INVALID",
      ownBusinessExcluded,
    };
  }
  return { taxId: null, taxIdSource: null, taxIdValid: null, check: "CONFLICTING_TAX_IDS", ownBusinessExcluded };
}

/** The ExtractedData columns of a reading (all five, so a re-read replaces an older one whole). */
export function issuerColumns(reading: IssuerReading) {
  return {
    issuerTaxId: reading.taxId,
    issuerTaxIdSource: reading.taxIdSource,
    issuerTaxIdValid: reading.taxIdValid,
    issuerCheck: reading.check,
    ownBusinessExcluded: reading.ownBusinessExcluded,
  };
}
