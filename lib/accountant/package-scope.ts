/**
 * What belongs in an accountant package for one period, and whether it is ready — pure.
 *
 * SOURCES (decided in the 2026-10-21 audit; nothing here recomputes an accounting figure)
 *   scanned   approved FinancialRecord rows (the owner's approved documents), by `date`.
 *   issued    BillingDocument rows the business issued itself: ISSUED, not QUOTE, by `issuedAt`.
 *             Credit notes are listed as their own type; nothing is netted or summed across types.
 *   pending   Documents still `needs_review` / `processing` / `failed` that may belong to the period
 *             (their extracted date when one exists, otherwise their upload time). Listed, never
 *             included as financial rows.
 * Deliberately left out: FinancialEvent (a projection of invoices and payments), PaymentTransaction /
 * settlements (already present as the system-issued RECEIPT), payables and purchases (not tax
 * documents), the legacy FinancialDocument model (unused).
 *
 * READINESS
 *   A package is READY only when nothing blocks it. Blockers: documents still waiting for review,
 *   issued documents whose final PDF is not available, original files missing from storage (known
 *   after a build). Warnings never block: a record whose date was taken from the upload time, and a
 *   scanned income document that looks like one the business issued itself. No status here claims
 *   that the accounting is complete — only that Dubiz has nothing open for this period.
 *
 * FINGERPRINT
 *   sha256 over a canonical, sorted list of everything the package would contain. Two evaluations
 *   with the same fingerprint would produce the same package; a different fingerprint means a new
 *   version (and, after a send, "changed since sent").
 */

import { createHash } from "node:crypto";

export type ScannedRecordFact = {
  id: number;
  documentId: number;
  amount: number;
  date: Date;
  direction: string;
  category: string;
  vendorName: string;
  /** Upload time of the source document — equal to `date` only when approval had no date to use. */
  documentCreatedAt: Date;
  documentStatus: string;
  fileUrl: string | null;
  /**
   * sha256 of the original file as it was ingested (Document.contentHashSha256), when known. The package
   * builder checks the stored object against it; documents ingested before the hash existed carry none.
   * Deliberately NOT part of the content fingerprint, so adding it never re-marks an existing package.
   */
  fileSha256?: string | null;
  /** The extraction's confidence, shown in the report (label wins over score). */
  confidenceLabel?: string | null;
  confidenceScore?: number | null;
};

export type IssuedPdfState =
  /** A final PDF exists and may be handed out (rendered, or signed when signing is active). */
  | { available: true; storageKey: string; sha256: string }
  /** Not available: why, as a short code. */
  | { available: false; reason: IssuedPdfUnavailableReason };

export type IssuedPdfUnavailableReason =
  | "NOT_RENDERED"
  | "RENDER_FAILED"
  | "NOT_SIGNED"
  | "AUTHORITY_NOT_DELIVERABLE";

export type IssuedDocumentFact = {
  id: number;
  documentType: string;
  documentNumberFormatted: string | null;
  issuedAt: Date;
  /** Decimal strings exactly as stored (18,2) — never converted through a float. */
  subtotalAmount: string;
  vatAmount: string;
  totalAmount: string;
  currency: string;
  customerName: string | null;
  referenceDocumentId: number | null;
  pdf: IssuedPdfState;
};

export type PendingDocumentFact = {
  id: number;
  status: string;
  createdAt: Date;
  extractedDate: Date | null;
};

export type BusinessIdentityFact = {
  legalName: string | null;
  taxId: string | null;
};

export type PeriodFacts = {
  scanned: ScannedRecordFact[];
  issued: IssuedDocumentFact[];
  pending: PendingDocumentFact[];
  identity: BusinessIdentityFact;
};

export type Blocker =
  | { kind: "DOCUMENTS_PENDING_REVIEW"; count: number; documentIds: number[] }
  | { kind: "ISSUED_PDF_UNAVAILABLE"; count: number; billingDocumentIds: number[] }
  | { kind: "ORIGINAL_FILES_MISSING"; count: number; documentIds: number[] }
  /** The stored original does not hash to the sha256 recorded when it was ingested — not shipped. */
  | { kind: "ORIGINAL_FILE_MISMATCH"; count: number; documentIds: number[] };

export type Warning =
  | { kind: "DATE_FROM_UPLOAD_TIME"; count: number; recordIds: number[] }
  | { kind: "POSSIBLE_DUPLICATE_INCOME"; count: number; pairs: { recordId: number; billingDocumentId: number }[] }
  /** Originals shipped without a recorded sha256 to check them against (ingested before hashing existed). */
  | { kind: "ORIGINAL_NOT_VERIFIED"; count: number; documentIds: number[] };

/** One total per issued document type AND currency: amounts of different currencies are never added. */
export type IssuedTypeTotal = { documentType: string; currency: string; count: number; totalAmount: string; vatAmount: string };

export type ReadinessCounts = {
  scannedExpense: number;
  scannedIncome: number;
  issued: number;
  pending: number;
};

export type Readiness = {
  status: "READY" | "NEEDS_ATTENTION";
  blockers: Blocker[];
  warnings: Warning[];
  counts: ReadinessCounts;
  issuedTotals: IssuedTypeTotal[];
  fingerprint: string;
};

/** Days on either side within which a scanned income record and an issued document are "the same sale". */
export const DUPLICATE_DATE_WINDOW_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Money as integer agorot (exact for the 2-decimal columns; no float arithmetic) ───────────────

export function decimalToCents(value: string): bigint {
  const s = value.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error("invalid_decimal");
  const cents = BigInt(m[2]) * BigInt(100) + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] ? -cents : cents;
}

export function centsToDecimal(cents: bigint): string {
  const negative = cents < BigInt(0);
  const abs = negative ? -cents : cents;
  const whole = abs / BigInt(100);
  const frac = (abs % BigInt(100)).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

function floatToCents(amount: number): bigint {
  return BigInt(Math.round(amount * 100));
}

// ── Heuristics (warnings only — they never remove or change a row) ─────────────────────────────

/** Approval fills a missing date with the document's upload time; nothing else produces equal instants. */
export function dateTakenFromUpload(record: Pick<ScannedRecordFact, "date" | "documentCreatedAt">): boolean {
  return record.date.getTime() === record.documentCreatedAt.getTime();
}

/** Company-form suffixes dropped before comparing names (`\b` does not see Hebrew, so tokens are used). */
const NAME_SUFFIXES = new Set(["בעמ", "ltd", "limited", "inc"]);

function normalizeName(value: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/["'׳״`]/g, "")
    .replace(/[.,()\-–—_/\\]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !NAME_SUFFIXES.has(token))
    .join(" ");
}

const DUPLICATE_ELIGIBLE_TYPES = new Set(["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "RECEIPT"]);

/**
 * A scanned INCOME record that looks like a document the business issued itself: same amount (to the
 * agora) within ±3 days of an issued invoice / receipt, or a vendor name equal to the business's own
 * legal name or tax id. Each issued document is matched at most once.
 */
export function findPossibleDuplicateIncome(
  scanned: ScannedRecordFact[],
  issued: IssuedDocumentFact[],
  identity: BusinessIdentityFact
): { recordId: number; billingDocumentId: number }[] {
  const ownName = normalizeName(identity.legalName);
  const ownTaxId = (identity.taxId ?? "").replace(/\D/g, "");
  const candidates = issued
    .filter((d) => DUPLICATE_ELIGIBLE_TYPES.has(d.documentType))
    .slice()
    .sort((a, b) => a.id - b.id);
  const used = new Set<number>();
  const pairs: { recordId: number; billingDocumentId: number }[] = [];

  for (const r of scanned.slice().sort((a, b) => a.id - b.id)) {
    if (r.direction !== "income") continue;
    const cents = floatToCents(r.amount);
    const byAmount = candidates.find(
      (d) =>
        !used.has(d.id) &&
        decimalToCents(d.totalAmount) === cents &&
        Math.abs(d.issuedAt.getTime() - r.date.getTime()) <= DUPLICATE_DATE_WINDOW_DAYS * DAY_MS
    );
    if (byAmount) {
      used.add(byAmount.id);
      pairs.push({ recordId: r.id, billingDocumentId: byAmount.id });
      continue;
    }
    const vendor = normalizeName(r.vendorName);
    const vendorDigits = r.vendorName.replace(/\D/g, "");
    const namesOwn = ownName.length >= 2 && vendor === ownName;
    const taxIdOwn = ownTaxId.length >= 8 && vendorDigits === ownTaxId;
    if (namesOwn || taxIdOwn) {
      const sameAmount = candidates.find((d) => !used.has(d.id) && decimalToCents(d.totalAmount) === cents);
      if (sameAmount) {
        used.add(sameAmount.id);
        pairs.push({ recordId: r.id, billingDocumentId: sameAmount.id });
      }
    }
  }
  return pairs;
}

// ── Totals per issued document type and currency (never summed across types or currencies) ──────

const ISSUED_TYPE_ORDER = ["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "RECEIPT", "CREDIT_NOTE"];

export function issuedTotalsByType(issued: IssuedDocumentFact[]): IssuedTypeTotal[] {
  // Keyed by type + currency, so every sum below adds amounts of ONE currency only.
  const acc = new Map<string, { documentType: string; currency: string; count: number; total: bigint; vat: bigint }>();
  for (const d of issued) {
    const currency = d.currency || "ILS";
    const key = `${d.documentType}|${currency}`;
    const cur = acc.get(key) ?? { documentType: d.documentType, currency, count: 0, total: BigInt(0), vat: BigInt(0) };
    cur.count += 1;
    cur.total += decimalToCents(d.totalAmount);
    cur.vat += decimalToCents(d.vatAmount);
    acc.set(key, cur);
  }
  const rank = (t: string) => {
    const i = ISSUED_TYPE_ORDER.indexOf(t);
    return i === -1 ? ISSUED_TYPE_ORDER.length : i;
  };
  // ILS first within a type, then the other currencies alphabetically.
  const curRank = (c: string) => (c === "ILS" ? "" : c);
  return [...acc.values()]
    .sort((a, b) => rank(a.documentType) - rank(b.documentType) || a.documentType.localeCompare(b.documentType) || curRank(a.currency).localeCompare(curRank(b.currency)))
    .map((v) => ({
      documentType: v.documentType,
      currency: v.currency,
      count: v.count,
      totalAmount: centsToDecimal(v.total),
      vatAmount: centsToDecimal(v.vat),
    }));
}

// ── Fingerprint ─────────────────────────────────────────────────────────────────────────────────

export const FINGERPRINT_VERSION = "acct-pkg.v1";

function pdfToken(pdf: IssuedPdfState): string {
  return pdf.available ? `pdf=${pdf.sha256}` : `pdf-missing=${pdf.reason}`;
}

export function computeFingerprint(facts: PeriodFacts): string {
  const lines: string[] = [];
  for (const r of facts.scanned) {
    lines.push(
      [
        "fr",
        r.id,
        r.documentId,
        floatToCents(r.amount).toString(),
        r.date.toISOString(),
        r.direction,
        r.category,
        r.vendorName,
        r.fileUrl ?? "",
        r.documentStatus,
        r.confidenceLabel ?? "",
        r.confidenceScore ?? "",
      ].join("|")
    );
  }
  for (const d of facts.issued) {
    lines.push(
      [
        "bd",
        d.id,
        d.documentType,
        d.documentNumberFormatted ?? "",
        d.issuedAt.toISOString(),
        d.subtotalAmount,
        d.vatAmount,
        d.totalAmount,
        d.currency,
        d.customerName ?? "",
        d.referenceDocumentId ?? "",
        pdfToken(d.pdf),
      ].join("|")
    );
  }
  for (const p of facts.pending) {
    lines.push(["pd", p.id, p.status].join("|"));
  }
  lines.sort();
  return createHash("sha256")
    .update(`${FINGERPRINT_VERSION}\n${lines.join("\n")}`, "utf8")
    .digest("hex");
}

// ── Readiness ───────────────────────────────────────────────────────────────────────────────────

function sortedIds(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * Evaluates one period. `missingOriginalDocumentIds` comes from the last build (storage is only known
 * then); pass an empty list before the first build.
 */
export function evaluateReadiness(
  facts: PeriodFacts,
  missingOriginalDocumentIds: number[] = [],
  originals: { mismatchedDocumentIds?: number[]; unverifiedDocumentIds?: number[] } = {}
): Readiness {
  const blockers: Blocker[] = [];
  const warnings: Warning[] = [];

  if (facts.pending.length > 0) {
    const ids = sortedIds(facts.pending.map((p) => p.id));
    blockers.push({ kind: "DOCUMENTS_PENDING_REVIEW", count: ids.length, documentIds: ids });
  }
  const unavailable = facts.issued.filter((d) => !d.pdf.available);
  if (unavailable.length > 0) {
    const ids = sortedIds(unavailable.map((d) => d.id));
    blockers.push({ kind: "ISSUED_PDF_UNAVAILABLE", count: ids.length, billingDocumentIds: ids });
  }
  if (missingOriginalDocumentIds.length > 0) {
    const ids = sortedIds(missingOriginalDocumentIds);
    blockers.push({ kind: "ORIGINAL_FILES_MISSING", count: ids.length, documentIds: ids });
  }
  if (originals.mismatchedDocumentIds && originals.mismatchedDocumentIds.length > 0) {
    const ids = sortedIds([...new Set(originals.mismatchedDocumentIds)]);
    blockers.push({ kind: "ORIGINAL_FILE_MISMATCH", count: ids.length, documentIds: ids });
  }

  const uploadDated = facts.scanned.filter(dateTakenFromUpload);
  if (uploadDated.length > 0) {
    const ids = sortedIds(uploadDated.map((r) => r.id));
    warnings.push({ kind: "DATE_FROM_UPLOAD_TIME", count: ids.length, recordIds: ids });
  }
  const duplicates = findPossibleDuplicateIncome(facts.scanned, facts.issued, facts.identity);
  if (duplicates.length > 0) {
    warnings.push({ kind: "POSSIBLE_DUPLICATE_INCOME", count: duplicates.length, pairs: duplicates });
  }
  if (originals.unverifiedDocumentIds && originals.unverifiedDocumentIds.length > 0) {
    const ids = sortedIds([...new Set(originals.unverifiedDocumentIds)]);
    warnings.push({ kind: "ORIGINAL_NOT_VERIFIED", count: ids.length, documentIds: ids });
  }

  return {
    status: blockers.length === 0 ? "READY" : "NEEDS_ATTENTION",
    blockers,
    warnings,
    counts: {
      scannedExpense: facts.scanned.filter((r) => r.direction !== "income").length,
      scannedIncome: facts.scanned.filter((r) => r.direction === "income").length,
      issued: facts.issued.length,
      pending: facts.pending.length,
    },
    issuedTotals: issuedTotalsByType(facts.issued),
    fingerprint: computeFingerprint(facts),
  };
}

/** Total number of open items a sending approval must acknowledge (D2). */
export function openItemCount(readiness: Pick<Readiness, "blockers">): number {
  return readiness.blockers.reduce((n, b) => n + b.count, 0);
}
