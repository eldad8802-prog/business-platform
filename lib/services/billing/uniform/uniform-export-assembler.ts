/**
 * WP1 — Pure Uniform Export Assembler.
 *
 * Read-only, deterministic projection from already-loaded immutable billing
 * facts into an internal structured set (NOT a final file).
 *
 * Hard guarantees (enforced by design + tests):
 *  - PURE: no I/O, no prisma, no env, no Date.now()/now-of-generation, no OAuth.
 *  - DETERMINISTIC: same input → byte-identical JSON output (stable sorting,
 *    decimal-string math).
 *  - NEVER fabricates data: missing fields become `warnings`, not guesses.
 *  - NEVER invents an allocation number: `allocationNumber` is copied only when
 *    present in the input; otherwise null + source NONE.
 *  - Only ISSUED, non-QUOTE documents within the period are included.
 *
 * This is NOT the official "מבנה אחיד" serializer. No layout/encoding here.
 */

import { deriveAllocationNumber } from "@/lib/services/billing/billing-allocation-number";
import { sumDecimal2 } from "@/lib/services/billing/uniform/uniform-decimal";
import {
  UNIFORM_EXPORT_PROJECTION_SCHEMA_VERSION,
  type AllocationSource,
  type RecordSource,
  type UniformDocumentInput,
  type UniformDocumentRecord,
  type UniformExportAssemblerInput,
  type UniformExportProjection,
  type UniformLineRecord,
  type UniformPaymentRecord,
  type UniformWarning,
} from "@/lib/services/billing/uniform/uniform-export.types";

/** Document statuses eligible for the books export. */
const INCLUDED_STATUS = "ISSUED";
/** Document types excluded from the books export (quotes are not books records). */
const EXCLUDED_TYPES = new Set(["QUOTE"]);

// Deterministic decimal(2) summation is provided by the shared single source
// `uniform-decimal.ts` (integer-agorot math). Imported above as `sumDecimal2`.

function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

function inPeriod(issuedAtIso: string | null, startIso: string, endIso: string): boolean {
  if (!issuedAtIso) return false;
  const t = Date.parse(issuedAtIso);
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(t) || Number.isNaN(start) || Number.isNaN(end)) return false;
  return t >= start && t <= end;
}

// ---- per-document projection ----

function resolveAllocation(doc: UniformDocumentInput): {
  allocationNumber: string | null;
  allocationSource: AllocationSource;
} {
  // Preference: frozen snapshot first, then live column. Copy ONLY when present.
  // §2.2.1: the designated report field carries the 9 right-most digits, not the
  // full confirmation_number. Fail-closed: a value that cannot yield 9 digits is
  // treated as NONE rather than exported verbatim.
  const snap = nonEmpty(doc.issuedSnapshot?.document?.allocationNumber ?? null);
  if (snap) {
    const derived = deriveAllocationNumber(snap);
    if (derived) return { allocationNumber: derived, allocationSource: "ISSUED_SNAPSHOT" };
  }
  const live = nonEmpty(doc.allocationNumber);
  if (live) {
    const derived = deriveAllocationNumber(live);
    if (derived) return { allocationNumber: derived, allocationSource: "LIVE_COLUMN" };
  }
  return { allocationNumber: null, allocationSource: "NONE" };
}

function projectDocument(doc: UniformDocumentInput): {
  record: UniformDocumentRecord;
  lines: UniformLineRecord[];
  payments: UniformPaymentRecord[];
  warnings: UniformWarning[];
} {
  const warnings: UniformWarning[] = [];
  const ref = String(doc.documentNumberFormatted ?? doc.documentNumber ?? doc.id);
  const snapshot = doc.issuedSnapshot;
  const source: RecordSource = snapshot ? "ISSUED_SNAPSHOT" : "LIVE_COLUMNS";

  if (!snapshot) {
    warnings.push({
      code: "DOC_MISSING_ISSUED_SNAPSHOT",
      scope: "document",
      ref,
      message: "Issued document has no frozen snapshot; projecting from live columns.",
    });
  }
  if (!doc.lockedAt) {
    warnings.push({
      code: "DOC_ISSUED_WITHOUT_LOCK",
      scope: "document",
      ref,
      message: "Issued document is missing lockedAt.",
    });
  }
  if (!nonEmpty(doc.legalSnapshotHash)) {
    warnings.push({
      code: "DOC_MISSING_LEGAL_HASH",
      scope: "document",
      ref,
      message: "Issued document is missing legalSnapshotHash.",
    });
  }

  const currency = nonEmpty(snapshot?.document?.currency) ?? nonEmpty(doc.currency) ?? "ILS";
  const subtotal = nonEmpty(snapshot?.totals?.subtotal) ?? doc.subtotalAmount;
  const vat = nonEmpty(snapshot?.totals?.vat) ?? doc.vatAmount;
  const total = nonEmpty(snapshot?.totals?.total) ?? doc.totalAmount;

  const customer = snapshot?.customer ?? doc.customer ?? null;
  if (!customer) {
    warnings.push({
      code: "DOC_MISSING_CUSTOMER",
      scope: "customer",
      ref,
      message: "Document has no customer identity.",
    });
  } else if (!nonEmpty(customer.taxId)) {
    warnings.push({
      code: "CUSTOMER_MISSING_TAX_ID",
      scope: "customer",
      ref,
      message: "Customer has no tax id (ע.מ./ח.פ./ת.ז.).",
    });
  }

  const { allocationNumber, allocationSource } = resolveAllocation(doc);

  // Lines: snapshot first, then live. (Frozen snapshot is the legal truth.)
  const lineSource = snapshot?.lines && snapshot.lines.length > 0 ? snapshot.lines : doc.lines;
  if (lineSource.length === 0) {
    warnings.push({
      code: "DOC_NO_LINES",
      scope: "line",
      ref,
      message: "Document has no lines.",
    });
  }
  const lines: UniformLineRecord[] = [...lineSource]
    .sort((a, b) => a.lineIndex - b.lineIndex)
    .map((l) => ({ documentId: doc.id, ...l }));

  // Payments come from live receipt-payment rows (not in the snapshot shape).
  const payments: UniformPaymentRecord[] = [...doc.payments]
    .sort((a, b) => a.lineIndex - b.lineIndex)
    .map((p) => ({ documentId: doc.id, ...p }));

  if (
    (doc.documentType === "RECEIPT" || doc.documentType === "TAX_INVOICE_RECEIPT") &&
    payments.length === 0
  ) {
    warnings.push({
      code: "RECEIPT_WITHOUT_PAYMENTS",
      scope: "payment",
      ref,
      message: "Receipt-type document has no payment rows.",
    });
  }

  const record: UniformDocumentRecord = {
    documentId: doc.id,
    documentType: doc.documentType,
    documentNumber: doc.documentNumber,
    documentNumberFormatted:
      nonEmpty(snapshot?.document?.numberFormatted) ?? doc.documentNumberFormatted,
    issuedAt: doc.issuedAt,
    currency,
    subtotal,
    vat,
    total,
    allocationNumber,
    allocationSource,
    legalSnapshotHash: nonEmpty(doc.legalSnapshotHash),
    customer,
    lineCount: lines.length,
    paymentCount: payments.length,
    source,
  };

  return { record, lines, payments, warnings };
}

// ---- entry point ----

export function assembleUniformExportProjection(
  input: UniformExportAssemblerInput
): UniformExportProjection {
  const warnings: UniformWarning[] = [];
  const excluded: { documentId: number; reason: string }[] = [];

  // Business-identity coverage warnings — reported, never filled in.
  const biz = input.business;
  const requiredBiz: Array<[keyof typeof biz, string]> = [
    ["billingLegalName", "BUSINESS_MISSING_LEGAL_NAME"],
    ["billingTaxId", "BUSINESS_MISSING_TAX_ID"],
    ["billingAddress", "BUSINESS_MISSING_ADDRESS"],
  ];
  for (const [field, code] of requiredBiz) {
    if (!nonEmpty(biz[field] as string | null)) {
      warnings.push({
        code,
        scope: "business",
        ref: String(biz.businessId),
        message: `Business is missing ${String(field)}.`,
      });
    }
  }

  // Filter to included documents (deterministic order by id).
  const sortedDocs = [...input.documents].sort((a, b) => a.id - b.id);
  const included: UniformDocumentInput[] = [];
  for (const doc of sortedDocs) {
    if (doc.status !== INCLUDED_STATUS) {
      excluded.push({ documentId: doc.id, reason: `NOT_ISSUED:${doc.status}` });
      continue;
    }
    if (EXCLUDED_TYPES.has(doc.documentType)) {
      excluded.push({ documentId: doc.id, reason: `EXCLUDED_TYPE:${doc.documentType}` });
      continue;
    }
    if (!inPeriod(doc.issuedAt, input.period.start, input.period.end)) {
      excluded.push({ documentId: doc.id, reason: "OUT_OF_PERIOD" });
      continue;
    }
    included.push(doc);
  }

  const documentRecords: UniformDocumentRecord[] = [];
  const lineRecords: UniformLineRecord[] = [];
  const paymentRecords: UniformPaymentRecord[] = [];

  for (const doc of included) {
    const projected = projectDocument(doc);
    documentRecords.push(projected.record);
    lineRecords.push(...projected.lines);
    paymentRecords.push(...projected.payments);
    warnings.push(...projected.warnings);
  }

  const byDocumentType: Record<string, number> = {};
  for (const r of documentRecords) {
    byDocumentType[r.documentType] = (byDocumentType[r.documentType] ?? 0) + 1;
  }

  const totals = {
    documentCount: documentRecords.length,
    lineCount: lineRecords.length,
    paymentCount: paymentRecords.length,
    byDocumentType,
    sumTotal: sumDecimal2(documentRecords.map((r) => r.total)),
    sumVat: sumDecimal2(documentRecords.map((r) => r.vat)),
    withAllocationCount: documentRecords.filter((r) => r.allocationNumber != null).length,
  };

  return {
    schemaVersion: UNIFORM_EXPORT_PROJECTION_SCHEMA_VERSION,
    business: input.business,
    period: { start: input.period.start, end: input.period.end },
    documentRecords,
    lineRecords,
    paymentRecords,
    totals,
    warnings,
    excluded,
  };
}
