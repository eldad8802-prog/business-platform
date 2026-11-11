/**
 * Service Desk 1.3c — the balance a handover reads, as a contract the billing core will implement (agreed shape with the
 * billing session, 2026-11-11; nothing in billing changes here).
 *
 *   SETTLED            known, 0                       → delivery may proceed
 *   OPEN               known, > 0 (integer agorot)    → delivery only with the owner's reason (decision ש4)
 *   UNKNOWN            cannot be established          → delivery BLOCKED (BALANCE_UNKNOWN) — never read as 0
 *   NO_CHARGE_DOCUMENT an explicit "no charge" record → delivery BLOCKED until the owner decides how to treat it
 *
 * Billing's rules (its own core, payment-document-authority): issued tax invoices only; outstanding = total − issued
 * credit notes referencing it − allocated payments; unapplied customer money never reduces a case; drafts → UNKNOWN /
 * DRAFT_PENDING; ILS only (anything else UNKNOWN / FOREIGN_CURRENCY); "no charge" only from an explicit record, never
 * from the absence of documents. The read runs inside the caller's tenant transaction, under the case lock.
 *
 * Until billing links a document to a service case (owner decision pending; A0 + migration on billing's side) the only
 * honest answer is UNKNOWN / NOT_LINKED — which is the one reader that exists today. No inference from customer or dates.
 */
import type { Prisma } from "@prisma/client";

import type { ServiceCaseContext } from "./contracts";

export type ServiceCaseSettlement =
  | { state: "SETTLED"; openBalanceAgorot: 0 }
  | { state: "OPEN"; openBalanceAgorot: number }
  | { state: "UNKNOWN"; openBalanceAgorot: null; reason: "NOT_LINKED" | "DRAFT_PENDING" | "FOREIGN_CURRENCY" | "READ_ERROR" }
  | { state: "NO_CHARGE_DOCUMENT"; openBalanceAgorot: null };

export type SettlementReader = (tx: Prisma.TransactionClient, businessId: number, caseId: number) => Promise<ServiceCaseSettlement>;

/** Today's reader: no billing document is linked to a service case yet, so the balance is not known. */
export const readSettlementNotLinked: SettlementReader = async () => ({ state: "UNKNOWN", openBalanceAgorot: null, reason: "NOT_LINKED" });

/** Pure: the core's view. Only SETTLED / OPEN are "known"; UNKNOWN and NO_CHARGE_DOCUMENT keep the handover blocked. */
export function settlementForCore(s: ServiceCaseSettlement): ServiceCaseContext["settlement"] {
  if (s.state === "SETTLED") return { known: true, openBalanceAgorot: 0 };
  if (s.state === "OPEN" && Number.isSafeInteger(s.openBalanceAgorot) && s.openBalanceAgorot > 0) return { known: true, openBalanceAgorot: s.openBalanceAgorot };
  return { known: false };
}
