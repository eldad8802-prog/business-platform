/**
 * Daily Tasks — owner actions on business items (Daily Tasks spec 3.3–3.5, 5.4, 8.3, 8.5, 12.3, 12.12). SERVER-ONLY.
 *
 * Two kinds of action, never confused:
 *
 *   DISPLAY STATE (TaskSourceState, per item and treatment cycle): "טופל להיום" (acknowledge), "הזכר לי ב…" for a
 *   source with no domain slot (snooze), and "חשוב" (pin). They change nothing in the business: the item is hidden
 *   until tomorrow / until its day, and comes back at once when new evidence arrives.
 *
 *   ROUTED DOMAIN ACTIONS, through the domain's own service in-process, with its own checks:
 *     lead      — "בוצע" clears the follow-up (leadService.clearFollowUp); "הזכר לי ב…" moves it (setFollowUp);
 *                 the lead's nextFollowUpAt is the one slot (3.3);
 *     payment   — "טופל" writes handledAt only (completeObligation); "דחה תזכורת" writes followUpAt only
 *                 (snoozeObligation); "שילמתי" records a payment ONLY through the existing payment service with
 *                 the secretary's existing content-bound key — after this layer's own request check (12.12).
 *
 * Every action names an item that exists NOW in the adapter's output for this business (12.3): arbitrary keys are
 * never stored. Every write is idempotent on its Idempotency-Key (task.service.ts envelope).
 *
 * The one call to a service that writes money is `recordManualPayment`, below (T-M1). Amounts never enter the
 * journal (T-M5); the payment service is not changed (T-M6).
 */
import { leadService } from "@/lib/services/crm/lead.service";
import { completeObligation, snoozeObligation } from "@/lib/services/obligations/obligation.service";
import { obligationServiceDeps } from "@/lib/services/obligations/obligations.deps";
import { recordManualPayment } from "@/lib/services/payables/payables.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { jerusalemDayKey, jerusalemInstantAt, startOfJerusalemDayUtc, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { isDayKey } from "./task-core";
import { SOURCE_KINDS, type SourceItem, type SourceKind } from "./agenda-core";
import { runAdapter } from "./sources";
import { utcTs } from "./task.store";
import {
  TaskServiceError,
  assertKeyMayWrite,
  commitRequest,
  findPrior,
  idempotent,
  isUniqueViolation,
  materialize,
  own,
  prepareRequest,
  type TaskActor,
  type TaskCtx,
  type TaskRequest,
  type TaskResult,
} from "./task.service";

export type SourceRef = { sourceKind: string; dedupeKey: string };

/** The item as the adapter shows it to this business right now — or NOT_FOUND (12.3). */
export async function resolveSourceItem(businessId: number, ref: SourceRef, now: Date): Promise<SourceItem> {
  if (!SOURCE_KINDS.includes(ref.sourceKind as SourceKind)) throw new TaskServiceError("INVALID_INPUT", { field: "sourceKind" });
  if (typeof ref.dedupeKey !== "string" || !/^[A-Za-z0-9:_.-]{1,200}$/.test(ref.dedupeKey)) throw new TaskServiceError("INVALID_INPUT", { field: "dedupeKey" });
  const result = await runAdapter(ref.sourceKind as SourceKind, { businessId, now, today: jerusalemDayKey(now) }, new Set());
  if (result.status === "FAILED") throw new TaskServiceError("CONFLICT", { problem: "SOURCE_UNAVAILABLE" });
  const item = result.items.find((i) => i.dedupeKey === ref.dedupeKey);
  if (!item) throw new TaskServiceError("NOT_FOUND", { problem: "ITEM_NOT_CURRENT" });
  return item;
}

/** INSERT … ON CONFLICT on the item's cycle row; returns its id. Never P2002 inside the transaction (12.4). */
async function upsertState(ctx: TaskCtx, item: SourceItem, set: { acknowledgedOn?: JerusalemDayKey | null; ackEvidenceVersion?: string | null; snoozedUntil?: Date | null; pinnedAt?: Date | null; evidenceVersion?: string }): Promise<number> {
  const rows = await ctx.tx.$queryRaw<{ id: number }[]>`
    INSERT INTO "TaskSourceState" ("businessId", "sourceKind", "dedupeKey", "cycleKey", "evidenceVersion", "firstSeenAt",
                                   "acknowledgedOn", "ackEvidenceVersion", "snoozedUntil", "pinnedAt", "updatedAt")
    VALUES (${ctx.businessId}, ${item.sourceKind}, ${item.dedupeKey}, ${item.cycleKey}, ${set.evidenceVersion ?? item.evidenceVersion},
            ${utcTs(ctx.now)}, ${set.acknowledgedOn ?? null}::date, ${set.ackEvidenceVersion ?? null},
            ${utcTs(set.snoozedUntil)}, ${utcTs(set.pinnedAt)}, ${utcTs(ctx.now)})
    ON CONFLICT ("businessId", "dedupeKey", "cycleKey") DO UPDATE SET
      "acknowledgedOn" = CASE WHEN ${set.acknowledgedOn !== undefined} THEN EXCLUDED."acknowledgedOn" ELSE "TaskSourceState"."acknowledgedOn" END,
      "ackEvidenceVersion" = CASE WHEN ${set.ackEvidenceVersion !== undefined} THEN EXCLUDED."ackEvidenceVersion" ELSE "TaskSourceState"."ackEvidenceVersion" END,
      "snoozedUntil" = CASE WHEN ${set.snoozedUntil !== undefined} THEN EXCLUDED."snoozedUntil" ELSE "TaskSourceState"."snoozedUntil" END,
      "pinnedAt" = CASE WHEN ${set.pinnedAt !== undefined} THEN EXCLUDED."pinnedAt" ELSE "TaskSourceState"."pinnedAt" END,
      "evidenceVersion" = CASE WHEN ${set.evidenceVersion !== undefined} THEN EXCLUDED."evidenceVersion" ELSE "TaskSourceState"."evidenceVersion" END,
      "version" = "TaskSourceState"."version" + 1,
      "updatedAt" = EXCLUDED."updatedAt"
    RETURNING "id"`;
  return rows[0].id;
}

const sourceEvent = (item: SourceItem) => ({ sourceKind: item.sourceKind, dedupeKey: item.dedupeKey, cycleKey: item.cycleKey });

// ── Display state ───────────────────────────────────────────────────────────────────────────────

export type DisplayOp = "acknowledge" | "snooze" | "pin" | "unpin";

export async function setDisplayState(actor: TaskActor, req: TaskRequest, ref: SourceRef, op: DisplayOp, until?: JerusalemDayKey): Promise<TaskResult> {
  const now = req.now ?? new Date();
  const item = await resolveSourceItem(actor.businessId, ref, now);
  if (op === "snooze") {
    if (item.snooze !== "STATE") throw new TaskServiceError("INVALID_STATE", { problem: "SNOOZE_LIVES_IN_THE_DOMAIN", slot: item.snooze });
    if (!until || !isDayKey(until) || until <= jerusalemDayKey(now)) throw new TaskServiceError("INVALID_INPUT", { field: "until" });
  }
  return idempotent(actor, req, `source.${op}`, { ...ref, cycleKey: item.cycleKey, until: until ?? null }, async (ctx) => {
    let id: number;
    if (op === "acknowledge") {
      id = await upsertState(ctx, item, { acknowledgedOn: ctx.today, ackEvidenceVersion: item.evidenceVersion });
      own(ctx, { eventType: "SOURCE_ITEM_ACKNOWLEDGED", ...sourceEvent(item), payload: { dayKey: ctx.today, evidenceVersion: item.evidenceVersion } });
    } else if (op === "snooze") {
      id = await upsertState(ctx, item, { snoozedUntil: startOfJerusalemDayUtc(until as JerusalemDayKey), evidenceVersion: item.evidenceVersion });
      own(ctx, { eventType: "SOURCE_ITEM_SNOOZED", ...sourceEvent(item), payload: { until } });
    } else {
      id = await upsertState(ctx, item, { pinnedAt: op === "pin" ? ctx.now : null });
      own(ctx, { eventType: op === "pin" ? "SOURCE_ITEM_PINNED" : "SOURCE_ITEM_UNPINNED", ...sourceEvent(item), payload: {} });
    }
    return { sourceStateId: id };
  });
}

/**
 * "טופל להיום" on a grouped queue (T-C5): every member the owner saw, each in its own cycle row with its own
 * evidence, in ONE request — so a member that arrives or changes afterwards brings the queue back with
 * "חדשים: N". Every key must be an item the source shows this business now (12.3).
 */
export const QUEUE_ACK_MAX = 100;

export async function acknowledgeQueue(actor: TaskActor, req: TaskRequest, sourceKind: string, dedupeKeys: string[]): Promise<TaskResult & { acknowledged: number }> {
  const now = req.now ?? new Date();
  if (!SOURCE_KINDS.includes(sourceKind as SourceKind)) throw new TaskServiceError("INVALID_INPUT", { field: "sourceKind" });
  if (!Array.isArray(dedupeKeys) || dedupeKeys.length === 0 || dedupeKeys.length > QUEUE_ACK_MAX) throw new TaskServiceError("INVALID_INPUT", { field: "dedupeKeys" });
  const keys = [...new Set(dedupeKeys.map(String))].sort();
  if (!keys.every((k) => /^[A-Za-z0-9:_.-]{1,200}$/.test(k))) throw new TaskServiceError("INVALID_INPUT", { field: "dedupeKeys" });
  const result = await runAdapter(sourceKind as SourceKind, { businessId: actor.businessId, now, today: jerusalemDayKey(now) }, new Set());
  if (result.status === "FAILED") throw new TaskServiceError("CONFLICT", { problem: "SOURCE_UNAVAILABLE" });
  const byKey = new Map(result.items.map((i) => [i.dedupeKey, i]));
  const items = keys.map((k) => byKey.get(k));
  if (items.some((i) => !i)) throw new TaskServiceError("NOT_FOUND", { problem: "ITEM_NOT_CURRENT" });
  const out = await idempotent(actor, req, "source.acknowledge_queue", { sourceKind, keys, cycles: items.map((i) => i!.cycleKey) }, async (ctx) => {
    for (const item of items as SourceItem[]) {
      await upsertState(ctx, item, { acknowledgedOn: ctx.today, ackEvidenceVersion: item.evidenceVersion });
      own(ctx, { eventType: "SOURCE_ITEM_ACKNOWLEDGED", ...sourceEvent(item), payload: { dayKey: ctx.today, evidenceVersion: item.evidenceVersion } });
    }
    return {};
  });
  return { ...out, acknowledged: items.length };
}

// ── Routed domain actions ───────────────────────────────────────────────────────────────────────

export type RoutedOp = "lead_done" | "lead_snooze" | "payment_handled" | "payment_snooze";

/** 09:00 Jerusalem on a calendar day — when a postponed reminder comes back. */
function morningOf(day: JerusalemDayKey): Date {
  return jerusalemInstantAt(day, 9, 0);
}

export async function routeDomainAction(actor: TaskActor, req: TaskRequest, ref: SourceRef, op: RoutedOp, until?: JerusalemDayKey): Promise<TaskResult> {
  const now = req.now ?? new Date();
  const item = await resolveSourceItem(actor.businessId, ref, now);
  const entityId = item.entity?.id;
  if (!entityId) throw new TaskServiceError("INVALID_STATE", { problem: "NO_DOMAIN_ENTITY" });
  const isLead = op === "lead_done" || op === "lead_snooze";
  if (isLead !== (item.sourceKind === "lead") || (!isLead && item.sourceKind !== "supplier_payment")) throw new TaskServiceError("INVALID_INPUT", { field: "op" });
  if ((op === "lead_snooze" || op === "payment_snooze") && (!until || !isDayKey(until) || until <= jerusalemDayKey(now))) throw new TaskServiceError("INVALID_INPUT", { field: "until" });
  if (op === "lead_done" && !item.details?.followUpDue) throw new TaskServiceError("INVALID_STATE", { problem: "NO_FOLLOW_UP_TO_COMPLETE" });

  return idempotent(actor, req, `route.${op}`, { ...ref, until: until ?? null }, async (ctx) => {
    const audit = { actor: { type: "OWNER_USER" as const, userId: ctx.userId }, source: "OWNER_UI" as const };
    if (op === "lead_done") {
      await leadService.clearFollowUp({ businessId: ctx.businessId, leadId: entityId, ...audit }, { tx: ctx.tx });
    } else if (op === "lead_snooze") {
      await leadService.setFollowUp({ businessId: ctx.businessId, leadId: entityId, followUpAt: morningOf(until as JerusalemDayKey).toISOString(), ...audit }, { tx: ctx.tx });
    } else if (op === "payment_handled") {
      await completeObligation(ctx.businessId, entityId, obligationServiceDeps({ tx: ctx.tx, actorUserId: ctx.userId }));
    } else {
      await snoozeObligation(ctx.businessId, entityId, morningOf(until as JerusalemDayKey), obligationServiceDeps({ tx: ctx.tx, actorUserId: ctx.userId }));
    }
    // The domain records its own lifecycle / learning; the task journal adds no duplicate sensor (11.1).
    return {};
  });
}

// ── "שילמת?" → "כן": the one money path (12.12) ─────────────────────────────────────────────────

/** The outbound instruments POST /api/payables/payments accepts — the same list, since the payment service itself does not check it. */
const PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "CREDIT_CARD", "CHECK", "DIRECT_DEBIT", "STANDING_ORDER", "BIT", "PAYBOX", "OTHER"] as const;

export type PaidInput = SourceRef & { amount: string; paidAt: JerusalemDayKey; method: string };

/**
 * 1. This layer's request check (key age, fingerprint, journal): the same key with another amount or date is
 *    refused HERE, before the payment service is called (T-I7, T-M2).
 * 2. The existing payment service, with the secretary's existing content-bound key
 *    `secretary:<installmentId>:<paidAt>:<amount>` — two tabs with the same content end in one payment (T-M3).
 * 3. The fingerprint, with the payment id only — no amount, no balance (T-M5).
 * A failure between 2 and 3 is retried by the client with the same key: step 1 finds nothing, step 2 returns the
 * same payment (the payment service's own replay), step 3 records it — never a second payment (T-M4).
 */
export async function recordPaidViaTasks(actor: TaskActor, req: TaskRequest, input: PaidInput): Promise<TaskResult> {
  const now = req.now ?? new Date();
  if (!/^\d+(\.\d{1,2})?$/.test(String(input.amount)) || Number(input.amount) <= 0) throw new TaskServiceError("INVALID_INPUT", { field: "amount" });
  if (!isDayKey(input.paidAt) || input.paidAt > jerusalemDayKey(now)) throw new TaskServiceError("INVALID_INPUT", { field: "paidAt" });
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.method)) throw new TaskServiceError("INVALID_INPUT", { field: "method" });
  const body = { sourceKind: input.sourceKind, dedupeKey: input.dedupeKey, amount: String(input.amount), paidAt: input.paidAt, method: input.method };
  const p = prepareRequest(actor, req, "route.payment_paid", body);

  const prior = await tenantTx(actor.businessId, (tx) => findPrior(tx, p));
  if (prior) return materialize(actor.businessId, prior, true);
  assertKeyMayWrite(p);

  // Asked before "טופל" closes the reminder (as the secretary does): the item is current, its ledger names the
  // installment and the commitment. A legacy item without a ledger link has nothing to pay through.
  const item = await resolveSourceItem(actor.businessId, input, now);
  if (item.sourceKind !== "supplier_payment") throw new TaskServiceError("INVALID_INPUT", { field: "sourceKind" });
  const installmentId = Number(item.details?.installmentId);
  const commitmentId = Number(item.details?.commitmentId);
  if (!Number.isInteger(installmentId) || !Number.isInteger(commitmentId) || installmentId <= 0 || commitmentId <= 0) {
    throw new TaskServiceError("INVALID_STATE", { problem: "NO_LEDGER_LINK" });
  }

  const payment = await runWithTenantContext({ businessId: actor.businessId }, () => recordManualPayment({
    businessId: actor.businessId,
    actorUserId: actor.userId,
    commitmentId,
    installmentIds: [installmentId],
    amount: String(input.amount),
    paidAt: new Date(`${input.paidAt}T12:00:00+03:00`),
    method: input.method,
    idempotencyKey: `secretary:${installmentId}:${input.paidAt}:${input.amount}`,
  }));
  const paymentId = payment.payment.id;
  try {
    await tenantTx(actor.businessId, (tx) => commitRequest(tx, p, [], { paymentId }));
  } catch (e) {
    if (!isUniqueViolation(e)) throw e; // a parallel identical request recorded it first: same payment
  }
  return materialize(actor.businessId, { paymentId }, false);
}

