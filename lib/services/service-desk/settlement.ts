/**
 * Service Desk 1.3c — the balance a handover reads, as a contract (agreed shape with the billing session, 2026-11-11,
 * v2 after the owner's billing model; nothing in billing changes here).
 *
 * Billing owns fiscal documents, payments, their allocation, credits and per-document outstanding. The service side owns
 * the case's charge (agreed price, or an explicit "no charge" with a reason), the link from a case to billing document
 * ids, and the per-case balance computed from both. The absence of an invoice is never read as "no debt".
 *
 *   NO_CHARGE              the owner marked the case free of charge, with a reason  → delivery may proceed (0)
 *   SETTLED                a charge exists and is fully paid                       → delivery may proceed (0)
 *   OPEN                   documented charge, open balance > 0 (integer agorot)    → only with the owner's reason (ש4)
 *   CHARGE_NOT_DOCUMENTED  a charge agreed on the service side, no charge document → the remainder (agreed − linked
 *                          yet (the normal case for an exempt dealer)                receipts) is a debt: > 0 only with
 *                                                                                   the owner's reason; never 0 by default
 *   UNKNOWN                no charge decision / no link, a draft, a foreign        → delivery BLOCKED (BALANCE_UNKNOWN)
 *                          currency, a read error
 *
 * Billing's rules (payment-document-authority): ISSUED documents only; outstanding = total − allocated − credited;
 * unapplied money never reduces a case; drafts → UNKNOWN / DRAFT_PENDING; ILS only (else UNKNOWN / FOREIGN_CURRENCY).
 * The read runs inside the caller's tenant transaction, under the case lock.
 *
 * Until the service side records a charge decision and links billing documents (both need a service migration, owner
 * approval pending; billing stays untouched) the only honest answer is UNKNOWN / NOT_LINKED — today's only reader.
 */
import type { Prisma } from "@prisma/client";

import type { ServiceCaseContext } from "./contracts";

export type ServiceCaseSettlement =
  | { state: "NO_CHARGE"; openBalanceAgorot: 0 }
  | { state: "SETTLED"; openBalanceAgorot: 0 }
  | { state: "OPEN"; openBalanceAgorot: number }
  | { state: "CHARGE_NOT_DOCUMENTED"; openBalanceAgorot: number }
  | { state: "UNKNOWN"; openBalanceAgorot: null; reason: "NOT_LINKED" | "DRAFT_PENDING" | "FOREIGN_CURRENCY" | "READ_ERROR" };

export type SettlementReader = (tx: Prisma.TransactionClient, businessId: number, caseId: number) => Promise<ServiceCaseSettlement>;

/** Today's reader: no charge decision and no billing link exist yet, so the balance is not known. */
export const readSettlementNotLinked: SettlementReader = async () => ({ state: "UNKNOWN", openBalanceAgorot: null, reason: "NOT_LINKED" });

/** Pure: the core's view. Anything malformed is "not known" (refuse rather than guess). */
export function settlementForCore(s: ServiceCaseSettlement): ServiceCaseContext["settlement"] {
  switch (s.state) {
    case "NO_CHARGE":
      return s.openBalanceAgorot === 0 ? { known: true, openBalanceAgorot: 0, basis: "NO_CHARGE" } : { known: false };
    case "SETTLED":
      return s.openBalanceAgorot === 0 ? { known: true, openBalanceAgorot: 0, basis: "DOCUMENTED" } : { known: false };
    case "OPEN":
      return Number.isSafeInteger(s.openBalanceAgorot) && s.openBalanceAgorot > 0
        ? { known: true, openBalanceAgorot: s.openBalanceAgorot, basis: "DOCUMENTED" }
        : { known: false };
    case "CHARGE_NOT_DOCUMENTED":
      return Number.isSafeInteger(s.openBalanceAgorot) && s.openBalanceAgorot >= 0
        ? { known: true, openBalanceAgorot: s.openBalanceAgorot, basis: "UNDOCUMENTED" }
        : { known: false };
    default:
      return { known: false };
  }
}
