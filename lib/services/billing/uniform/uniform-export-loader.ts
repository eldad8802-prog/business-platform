/**
 * WP1 — Read-only loader that shapes existing billing data into the pure
 * assembler input. Uses ONLY read queries (findUnique / findMany). It never
 * writes, never touches OAuth, and never fabricates values.
 *
 * The pure assembler ([uniform-export-assembler.ts]) owns all projection logic;
 * this file is a thin, read-only adapter so the assembler stays testable with
 * plain dummy data.
 */

import { prisma } from "@/lib/prisma";
import type {
  ParsedIssuedSnapshot,
  UniformBaseDocument,
  UniformCustomer,
  UniformDocumentInput,
  UniformExportAssemblerInput,
  UniformLine,
  UniformPayment,
} from "@/lib/services/billing/uniform/uniform-export.types";

/** Minimal read-only surface — injectable so tests never touch a real DB. */
export type UniformExportReadClient = {
  business: {
    findUnique: (args: unknown) => Promise<unknown>;
  };
  billingDocument: {
    findMany: (args: unknown) => Promise<unknown[]>;
  };
};

function decToFixed(value: unknown, digits: number): string {
  if (value == null) return (0).toFixed(digits);
  const maybe = value as { toFixed?: (d: number) => string };
  if (typeof maybe.toFixed === "function") return maybe.toFixed(digits);
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : String(value);
}

function dateToIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function str(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function mapCustomer(row: Record<string, unknown> | null | undefined): UniformCustomer | null {
  if (!row) return null;
  return {
    id: typeof row.id === "number" ? row.id : null,
    name: str(row.name),
    legalName: str(row.legalName),
    taxId: str(row.taxId),
    taxIdType: str(row.taxIdType),
    city: str(row.city),
    phone: str(row.phone),
    email: str(row.email),
  };
}

function mapLine(row: Record<string, unknown>): UniformLine {
  return {
    lineIndex: Number(row.lineIndex ?? 0),
    description: String(row.description ?? ""),
    quantity: decToFixed(row.quantity, 4),
    unitPrice: decToFixed(row.unitPrice, 4),
    vatRatePercent: decToFixed(row.vatRatePercent, 2),
    lineSubtotal: decToFixed(row.lineSubtotal, 2),
    vatAmount: decToFixed(row.vatAmount, 2),
    lineTotal: decToFixed(row.lineTotal, 2),
  };
}

function mapPayment(row: Record<string, unknown>): UniformPayment {
  return {
    lineIndex: Number(row.lineIndex ?? 0),
    method: String(row.method ?? "OTHER"),
    amount: decToFixed(row.amount, 2),
    currency: String(row.currency ?? "ILS"),
    paymentDate: dateToIso(row.paymentDate),
    bankName: str(row.bankName),
    bankBranch: str(row.bankBranch),
    bankAccountNumber: str(row.bankAccountNumber),
    checkNumber: str(row.checkNumber),
    checkDueDate: dateToIso(row.checkDueDate),
    cardBrand: str(row.cardBrand),
    cardLast4: str(row.cardLast4),
    reference: str(row.reference),
  };
}

function mapDocument(row: Record<string, unknown>): UniformDocumentInput {
  const snapshot = (row.issuedSnapshot ?? null) as ParsedIssuedSnapshot | null;
  const lines = Array.isArray(row.lines)
    ? (row.lines as Record<string, unknown>[]).map(mapLine)
    : [];
  const payments = Array.isArray(row.receiptPayments)
    ? (row.receiptPayments as Record<string, unknown>[]).map(mapPayment)
    : [];

  return {
    id: Number(row.id),
    documentType: String(row.documentType),
    status: String(row.status),
    documentNumber: typeof row.documentNumber === "number" ? row.documentNumber : null,
    documentNumberFormatted: str(row.documentNumberFormatted),
    issuedAt: dateToIso(row.issuedAt),
    lockedAt: dateToIso(row.lockedAt),
    currency: String(row.currency ?? "ILS"),
    subtotalAmount: decToFixed(row.subtotalAmount, 2),
    vatAmount: decToFixed(row.vatAmount, 2),
    totalAmount: decToFixed(row.totalAmount, 2),
    allocationNumber: str(row.allocationNumber),
    allocationApprovedAt: dateToIso(row.allocationApprovedAt),
    isEmergencyAllocation: Boolean(row.isEmergencyAllocation),
    legalSnapshotHash: str(row.legalSnapshotHash),
    referenceDocumentId:
      typeof row.referenceDocumentId === "number" ? row.referenceDocumentId : null,
    customer: mapCustomer(row.customer as Record<string, unknown> | null),
    customerNameSnapshot: str(row.customerNameSnapshot),
    lines,
    payments,
    issuedSnapshot: snapshot,
  };
}

/**
 * Reads existing billing data for a business + period and shapes it for the
 * pure assembler. Read-only: only `findUnique` / `findMany` are used. The
 * efficient query already scopes to issued, non-quote, in-period documents;
 * the assembler still re-validates (defense in depth).
 */
export async function loadUniformExportInput(args: {
  businessId: number;
  periodStart: string; // ISO inclusive
  periodEnd: string; // ISO inclusive
  client?: UniformExportReadClient;
}): Promise<UniformExportAssemblerInput> {
  const client = (args.client ?? prisma) as UniformExportReadClient;

  // `name` off Business, and only the seven billing fields the export writes off
  // the profile. `include` pulled every scalar of both, which is part of what
  // keeps the runtime needing table-level SELECT on Business.
  const business = (await client.business.findUnique({
    where: { id: args.businessId },
    select: {
      name: true,
      profile: {
        select: {
          billingLegalName: true,
          billingTaxId: true,
          billingVatNumber: true,
          billingPhone: true,
          billingEmail: true,
          billingAddress: true,
          billingBusinessKind: true,
        },
      },
    },
  })) as Record<string, unknown> | null;

  const profile = (business?.profile ?? {}) as Record<string, unknown>;

  const docRows = (await client.billingDocument.findMany({
    where: {
      businessId: args.businessId,
      status: "ISSUED",
      documentType: { not: "QUOTE" },
      issuedAt: {
        gte: new Date(args.periodStart),
        lte: new Date(args.periodEnd),
      },
    },
    include: { lines: true, receiptPayments: true, customer: true },
    orderBy: { id: "asc" },
  })) as Record<string, unknown>[];

  const documents = docRows.map(mapDocument);

  // A credit note's source invoice (D110 1256 / 1257). The issue path requires an ISSUED TAX_INVOICE of the same
  // business, and the reference is immutable after issue; the source may predate the period, so it is read on its own.
  const refs = [...new Set(documents
    .filter((d) => d.documentType === "CREDIT_NOTE" && d.referenceDocumentId != null)
    .map((d) => d.referenceDocumentId as number))];
  if (refs.length > 0) {
    const sourceRows = (await client.billingDocument.findMany({
      where: { businessId: args.businessId, id: { in: refs }, status: "ISSUED", documentType: "TAX_INVOICE" },
      select: { id: true, documentType: true, status: true, documentNumber: true, documentNumberFormatted: true, issuedSnapshot: true },
    })) as Record<string, unknown>[];
    const byId = new Map<number, UniformBaseDocument>();
    for (const row of sourceRows) {
      const id = Number(row.id);
      // defense in depth: only what the query asked for, whatever the client returned
      if (!refs.includes(id) || row.status !== "ISSUED" || row.documentType !== "TAX_INVOICE") continue;
      const snap = (row.issuedSnapshot ?? null) as ParsedIssuedSnapshot | null;
      const printed = (str(snap?.document?.numberFormatted) ?? str(row.documentNumberFormatted) ?? "").trim()
        || (typeof row.documentNumber === "number" ? String(row.documentNumber) : "");
      if (printed) byId.set(id, { documentId: id, documentType: "TAX_INVOICE", numberPrinted: printed });
    }
    for (const d of documents) {
      if (d.documentType === "CREDIT_NOTE" && d.referenceDocumentId != null) {
        d.baseDocument = byId.get(d.referenceDocumentId) ?? null;
      }
    }
  }

  return {
    businessId: args.businessId,
    period: { start: args.periodStart, end: args.periodEnd },
    business: {
      businessId: args.businessId,
      name: str(business?.name) ?? "",
      billingLegalName: str(profile.billingLegalName),
      billingBusinessKind: str(profile.billingBusinessKind),
      billingTaxId: str(profile.billingTaxId),
      billingVatNumber: str(profile.billingVatNumber),
      billingAddress: str(profile.billingAddress),
      billingPhone: str(profile.billingPhone),
      billingEmail: str(profile.billingEmail),
    },
    documents,
  };
}
