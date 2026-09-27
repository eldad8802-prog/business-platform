/**
 * Secretary → ledger cutover (Phase 2) — the ONE-TIME data move that must
 * accompany turning `SECRETARY_LEDGER_STORE` on. SCRIPT-ONLY: never import this
 * from a route, a page or the runtime. Run it through
 * `scripts/payables/secretary-ledger-cutover.ts` (default: dry run) or the
 * dry-run-only workflow `.github/workflows/secretary-ledger-cutover-dry-run.yml`.
 *
 * Why it is needed. Migration 20260917090200 copied every `BusinessObligation`
 * into the ledger ONCE. The secretary kept writing `BusinessObligation` after
 * that, with no dual-write, so Production holds three kinds of drift:
 *
 *   A. UNCOPIED    obligations created after the backfill — only in the old table
 *   B. DRIFTED     copied obligations the secretary changed afterwards (marked
 *                  done, released, re-dated, re-priced, snoozed, renamed)
 *   C. INVARIANT   migrated RECURRING commitments carrying `totalAmount`, which
 *                  the ledger forbids (a recurring commitment has no total)
 *
 * Rules — the backfill's own (programme §13), unchanged:
 *   - Nothing is deleted; `BusinessObligation` stays, read-only, for rollback.
 *   - A legacy "MET" is a SETTLED_LEGACY assertion — NEVER a synthesized Payment.
 *     This module contains no code path that writes a Payment or an allocation.
 *   - A drifted row whose installment already carries money is a CONFLICT: it is
 *     reported and left alone, never rewritten under a real payment.
 *   - Every change is audited (`PayablesAuditEvent`, source MIGRATION).
 *   - Idempotent: matching is by `Commitment.legacyObligationId`, so a second
 *     run finds every row already copied and nothing to do.
 *
 * Safety of the run itself:
 *   - DRY RUN transactions are `SET TRANSACTION READ ONLY`: Postgres, not this
 *     code, refuses any write inside them.
 *   - FAIL CLOSED on visibility: every tenant table here is FORCE ROW LEVEL
 *     SECURITY. A role without BYPASSRLS sees nothing until a business is set,
 *     which would make a dry run report a false "nothing to do". The role is
 *     inspected first; without BYPASSRLS, businesses are enumerated from
 *     `Business` (not RLS-forced) and each is read under its own tenant GUC —
 *     and the run refuses if it cannot see any business at all.
 *   - EXECUTE refuses when the plan contains invalid or ambiguous rows (they need
 *     an owner decision — copying them blindly would put guesses into the ledger,
 *     skipping them would make them vanish from the secretary after the switch),
 *     and refuses when the counts differ from the approved dry run.
 *
 * Each business is processed in its own transaction with the tenant GUC set.
 * Output is counts and row ids only — never a name, a note or an amount.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { hashAuditEvent } from "./payables.service";

type Tx = Prisma.TransactionClient;

const VALID_RECURRENCE = new Set(["NONE", "WEEKLY", "MONTHLY", "BIMONTHLY", "QUARTERLY", "SEMIANNUAL", "YEARLY"]);
const VALID_STATES = new Set(["OPEN", "MET", "RELEASED"]);

export type ConflictDetail = {
  businessId: number;
  obligationId: number;
  commitmentId: number;
  installmentId: number;
  reason: string;
  legacy: { state: string; amountDiffers: boolean; dueAtDiffers: boolean };
  ledger: { commitmentStatus: string; installmentStatus: string; paymentTruth: true; paidInFull: boolean };
  proposedResolution: string;
};

export type RowIssue = { businessId: number; obligationId: number; reason: string };

export type CutoverPlan = {
  commitmentsToCreate: number;
  installmentsToCreate: number;
  commitmentsToUpdate: number;
  installmentsToUpdate: number;
  workflowRowsToCreate: number;
  workflowRowsToUpdate: number;
  auditEventsToWrite: number;
  /** Structural: no code path in this module writes a Payment or an allocation. */
  paymentsToCreate: 0;
};

export type CutoverCounts = {
  businesses: number;
  obligations: number;
  alreadyCopied: number;
  uncopied: { OPEN: number; MET: number; RELEASED: number; recurring: number };
  drift: {
    metNotSettled: number;
    releasedNotReleased: number;
    amountChanged: number;
    dueAtChanged: number;
    renamed: number;
    noteChanged: number;
    followUpToCopy: number;
  };
  /** Copied rows with drift the write phase WILL sync (conflicting money drift excluded). */
  toReconcile: number;
  conflicts: ConflictDetail[];
  invalid: RowIssue[];
  ambiguous: RowIssue[];
  recurringWithTotalAmount: number;
  plan: CutoverPlan;
};

export type CutoverRole = {
  user: string;
  superuser: boolean;
  bypassRls: boolean;
  discovery: "ALL_ROWS" | "BUSINESS_TABLE" | "EXPLICIT";
};

export type CutoverReport = {
  mode: "dry-run" | "execute";
  readOnly: boolean;
  role: CutoverRole;
  before: CutoverCounts;
  applied?: { copied: number; synced: number; totalsCleared: number };
  after?: CutoverCounts;
};

export class CutoverRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutoverRefusedError";
  }
}

type Obligation = {
  id: number;
  businessId: number;
  obligeeName: string;
  amount: Prisma.Decimal;
  currency: string;
  dueAt: Date;
  state: string;
  recurrence: string;
  recurrenceSeriesId: string | null;
  note: string | null;
  followUpAt: Date | null;
  settlementAssertedBy: string | null;
  metAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type Copied = {
  id: number;
  businessId: number;
  legacyObligationId: number | null;
  title: string;
  payeeId: number | null;
  payeeNameSnapshot: string;
  scheduleKind: string;
  status: string;
  note: string | null;
  totalAmount: Prisma.Decimal | null;
  installments: Array<{
    id: number;
    sequence: number;
    scheduledAmount: Prisma.Decimal;
    dueAt: Date;
    status: string;
    allocations: Array<{ allocatedAmount: Prisma.Decimal; reversedAt: Date | null; payment: { status: string } }>;
    workflow: { followUpAt: Date | null } | null;
  }>;
};

/** What one copied obligation needs, decided from the two rows alone. Pure. */
export function diffCopied(o: Obligation, c: Copied) {
  const inst = c.installments.find((i) => i.sequence === 1) ?? c.installments[0];
  const active = inst ? inst.allocations.filter((a) => a.reversedAt === null && a.payment.status === "RECORDED") : [];
  const paid = active.length > 0;
  const paidTotal = active.reduce((s, a) => s.plus(a.allocatedAmount), new Prisma.Decimal(0));
  const metNotSettled = o.state === "MET" && inst?.status === "SCHEDULED";
  const releasedNotReleased = o.state === "RELEASED" && c.status !== "RELEASED";
  const open = o.state === "OPEN";
  const amountChanged = open && !!inst && !inst.scheduledAmount.equals(o.amount);
  const dueAtChanged = open && !!inst && inst.dueAt.getTime() !== o.dueAt.getTime();
  const renamed = o.obligeeName !== c.payeeNameSnapshot && c.payeeId === null;
  const noteChanged = (o.note ?? null) !== (c.note ?? null);
  const followUpToCopy =
    open && o.followUpAt !== null && !!inst && (inst.workflow?.followUpAt?.getTime() ?? null) !== o.followUpAt.getTime();
  const moneyDrift = metNotSettled || releasedNotReleased || amountChanged || dueAtChanged;
  return {
    inst,
    paid,
    paidInFull: !!inst && paidTotal.greaterThanOrEqualTo(inst.scheduledAmount),
    metNotSettled,
    releasedNotReleased,
    amountChanged,
    dueAtChanged,
    renamed,
    noteChanged,
    followUpToCopy,
    conflict: moneyDrift && paid ? "installment already carries a payment" : null,
  };
}

/** Why a legacy row cannot be copied deterministically, or null. Pure. */
export function invalidReason(o: Obligation): string | null {
  if (!VALID_STATES.has(o.state)) return `unknown state ${JSON.stringify(o.state)}`;
  if (!VALID_RECURRENCE.has(o.recurrence)) return `unsupported recurrence ${JSON.stringify(o.recurrence)}`;
  if (!/^[A-Z]{3}$/.test(o.currency)) return "currency is not a 3-letter code";
  if (!o.amount.greaterThan(0)) return "amount is not positive";
  if (!(o.dueAt instanceof Date) || Number.isNaN(o.dueAt.getTime())) return "due date is invalid";
  return null;
}

function resolutionFor(d: ReturnType<typeof diffCopied>): string {
  if (d.metNotSettled) {
    return d.paidInFull
      ? "none needed — the ledger already shows it paid in full; ledger mode will show it closed"
      : "owner decides: record the remaining payment, or mark it handled in ledger mode (handled ≠ paid)";
  }
  if (d.releasedNotReleased) return "owner decides: reverse the payment then release, or keep the commitment";
  return "owner decides: reverse the payment then re-date/re-price, or keep the ledger's amount/date";
}

async function loadBusiness(tx: Tx, businessId: number) {
  const obligations: Obligation[] = await tx.businessObligation.findMany({ where: { businessId }, orderBy: { id: "asc" } });
  const copied: Copied[] = await tx.commitment.findMany({
    where: { businessId, legacyObligationId: { not: null } },
    select: {
      id: true,
      businessId: true,
      legacyObligationId: true,
      title: true,
      payeeId: true,
      payeeNameSnapshot: true,
      scheduleKind: true,
      status: true,
      note: true,
      totalAmount: true,
      installments: {
        where: { businessId },
        orderBy: { sequence: "asc" },
        select: {
          id: true,
          sequence: true,
          scheduledAmount: true,
          dueAt: true,
          status: true,
          allocations: { select: { allocatedAmount: true, reversedAt: true, payment: { select: { status: true } } } },
          workflow: { select: { followUpAt: true } },
        },
      },
    },
  });
  return { obligations, copied };
}

function emptyCounts(): CutoverCounts {
  return {
    businesses: 0,
    obligations: 0,
    alreadyCopied: 0,
    uncopied: { OPEN: 0, MET: 0, RELEASED: 0, recurring: 0 },
    drift: { metNotSettled: 0, releasedNotReleased: 0, amountChanged: 0, dueAtChanged: 0, renamed: 0, noteChanged: 0, followUpToCopy: 0 },
    toReconcile: 0,
    conflicts: [],
    invalid: [],
    ambiguous: [],
    recurringWithTotalAmount: 0,
    plan: {
      commitmentsToCreate: 0,
      installmentsToCreate: 0,
      commitmentsToUpdate: 0,
      installmentsToUpdate: 0,
      workflowRowsToCreate: 0,
      workflowRowsToUpdate: 0,
      auditEventsToWrite: 0,
      paymentsToCreate: 0,
    },
  };
}

/** Classify one business's rows into the report. Pure. Exported for tests. */
export function countInto(total: CutoverCounts, obligations: Obligation[], copied: Copied[]): void {
  const byLegacy = new Map(copied.map((c) => [c.legacyObligationId!, c]));
  if (obligations.length > 0 || copied.length > 0) total.businesses += 1;
  total.obligations += obligations.length;

  // Ambiguous: two live legacy occurrences of one series on the same due date —
  // nothing deterministic can say which one is the real occurrence.
  const seen = new Map<string, number>();
  for (const o of obligations) {
    if (!o.recurrenceSeriesId || o.state === "RELEASED") continue;
    const key = `${o.recurrenceSeriesId}|${o.dueAt.toISOString()}`;
    const first = seen.get(key);
    if (first !== undefined) {
      total.ambiguous.push({ businessId: o.businessId, obligationId: o.id, reason: `same series and due date as obligation ${first}` });
    } else seen.set(key, o.id);
  }

  const commitmentsUpdated = new Set<number>();
  for (const o of obligations) {
    const bad = invalidReason(o);
    if (bad) total.invalid.push({ businessId: o.businessId, obligationId: o.id, reason: bad });
    const c = byLegacy.get(o.id);
    if (!c) {
      const state = (VALID_STATES.has(o.state) ? o.state : "OPEN") as "OPEN" | "MET" | "RELEASED";
      total.uncopied[state] += 1;
      if (o.recurrence !== "NONE") total.uncopied.recurring += 1;
      total.plan.commitmentsToCreate += 1;
      total.plan.installmentsToCreate += 1;
      total.plan.auditEventsToWrite += 1;
      if (o.state === "OPEN" && o.followUpAt) total.plan.workflowRowsToCreate += 1;
      continue;
    }
    total.alreadyCopied += 1;
    const d = diffCopied(o, c);
    for (const k of Object.keys(total.drift) as Array<keyof CutoverCounts["drift"]>) if (d[k]) total.drift[k] += 1;
    if (d.conflict && d.inst) {
      total.conflicts.push({
        businessId: o.businessId,
        obligationId: o.id,
        commitmentId: c.id,
        installmentId: d.inst.id,
        reason: d.conflict,
        legacy: { state: o.state, amountDiffers: d.amountChanged, dueAtDiffers: d.dueAtChanged },
        ledger: { commitmentStatus: c.status, installmentStatus: d.inst.status, paymentTruth: true, paidInFull: d.paidInFull },
        proposedResolution: resolutionFor(d),
      });
    }
    // Exactly what the write phase will touch for this row (mirrors applyBusiness).
    const moneySync = !d.conflict && (d.metNotSettled || d.releasedNotReleased || d.amountChanged || d.dueAtChanged);
    if (moneySync || d.renamed || d.noteChanged || d.followUpToCopy) {
      total.toReconcile += 1;
      total.plan.auditEventsToWrite += 1;
    }
    const commitmentTouched =
      (!d.conflict && (d.metNotSettled || d.releasedNotReleased || ((d.amountChanged || d.dueAtChanged) && c.scheduleKind === "ONE_OFF"))) ||
      d.renamed ||
      d.noteChanged;
    if (commitmentTouched) commitmentsUpdated.add(c.id);
    if (!d.conflict && (d.metNotSettled || d.amountChanged || d.dueAtChanged)) total.plan.installmentsToUpdate += 1;
    if (d.followUpToCopy && d.inst) {
      if (d.inst.workflow) total.plan.workflowRowsToUpdate += 1;
      else total.plan.workflowRowsToCreate += 1;
    }
  }
  const totals = copied.filter((c) => c.scheduleKind === "RECURRING" && c.totalAmount !== null);
  for (const c of totals) commitmentsUpdated.add(c.id);
  total.recurringWithTotalAmount += totals.length;
  total.plan.commitmentsToUpdate += commitmentsUpdated.size;
  total.plan.auditEventsToWrite += totals.length;
}

async function audit(
  tx: Tx,
  input: { businessId: number; commitmentId: number; installmentId?: number; eventType: string; summary: string; metadata: Record<string, unknown> },
): Promise<void> {
  const occurredAt = new Date();
  await tx.payablesAuditEvent.create({
    data: {
      businessId: input.businessId,
      commitmentId: input.commitmentId,
      installmentId: input.installmentId ?? null,
      eventType: input.eventType,
      source: "MIGRATION",
      summary: input.summary,
      metadata: input.metadata as Prisma.InputJsonValue,
      eventHash: hashAuditEvent({ ...input, source: "MIGRATION", occurredAt: occurredAt.toISOString() }),
      occurredAt,
    },
  });
}

async function applyBusiness(tx: Tx, obligations: Obligation[], copied: Copied[]) {
  const byLegacy = new Map(copied.map((c) => [c.legacyObligationId!, c]));
  let copiedCount = 0;
  let synced = 0;

  for (const o of obligations) {
    const c = byLegacy.get(o.id);

    if (!c) {
      // ── A. copy — the backfill's §13 mapping, with the recurring invariant kept
      const recurring = o.recurrence !== "NONE";
      const commitment = await tx.commitment.create({
        data: {
          businessId: o.businessId,
          title: o.obligeeName,
          payeeNameSnapshot: o.obligeeName,
          currency: o.currency,
          totalAmount: recurring ? null : o.amount,
          scheduleKind: recurring ? "RECURRING" : "ONE_OFF",
          recurrence: o.recurrence,
          recurrenceSeriesId: o.recurrenceSeriesId,
          status: o.state === "MET" ? "CLOSED" : o.state === "RELEASED" ? "RELEASED" : "ACTIVE",
          note: o.note,
          legacyObligationId: o.id,
          createdAt: o.createdAt,
        },
      });
      const installment = await tx.installment.create({
        data: {
          businessId: o.businessId,
          commitmentId: commitment.id,
          sequence: 1,
          scheduledAmount: o.amount,
          currency: o.currency,
          dueAt: o.dueAt,
          status: o.state === "MET" ? "SETTLED_LEGACY" : "SCHEDULED",
          legacySettlementAssertedBy: o.state === "MET" ? o.settlementAssertedBy : null,
          legacyMetAt: o.state === "MET" ? o.metAt : null,
          createdAt: o.createdAt,
        },
      });
      if (o.state === "OPEN" && o.followUpAt) {
        await tx.installmentWorkflow.create({
          data: { installmentId: installment.id, businessId: o.businessId, followUpAt: o.followUpAt },
        });
      }
      await audit(tx, {
        businessId: o.businessId,
        commitmentId: commitment.id,
        installmentId: installment.id,
        eventType: "COMMITMENT_MIGRATED_FROM_OBLIGATION",
        summary: `Migrated from BusinessObligation #${o.id} (secretary cutover)`,
        metadata: { legacyObligationId: o.id, legacyState: o.state, synthesizedPayment: false, phase: "P2_CUTOVER" },
      });
      copiedCount += 1;
      continue;
    }

    // ── B. sync a copied row the secretary changed after the backfill
    const d = diffCopied(o, c);
    const inst = d.inst;
    const changed: string[] = [];
    if (!d.conflict && inst) {
      if (d.metNotSettled) {
        await tx.installment.update({
          where: { id: inst.id },
          data: { status: "SETTLED_LEGACY", legacySettlementAssertedBy: o.settlementAssertedBy, legacyMetAt: o.metAt },
        });
        await tx.commitment.update({ where: { id: c.id }, data: { status: "CLOSED" } });
        changed.push("state:MET");
      }
      if (d.releasedNotReleased) {
        await tx.commitment.update({ where: { id: c.id }, data: { status: "RELEASED" } });
        changed.push("state:RELEASED");
      }
      if (d.amountChanged || d.dueAtChanged) {
        await tx.installment.update({ where: { id: inst.id }, data: { scheduledAmount: o.amount, dueAt: o.dueAt } });
        if (c.scheduleKind === "ONE_OFF") {
          await tx.commitment.update({ where: { id: c.id }, data: { totalAmount: o.amount } });
        }
        if (d.amountChanged) changed.push("amount");
        if (d.dueAtChanged) changed.push("dueAt");
      }
    }
    // Non-financial drift is safe to sync even when the row carries money.
    if (d.renamed) {
      await tx.commitment.update({ where: { id: c.id }, data: { title: o.obligeeName, payeeNameSnapshot: o.obligeeName } });
      changed.push("name");
    }
    if (d.noteChanged) {
      await tx.commitment.update({ where: { id: c.id }, data: { note: o.note } });
      changed.push("note");
    }
    if (d.followUpToCopy && inst) {
      await tx.installmentWorkflow.upsert({
        where: { installmentId: inst.id },
        create: { installmentId: inst.id, businessId: o.businessId, followUpAt: o.followUpAt },
        update: { followUpAt: o.followUpAt },
      });
      changed.push("followUpAt");
    }
    if (changed.length > 0) {
      await audit(tx, {
        businessId: o.businessId,
        commitmentId: c.id,
        installmentId: inst?.id,
        eventType: "COMMITMENT_SYNCED_FROM_OBLIGATION",
        summary: `Synced from BusinessObligation #${o.id} (secretary cutover)`,
        metadata: { legacyObligationId: o.id, changed, synthesizedPayment: false, phase: "P2_CUTOVER" },
      });
      synced += 1;
    }
  }

  // ── C. the recurring invariant: a RECURRING commitment has no total
  let totalsCleared = 0;
  for (const c of copied) {
    if (c.scheduleKind === "RECURRING" && c.totalAmount !== null) {
      await tx.commitment.update({ where: { id: c.id }, data: { totalAmount: null } });
      await audit(tx, {
        businessId: c.businessId,
        commitmentId: c.id,
        eventType: "COMMITMENT_UPDATED",
        summary: "Recurring commitment total cleared (ledger invariant; migrated value)",
        metadata: { field: "totalAmount", before: c.totalAmount.toString(), after: null, phase: "P2_CUTOVER" },
      });
      totalsCleared += 1;
    }
  }
  return { copied: copiedCount, synced, totalsCleared };
}

async function inspectRole(db: PrismaClient): Promise<Omit<CutoverRole, "discovery">> {
  const [r] = await db.$queryRawUnsafe<Array<{ user: string; superuser: boolean; bypass: boolean }>>(
    `SELECT current_user AS "user", rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
  );
  return { user: r.user, superuser: r.superuser, bypassRls: r.superuser || r.bypass };
}

async function discoverBusinesses(
  db: PrismaClient,
  role: Omit<CutoverRole, "discovery">,
): Promise<{ ids: number[]; discovery: CutoverRole["discovery"] }> {
  if (role.bypassRls) {
    const rows = await db.businessObligation.findMany({ distinct: ["businessId"], select: { businessId: true } });
    const more = await db.commitment.findMany({
      where: { legacyObligationId: { not: null } },
      distinct: ["businessId"],
      select: { businessId: true },
    });
    return { ids: [...new Set([...rows, ...more].map((r) => r.businessId))].sort((a, b) => a - b), discovery: "ALL_ROWS" };
  }
  // Without BYPASSRLS the tenant tables are invisible outside a business
  // context. `Business` is not RLS-forced: enumerate it and read each business
  // under its own GUC — or refuse, if even that shows nothing.
  const all = await db.business.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  if (all.length === 0) {
    throw new CutoverRefusedError(
      `role ${role.user} has no BYPASSRLS and can see no Business row — a run here would report a false "nothing to do". Refusing.`,
    );
  }
  return { ids: all.map((b) => b.id), discovery: "BUSINESS_TABLE" };
}

async function inTenant<T>(db: PrismaClient, businessId: number, readOnly: boolean, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      // Must be the transaction's first statement. Postgres then refuses any
      // write inside it — the dry run is read-only by the database's rule.
      if (readOnly) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(businessId)}, true)`;
      return fn(tx);
    },
    { timeout: 120_000 },
  );
}

async function countAll(db: PrismaClient, ids: number[]): Promise<CutoverCounts> {
  const total = emptyCounts();
  for (const businessId of ids) {
    const { obligations, copied } = await inTenant(db, businessId, true, (tx) => loadBusiness(tx, businessId));
    countInto(total, obligations, copied);
  }
  return total;
}

/** The three numbers an execute must reproduce exactly (from the approved dry run). */
export type ExpectedCounts = { copy: number; reconcile: number; totals: number };

export function expectedFrom(counts: CutoverCounts): ExpectedCounts {
  return {
    copy: counts.uncopied.OPEN + counts.uncopied.MET + counts.uncopied.RELEASED,
    reconcile: counts.toReconcile,
    totals: counts.recurringWithTotalAmount,
  };
}

/**
 * Dry run: read-only counts and the exact plan. Execute: refuses on invalid or
 * ambiguous rows and on any difference from `expect` (the approved dry run),
 * applies per business, then counts again — `after` must show zero uncopied,
 * zero drift outside `conflicts`, and zero recurring totals.
 */
export async function runSecretaryLedgerCutover(
  db: PrismaClient,
  options: { mode: "dry-run" | "execute"; onlyBusinessIds?: number[]; expect?: ExpectedCounts },
): Promise<CutoverReport> {
  const baseRole = await inspectRole(db);
  const discovered = options.onlyBusinessIds
    ? { ids: options.onlyBusinessIds, discovery: "EXPLICIT" as const }
    : await discoverBusinesses(db, baseRole);
  const role: CutoverRole = { ...baseRole, discovery: discovered.discovery };
  const before = await countAll(db, discovered.ids);
  if (options.mode === "dry-run") return { mode: "dry-run", readOnly: true, role, before };

  if (before.invalid.length > 0 || before.ambiguous.length > 0) {
    throw new CutoverRefusedError(
      `refusing to execute: ${before.invalid.length} invalid and ${before.ambiguous.length} ambiguous row(s) need an owner decision first`,
    );
  }
  if (!options.expect) throw new CutoverRefusedError("refusing to execute without the approved dry-run counts (expect)");
  const actual = expectedFrom(before);
  if (actual.copy !== options.expect.copy || actual.reconcile !== options.expect.reconcile || actual.totals !== options.expect.totals) {
    throw new CutoverRefusedError(
      `refusing to execute: counts changed since the approved dry run — expected ${JSON.stringify(options.expect)}, found ${JSON.stringify(actual)}`,
    );
  }

  const applied = { copied: 0, synced: 0, totalsCleared: 0 };
  for (const businessId of discovered.ids) {
    const r = await inTenant(db, businessId, false, async (tx) => {
      const { obligations, copied } = await loadBusiness(tx, businessId);
      return applyBusiness(tx, obligations, copied);
    });
    applied.copied += r.copied;
    applied.synced += r.synced;
    applied.totalsCleared += r.totalsCleared;
  }
  const after = await countAll(db, discovered.ids);
  return { mode: "execute", readOnly: false, role, before, applied, after };
}
