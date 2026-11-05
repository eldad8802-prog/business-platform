/**
 * A0 — synthetic, deterministic inputs for the characterization of the EXISTING
 * billing documents (TAX_INVOICE, TAX_INVOICE_RECEIPT, RECEIPT, CREDIT_NOTE, QUOTE).
 *
 * Nothing here is real: business, customer, tax ids, amounts and dates are made
 * up. No database, no network, no clock — every value is fixed so the same code
 * produces the same output byte for byte.
 *
 * This file only CALLS the existing billing code through its exported functions.
 * It never changes it.
 */
import { createHash } from "node:crypto";
import {
  BillingDocumentStatus,
  BillingDocumentType,
  BillingPdfRenderStatus,
  Prisma,
  type BillingDocument,
  type BillingDocumentLine,
} from "@prisma/client";
import { recomputeAll } from "../lib/services/billing/totals/billing-totals.service";
import { buildIssuedSnapshot } from "../lib/services/billing/billing-issue.service";
import { buildQuotePdfSnapshot } from "../lib/services/billing/quote-pdf-snapshot";
import type { BillingIssuedSnapshotV1 } from "../lib/services/billing/pdf/billing-pdf-template";

export type IssuedSnapshot = ReturnType<typeof buildIssuedSnapshot>;

const D = (v: string | number) => new Prisma.Decimal(v);

/** sha256 hex of a string or buffer. */
export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Key-sorted JSON — the comparison form for objects (independent of key order). */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Prisma.Decimal) return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
    .join(",")}}`;
}

// ---------------------------------------------------------------------------
// Issuer + customer
// ---------------------------------------------------------------------------

/** 1x1 transparent PNG — a valid data URL, exercises the logo / visual-signature branch. */
export const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export const BUSINESS_ID = 9001;
export const ACTOR_USER_ID = 77;

export type ProfileVariant = "CLASSIC" | "MODERN" | "COMPACT";

export function businessFor(style: ProfileVariant, withImages = false) {
  return {
    id: BUSINESS_ID,
    name: "A0 Synthetic Business",
    profile: {
      billingLegalName: "עסק סינתטי לבדיקות בע\"מ",
      billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998",
      billingVatNumber: "999999998",
      billingPhone: "03-0000000",
      billingEmail: "a0@example.test",
      billingAddress: "רחוב הבדיקה 1, תל אביב",
      billingPaymentNote: "העברה בנקאית: בנק 99, סניף 999, חשבון 123456",
      billingFooterNote: "תודה רבה! מסמך לבדיקה בלבד.",
      billingLogoDataUrl: withImages ? TINY_PNG_DATA_URL : null,
      billingSignatureDataUrl: withImages ? TINY_PNG_DATA_URL : null,
      billingPdfTemplateStyle: style,
    },
  };
}

export const CUSTOMER = {
  id: 501,
  name: "לקוח בדיקה בע\"מ",
  phone: "050-0000000",
  email: "customer@example.test",
  city: "חיפה",
  taxId: "000000018",
};

// ---------------------------------------------------------------------------
// Rows shaped exactly like Prisma's BillingDocument / BillingDocumentLine
// ---------------------------------------------------------------------------

const CREATED = new Date("2026-07-01T08:00:00.000Z");

export function documentRow(over: Partial<BillingDocument> & Pick<BillingDocument, "id" | "documentType">): BillingDocument {
  return {
    businessId: BUSINESS_ID,
    status: BillingDocumentStatus.DRAFT,
    documentNumber: null,
    documentNumberFormatted: null,
    customerId: CUSTOMER.id,
    customerNameSnapshot: CUSTOMER.name,
    validUntil: null,
    convertedToInvoiceId: null,
    subtotalAmount: D(0),
    vatAmount: D(0),
    totalAmount: D(0),
    currency: "ILS",
    issuedAt: null,
    issuedByUserId: null,
    createdByUserId: ACTOR_USER_ID,
    issuedSnapshot: null,
    lockedAt: null,
    legalSnapshotHash: null,
    referenceDocumentId: null,
    allocationNumber: null,
    allocationApprovedAt: null,
    isEmergencyAllocation: false,
    pdfRenderStatus: BillingPdfRenderStatus.PENDING,
    pdfTemplateVersion: null,
    pdfStorageKey: null,
    pdfHash: null,
    pdfRenderedAt: null,
    pdfRenderError: null,
    signedPdfStorageKey: null,
    signedPdfHash: null,
    signedAt: null,
    sourcePaymentTransactionId: null,
    unappliedAmount: D(0),
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

type RawLine = { description: string; quantity: string; unitPrice: string; vatRatePercent: string };

/** Lines computed by the EXISTING totals service — so totals are part of what is pinned. */
export function computedLines(documentId: number, raw: RawLine[]) {
  const parsed = raw.map((l, i) => ({
    description: l.description,
    quantity: D(l.quantity),
    unitPrice: D(l.unitPrice),
    vatRatePercent: D(l.vatRatePercent),
    lineIndex: i + 1,
  }));
  const { lines, totals } = recomputeAll(parsed);
  const rows: BillingDocumentLine[] = lines.map((l, i) => ({
    id: documentId * 100 + i + 1,
    billingDocumentId: documentId,
    lineIndex: l.lineIndex,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    vatRatePercent: l.vatRatePercent,
    lineSubtotal: l.lineSubtotal,
    vatAmount: l.vatAmount,
    lineTotal: l.lineTotal,
    createdAt: CREATED,
    updatedAt: CREATED,
  }));
  return { rows, totals };
}

export const GOODS_LINES: RawLine[] = [
  { description: "שירות ייעוץ חודשי", quantity: "2", unitPrice: "1500", vatRatePercent: "18" },
  { description: "חומרים ואביזרים", quantity: "3.5", unitPrice: "120.40", vatRatePercent: "18" },
  { description: "Delivery fee (משלוח)", quantity: "1", unitPrice: "49.90", vatRatePercent: "18" },
];

/** A credit for part of the invoice: one line, partial quantity. */
export const CREDIT_LINES: RawLine[] = [
  { description: "זיכוי חלקי — שירות ייעוץ חודשי", quantity: "1", unitPrice: "1500", vatRatePercent: "18" },
];

/** Large enough to cross the 2026-H2 allocation threshold (5,000 ILS before VAT). */
export const LARGE_LINES: RawLine[] = [
  { description: "פרויקט התקנה", quantity: "1", unitPrice: "12500", vatRatePercent: "18" },
];

export const ISSUED_AT = new Date("2026-07-15T09:30:00.000Z");

// ---------------------------------------------------------------------------
// The five document types, each frozen through the EXISTING snapshot builders
// ---------------------------------------------------------------------------

export type Case = {
  key: string;
  type: BillingDocumentType;
  snapshot: IssuedSnapshot | BillingIssuedSnapshotV1;
  /** true when built by buildIssuedSnapshot (legal snapshot, hashed at issue). */
  legal: boolean;
};

function issued(
  key: string,
  id: number,
  type: BillingDocumentType,
  number: number,
  raw: RawLine[],
  style: ProfileVariant,
  extra: Partial<BillingDocument> = {},
  withImages = false,
  receiptTotals?: { subtotalAmount: Prisma.Decimal; vatAmount: Prisma.Decimal; totalAmount: Prisma.Decimal }
): Case {
  const { rows, totals } = computedLines(id, raw);
  const document = documentRow({ id, documentType: type, ...extra });
  const snapshot = buildIssuedSnapshot({
    document,
    lines: rows,
    business: businessFor(style, withImages),
    customer: CUSTOMER,
    documentNumber: number,
    documentNumberFormatted: String(number).padStart(6, "0"),
    issuedAt: ISSUED_AT,
    actorUserId: ACTOR_USER_ID,
    totals: receiptTotals ?? totals,
  });
  return { key, type, snapshot, legal: true };
}

export function buildCases(): Case[] {
  const cases: Case[] = [];

  // TAX_INVOICE in all three layout presets; one variant with logo + visual signature.
  cases.push(issued("TAX_INVOICE.classic", 1001, BillingDocumentType.TAX_INVOICE, 12, GOODS_LINES, "CLASSIC"));
  cases.push(issued("TAX_INVOICE.modern", 1002, BillingDocumentType.TAX_INVOICE, 13, GOODS_LINES, "MODERN"));
  cases.push(issued("TAX_INVOICE.compact", 1003, BillingDocumentType.TAX_INVOICE, 14, GOODS_LINES, "COMPACT"));
  cases.push(issued("TAX_INVOICE.images", 1004, BillingDocumentType.TAX_INVOICE, 15, GOODS_LINES, "CLASSIC", {}, true));
  cases.push(issued("TAX_INVOICE.large", 1005, BillingDocumentType.TAX_INVOICE, 16, LARGE_LINES, "CLASSIC"));

  cases.push(issued("TAX_INVOICE_RECEIPT.classic", 2001, BillingDocumentType.TAX_INVOICE_RECEIPT, 3, GOODS_LINES, "CLASSIC"));

  // RECEIPT: no goods lines; totals are the stored ones (money received).
  cases.push(
    issued("RECEIPT.classic", 3001, BillingDocumentType.RECEIPT, 7, [], "CLASSIC", { unappliedAmount: D("0") }, false, {
      subtotalAmount: D("0"),
      vatAmount: D("0"),
      totalAmount: D("1000.00"),
    })
  );
  cases.push(
    issued("RECEIPT.unapplied", 3002, BillingDocumentType.RECEIPT, 8, [], "CLASSIC", { unappliedAmount: D("250.00") }, false, {
      subtotalAmount: D("0"),
      vatAmount: D("0"),
      totalAmount: D("1250.00"),
    })
  );

  cases.push(
    issued("CREDIT_NOTE.classic", 4001, BillingDocumentType.CREDIT_NOTE, 2, CREDIT_LINES, "CLASSIC", {
      referenceDocumentId: 1001,
    })
  );

  // QUOTE: never issued; its PDF snapshot is built by the quote builder.
  {
    const id = 5001;
    const { rows, totals } = computedLines(id, GOODS_LINES);
    const document = documentRow({
      id,
      documentType: BillingDocumentType.QUOTE,
      validUntil: new Date("2026-08-14T21:00:00.000Z"),
    });
    const b = businessFor("CLASSIC");
    const snapshot = buildQuotePdfSnapshot({
      document,
      lines: rows,
      business: b,
      customer: CUSTOMER,
      documentNumber: 4,
      documentNumberFormatted: "000004",
      snapshotDate: ISSUED_AT,
      actorUserId: ACTOR_USER_ID,
      totals,
    });
    cases.push({ key: "QUOTE.classic", type: BillingDocumentType.QUOTE, snapshot, legal: false });
  }

  return cases;
}

/** The PDF path overlays the live allocation number onto the frozen snapshot. */
export function withAllocationNumber<T extends { document: { allocationNumber: string | null } }>(
  snapshot: T,
  allocationNumber: string
): T {
  return { ...snapshot, document: { ...snapshot.document, allocationNumber } };
}

/** Fixed stand-in for the embedded Hebrew font data URI (keeps the HTML small and stable). */
export const FONT_SENTINEL = "data:font/ttf;base64,QTBGT05UU0VOVElORUw=";
