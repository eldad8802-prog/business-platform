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

  const business = (await client.business.findUnique({
    where: { id: args.businessId },
    include: { profile: true },
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
    documents: docRows.map(mapDocument),
  };
}
