/**
 * State producers A–E — the READ + WRITE half, run by the status sweep once per business (owner decisions
 * 2026-11-13). SERVER-ONLY. Zero domain-code changes: every source is READ, through the domain's own store or its
 * own predicate, never written; amounts, statuses, documents, payments, allocation requests and appointments are
 * untouched. The only writes are Notification / NotificationDelivery rows, through the engine's notify().
 *
 *   A obligations.due              the secretary's REAL store (secretaryStoreMode): legacy BusinessObligation via
 *                                  createObligationPrismaStore, or the payables ledger via createObligationLedgerStore
 *                                  (state DERIVED by toObligationRecord: paid / handled / released ⇒ not OPEN). In
 *                                  legacy mode also the ledger's own commitments (legacyObligationId NULL — the
 *                                  backfilled copies are NOT read twice), which the payables screen shows.
 *   B payments.request_failed      PaymentRequest + its PaymentTransaction statuses, the other requests of the same
 *                                  billing document / customer, and BillingPaymentAllocation (a receipt covered it).
 *   C billing.allocation_failed    BillingAuthoritySubmission (+ the authority's own outcome-uncertain predicate),
 *                                  ONLY when the deployment's authority environment is PRODUCTION and the pilot gate
 *                                  admits the business for the "approval" operation (BILLING_AUTHORITY_PRODUCTION_
 *                                  PILOT_BUSINESS_IDS / _OPERATIONS) — otherwise nothing is read and nothing resolved.
 *   D documents.processing_failed  Document.status = 'failed'.
 *   E appointments.upcoming        Appointment CONFIRMED (not BLOCK, not erased) starting within the lead time.
 *
 * One tenant transaction per business for all five (bounded: one connection, a handful of statements), opened with
 * a transaction-level advisory lock on (namespace, businessId): a second sweep of the same business at the same
 * moment skips the producers instead of doing the same work twice. Each producer runs inside a SAVEPOINT, so one
 * failing read never loses another producer's events. Resolution is per producer, from ITS present keys, only when
 * its read was complete (a capped read resolves nothing), and only among rows of ITS category.
 */
import { getCategory, type CategoryDefinition, type CategoryKey } from "../catalog";
import type { BusinessGates } from "../engine/engine-gate";
import { notify, type NotifyEvent, type NotifyOutcome } from "../engine/notify";
import { businessTimeZone } from "../preferences-store";
import {
  allocationFacts,
  appointmentFacts,
  documentFacts,
  obligationFacts,
  paymentFacts,
  type AllocationSubmissionFact,
  type ObligationFact,
  type PaymentContext,
  type PaymentRequestFact,
  type StateFacts,
} from "./state-facts";
import { tenantTx, type TenantTxClient } from "@/lib/tenant/tenant-tx";
import { createObligationLedgerStore } from "@/lib/services/obligations/obligation-store.ledger";
import { createObligationPrismaStore } from "@/lib/services/obligations/obligation-store.prisma";
import { secretaryStoreMode } from "@/lib/services/obligations/obligations.deps";
import { isAuthorityOutcomeUncertainErrorCode } from "@/lib/services/billing/authority/billing-authority-send-certainty";
import { isAuthorityProductionOperationAllowedForBusiness } from "@/lib/services/billing/authority/billing-authority-production-pilot";

type Tx = TenantTxClient;

export type StateProducerId = "obligations" | "payments" | "allocation" | "documents" | "appointments";

/** A read is complete unless it hit its cap; an incomplete read writes events but resolves nothing. */
export type ProducerRead = { facts: StateFacts; complete: boolean };

export type StateProducer = {
  id: StateProducerId;
  category: CategoryKey;
  read: (tx: Tx, businessId: number, now: Date, ctx: { timeZone: string; category: CategoryDefinition }) => Promise<ProducerRead>;
};

/** Upper bound on any one producer's read. At the cap the read is declared incomplete (never resolves). */
export const STATE_READ_CAP = 2000;

/* ─────────────────────────────────────────────────────────────── readers ── */

async function readObligations(tx: Tx, businessId: number, now: Date, ctx: { timeZone: string }): Promise<ProducerRead> {
  const mode = secretaryStoreMode(); // throws on a malformed switch: the producer errors, nothing resolves
  const rows: ObligationFact[] = [];
  let complete = true;
  const ledger = createObligationLedgerStore(tx, { now: () => now });
  if (mode === "legacy") {
    const legacy = await createObligationPrismaStore(tx).listObligations(businessId, { states: ["OPEN"], limit: STATE_READ_CAP });
    if (legacy.length >= STATE_READ_CAP) complete = false;
    for (const o of legacy) rows.push({ entityType: "business_obligation", id: o.id, state: o.state, dueAt: o.dueAt, followUpAt: o.followUpAt, href: "/secretary" });
    // The ledger's own commitments (created on the payables screen). Backfilled copies of legacy obligations carry
    // legacyObligationId and are the secretary's rows above — never read twice.
    const copied = await tx.commitment.findMany({ where: { businessId, legacyObligationId: { not: null } }, select: { id: true } });
    const copiedIds = new Set(copied.map((c) => c.id));
    const own = await ledger.listObligations(businessId, { states: ["OPEN"], limit: STATE_READ_CAP });
    if (own.length >= STATE_READ_CAP) complete = false;
    for (const o of own) {
      if (o.ledger && copiedIds.has(o.ledger.commitmentId)) continue;
      rows.push({ entityType: "installment", id: o.id, state: o.state, dueAt: o.dueAt, followUpAt: o.followUpAt, href: "/payables" });
    }
  } else {
    const all = await ledger.listObligations(businessId, { states: ["OPEN"], limit: STATE_READ_CAP });
    if (all.length >= STATE_READ_CAP) complete = false;
    for (const o of all) rows.push({ entityType: "installment", id: o.id, state: o.state, dueAt: o.dueAt, followUpAt: o.followUpAt, href: "/secretary" });
  }
  return { facts: obligationFacts(businessId, rows, now, ctx.timeZone), complete };
}

async function readPayments(tx: Tx, businessId: number, now: Date): Promise<ProducerRead> {
  const candidates = await tx.paymentRequest.findMany({
    where: {
      businessId,
      OR: [{ status: "FAILED" }, { status: "EXPIRED" }, { status: "PENDING", expiresAt: { lt: now } }],
    },
    select: {
      id: true, status: true, paymentUrl: true, expiresAt: true, createdAt: true, updatedAt: true, billingDocumentId: true, customerId: true, amount: true,
      transactions: { select: { status: true } },
    },
    orderBy: { id: "asc" },
    take: STATE_READ_CAP,
  });
  const rows: PaymentRequestFact[] = candidates.map((r) => ({
    id: r.id, status: r.status, paymentUrl: r.paymentUrl, expiresAt: r.expiresAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
    billingDocumentId: r.billingDocumentId, customerId: r.customerId, amount: r.amount.toString(),
    transactionStatuses: r.transactions.map((t) => t.status),
  }));
  const docIds = [...new Set(rows.map((r) => r.billingDocumentId).filter((x): x is number => x !== null))];
  const customerIds = [...new Set(rows.filter((r) => r.billingDocumentId === null).map((r) => r.customerId).filter((x): x is number => x !== null))];
  const ctx: PaymentContext = { siblings: [], allocatedDocumentIds: new Set() };
  if (docIds.length > 0 || customerIds.length > 0) {
    const siblings = await tx.paymentRequest.findMany({
      where: { businessId, OR: [...(docIds.length ? [{ billingDocumentId: { in: docIds } }] : []), ...(customerIds.length ? [{ customerId: { in: customerIds }, billingDocumentId: null }] : [])] },
      select: { id: true, status: true, createdAt: true, billingDocumentId: true, customerId: true, amount: true, expiresAt: true },
    });
    ctx.siblings = siblings.map((s) => ({ ...s, amount: s.amount.toString() }));
  }
  if (docIds.length > 0) {
    const allocations = await tx.billingPaymentAllocation.findMany({ where: { businessId, invoiceDocumentId: { in: docIds } }, select: { invoiceDocumentId: true } });
    ctx.allocatedDocumentIds = new Set(allocations.map((a) => a.invoiceDocumentId));
  }
  return { facts: paymentFacts(businessId, rows, ctx, now), complete: candidates.length < STATE_READ_CAP };
}

/** The ITA integration is ON for this business only in a PRODUCTION authority deployment with the pilot admitting it. */
export function allocationIntegrationOn(businessId: number, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  try {
    // The deployment's authority environment (billing-authority-env.service resolveRuntimeAuthorityEnvironment: the
    // same variable, trimmed, case-insensitive). SANDBOX / unset / malformed ⇒ off: no real allocation exists.
    if (env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT?.trim().toUpperCase() !== "PRODUCTION") return false;
    return isAuthorityProductionOperationAllowedForBusiness(businessId, "PRODUCTION", "approval", env);
  } catch {
    return false;
  }
}

async function readAllocations(tx: Tx, businessId: number, now: Date): Promise<ProducerRead> {
  const subs = await tx.billingAuthoritySubmission.findMany({
    where: { businessId, status: { in: ["READY", "PENDING", "SUBMITTED", "FAILED", "REJECTED", "HELD"] } },
    select: { id: true, billingDocumentId: true, status: true, errorCode: true, heldDecisionReportedAt: true, createdAt: true, submittedAt: true, lastAttemptAt: true },
    orderBy: { id: "asc" },
    take: STATE_READ_CAP,
  });
  const rows: AllocationSubmissionFact[] = subs.map((s) => ({
    id: s.id, billingDocumentId: s.billingDocumentId, status: s.status, outcomeUncertain: isAuthorityOutcomeUncertainErrorCode(s.errorCode),
    heldDecisionReportedAt: s.heldDecisionReportedAt, createdAt: s.createdAt, submittedAt: s.submittedAt, lastAttemptAt: s.lastAttemptAt,
  }));
  return { facts: allocationFacts(businessId, rows, now), complete: subs.length < STATE_READ_CAP };
}

async function readDocuments(tx: Tx, businessId: number, now: Date): Promise<ProducerRead> {
  const docs = await tx.document.findMany({
    where: { businessId, status: "failed" },
    select: { id: true, status: true },
    orderBy: { id: "asc" },
    take: STATE_READ_CAP,
  });
  return { facts: documentFacts(businessId, docs, now), complete: docs.length < STATE_READ_CAP };
}

async function readAppointments(tx: Tx, businessId: number, now: Date, ctx: { timeZone: string; category: CategoryDefinition }): Promise<ProducerRead> {
  const rows = await tx.appointment.findMany({
    where: { businessId, status: "CONFIRMED", erasedAt: null, kind: { not: "BLOCK" }, startsAt: { gt: now, lte: new Date(now.getTime() + 60 * 60_000) } },
    select: { id: true, status: true, kind: true, startsAt: true, erasedAt: true },
    orderBy: { id: "asc" },
    take: STATE_READ_CAP,
  });
  return { facts: appointmentFacts(businessId, rows, now, ctx.timeZone, ctx.category.ttlMinutes), complete: rows.length < STATE_READ_CAP };
}

export const STATE_PRODUCERS: readonly StateProducer[] = [
  { id: "obligations", category: "obligations.due", read: readObligations },
  { id: "payments", category: "payments.request_failed", read: readPayments },
  { id: "allocation", category: "billing.allocation_failed", read: readAllocations },
  { id: "documents", category: "documents.processing_failed", read: readDocuments },
  { id: "appointments", category: "appointments.upcoming", read: readAppointments },
];

/* ──────────────────────────────────────────────────────────────── runner ── */

export type StateProducersReport = {
  /** Another sweep held this business's lock: producers skipped (nothing lost — the next pass reads the state again). */
  leaseBusy: boolean;
  ran: number;
  unavailable: number;
  incomplete: number;
  failed: number;
  events: number;
  notified: number;
  owedPush: number;
  resolved: number;
};

export type StateProducerDeps = {
  tenantTx: <T>(businessId: number, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  notify: (tx: Tx, e: NotifyEvent) => Promise<NotifyOutcome>;
  /** Is the ITA integration on for this business (C only)? */
  allocationOn: (businessId: number) => boolean;
  producers: readonly StateProducer[];
};

export const defaultStateProducerDeps: StateProducerDeps = {
  tenantTx: (businessId, fn) => tenantTx(businessId, fn, { timeoutMs: 20_000 }),
  notify,
  allocationOn: (businessId) => allocationIntegrationOn(businessId),
  producers: STATE_PRODUCERS,
};

/** Advisory-lock namespace of the sweep's per-business apply transaction (pg_try_advisory_xact_lock(int, int)). */
export const SWEEP_LOCK_NAMESPACE = 0x4e5436; // "NT6"

/** Pure: may this producer run for the business (its category's feature + the ITA integration for C)? */
export function producerAvailable(p: Pick<StateProducer, "id" | "category">, gates: BusinessGates, allocationOn: boolean): boolean {
  const cat = getCategory(p.category);
  if (!cat || !gates.categoryAvailable(cat)) return false;
  if (p.id === "allocation" && !allocationOn) return false;
  return true;
}

export async function runStateProducers(businessId: number, gates: BusinessGates, now: Date, deps: StateProducerDeps = defaultStateProducerDeps): Promise<StateProducersReport> {
  const report: StateProducersReport = { leaseBusy: false, ran: 0, unavailable: 0, incomplete: 0, failed: 0, events: 0, notified: 0, owedPush: 0, resolved: 0 };
  const allocationOn = deps.producers.some((p) => p.id === "allocation") ? deps.allocationOn(businessId) : false;
  const runnable = deps.producers.filter((p) => producerAvailable(p, gates, allocationOn));
  report.unavailable = deps.producers.length - runnable.length;
  if (runnable.length === 0) return report;

  await deps.tenantTx(businessId, async (tx) => {
    const lock = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${SWEEP_LOCK_NAMESPACE}::int, ${businessId}::int) AS locked`;
    if (lock[0]?.locked !== true) {
      report.leaseBusy = true;
      return;
    }
    const timeZone = await businessTimeZone(tx, businessId);
    for (const p of runnable) {
      const cat = getCategory(p.category)!;
      await tx.$executeRaw`SAVEPOINT state_producer`;
      try {
        const read = await p.read(tx, businessId, now, { timeZone, category: cat });
        let notified = 0;
        let owed = 0;
        for (const e of read.facts.events) {
          const out = await deps.notify(tx, e);
          if (out.notified) notified += 1;
          if (out.owedDeliveryId !== null) owed += 1;
        }
        let resolved = 0;
        if (read.complete) {
          const res = await tx.notification.updateMany({
            where: { businessId, domain: cat.domain, semanticCategory: cat.key, resolvedAt: null, dedupeKey: { notIn: read.facts.present } },
            data: { resolvedAt: now, updatedAt: now },
          });
          resolved = res.count;
        }
        await tx.$executeRaw`RELEASE SAVEPOINT state_producer`;
        report.ran += 1;
        report.events += read.facts.events.length;
        report.notified += notified;
        report.owedPush += owed;
        report.resolved += resolved;
        if (!read.complete) report.incomplete += 1;
      } catch {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT state_producer`;
        report.failed += 1;
      }
    }
  });
  return report;
}
