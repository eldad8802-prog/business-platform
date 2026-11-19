/**
 * Service Desk — the REAL settlement reader (replaces readSettlementNotLinked as runCaseAction's default for DELIVER).
 * SERVER-ONLY. Runs in the caller's tenant transaction, under the case lock (the handover command holds it).
 *
 *   last ServiceCaseCharge record + active ServiceCaseBillingLink rows + billing's readDocumentsSettlement (read-only,
 *   #1102, the same transaction and RLS) → computeCaseBalance (pure) → ServiceCaseSettlement.
 *
 * Fail closed: without the charge tables (migration 20261126090000 not applied) the answer stays UNKNOWN / NOT_LINKED —
 * exactly the reader it replaces; a billing read that throws is UNKNOWN / READ_ERROR. Unknown is never 0.
 *
 * The new tables / enum values are read with raw SQL and casts: the shared Prisma client is not regenerated here.
 */
import type { Prisma } from "@prisma/client";

import { readDocumentsSettlement, type DocumentsSettlement } from "@/lib/services/billing/settlement/read-documents-settlement";

import { computeCaseBalance, type CaseBalance, type CaseBillingLink, type CaseCharge } from "./case-balance";
import type { PreviousCharge } from "./case-charge.core";
import { currentCharge } from "./case-charge.core";
import type { ServiceCaseSettlement, SettlementReader } from "./settlement";

type Tx = Prisma.TransactionClient;

/** The billing reader's per-call cap (read-documents-settlement.ts MAX_IDS). */
const MAX_LINKS = 500;

/** Migration 20261126090000 is present: both tables and the journal's event types. Checked before any read of them. */
export async function chargeSchemaReady(tx: Tx): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (to_regclass('public."ServiceCaseCharge"') IS NOT NULL AND to_regclass('public."ServiceCaseBillingLink"') IS NOT NULL
        AND EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ServiceEventType' AND e.enumlabel = 'charge.recorded')) AS ok`;
  return r[0]?.ok === true;
}

export async function lastCharge(tx: Tx, businessId: number, caseId: number): Promise<PreviousCharge> {
  const r = (await tx.$queryRaw<{ seq: number; mode: string; amountAgorot: number | null }[]>`
    SELECT seq, mode::text AS mode, "amountAgorot" FROM "ServiceCaseCharge"
     WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int ORDER BY seq DESC LIMIT 1`)[0];
  if (!r) return null;
  return { seq: Number(r.seq), mode: r.mode as "CHARGEABLE" | "NO_CHARGE", amountAgorot: r.amountAgorot === null ? null : Number(r.amountAgorot) };
}

export async function activeLinks(tx: Tx, businessId: number, caseId: number): Promise<CaseBillingLink[]> {
  const rows = await tx.$queryRaw<{ billingDocumentId: number; role: string }[]>`
    SELECT "billingDocumentId", role::text AS role FROM "ServiceCaseBillingLink"
     WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int AND "unlinkedAt" IS NULL ORDER BY id`;
  return rows.map((r) => ({ billingDocumentId: Number(r.billingDocumentId), role: r.role as CaseBillingLink["role"] }));
}

/** Billing's facts for the linked documents (an empty list when none), or null when they cannot be read. */
export async function billingFacts(tx: Tx, businessId: number, links: readonly CaseBillingLink[]): Promise<DocumentsSettlement | null> {
  if (links.length > MAX_LINKS) return null;
  try {
    // AFTER_SALE_CREDIT links are T7 evidence, never part of the balance: their documents are not read here
    return await readDocumentsSettlement(tx, businessId, links.filter((l) => l.role !== "AFTER_SALE_CREDIT").map((l) => l.billingDocumentId));
  } catch {
    return null;
  }
}

/** The full balance (with its detail, for the owner's screen) from facts already read in this transaction. */
export function balanceOf(charge: CaseCharge, links: readonly CaseBillingLink[], facts: DocumentsSettlement | null): CaseBalance {
  if (facts === null) {
    return { state: "UNKNOWN", openBalanceAgorot: null, reason: "READ_ERROR", detail: { chargeAgorot: charge?.mode === "CHARGEABLE" ? charge.amountAgorot : null, documentedAgorot: null, paidAgorot: null, overpaidAgorot: 0 } };
  }
  return computeCaseBalance(charge, links, facts);
}

/** The handover's contract shape: the balance without its explanation. */
export function settlementOf(b: CaseBalance): ServiceCaseSettlement {
  const s: Partial<CaseBalance> = { ...b };
  delete s.detail;
  return s as ServiceCaseSettlement;
}

export async function readCaseBalance(tx: Tx, businessId: number, caseId: number): Promise<CaseBalance> {
  const charge = currentCharge(await lastCharge(tx, businessId, caseId));
  const links = await activeLinks(tx, businessId, caseId);
  return balanceOf(charge, links, await billingFacts(tx, businessId, links));
}

export const readCaseSettlement: SettlementReader = async (tx, businessId, caseId) => {
  if (!(await chargeSchemaReady(tx))) return { state: "UNKNOWN", openBalanceAgorot: null, reason: "NOT_LINKED" };
  return settlementOf(await readCaseBalance(tx, businessId, caseId));
};
