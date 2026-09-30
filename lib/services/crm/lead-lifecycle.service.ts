/**
 * Business Intake M5 — the CRM lead lifecycle writer and reader.
 *
 * Every lifecycle change is ONE row in `LeadLifecycleEvent`, written in the
 * same tenant transaction as the Lead change it describes. The protocol:
 *
 *   1. `lockLeadForLifecycle` — SELECT … FOR UPDATE on the Lead. Concurrent
 *      lifecycle writers on one lead serialize here, so the second one sees
 *      the first one's result (a double-tap becomes a no-op, not a second
 *      transition). An owner decision may carry the lifecycleVersion it saw:
 *      a mismatch is refused (409 LEAD_LIFECYCLE_STALE) — this is what stops a
 *      stale suggestion or a stale screen from overwriting a newer decision.
 *   2. `appendLeadLifecycleEvent` — idempotency first ((businessId,
 *      idempotencyKey) unique: a retry returns the recorded step), then
 *      lifecycleVersion + 1 with a compare-and-set, then the history row with
 *      seq = the new version ((businessId, leadId, seq) unique — the DB
 *      backstop against two writers recording "the next" step).
 *   3. Learning sensors (`recordSensor`, idempotent per `lead:<id>:seq:<n>`):
 *      categories, counts and durations only — never a name, phone, email,
 *      note, reason text or amount.
 *
 * LearningEvent is EVIDENCE for learning; this table is the operational
 * history. The legacy `LEAD_*` audit events are kept unchanged beside it.
 */

import { Prisma } from "@prisma/client";
import { ConflictError } from "@/lib/errors";
import type { AuditActor, AuditSource } from "@/lib/services/audit.service";
import { recordSensor } from "@/lib/sensors/record-sensor";
import type { LeadStatusValue } from "@/lib/services/crm/lead-core";
import {
  FIRST_HANDLING_KINDS,
  LEAD_LIFECYCLE_EVENT_LABELS,
  LEAD_NEXT_ACTION_LABELS,
  hoursBetween,
  isLeadNextActionKind,
  type LeadLifecycleEventKind,
  type LeadNextActionKindValue,
  type LeadOrigin,
} from "@/lib/services/crm/lead-lifecycle-core";

type Tx = Prisma.TransactionClient;

export type LockedLead = {
  id: number;
  businessId: number;
  status: LeadStatusValue;
  lifecycleVersion: number;
  nextFollowUpAt: Date | null;
  nextActionKind: LeadNextActionKindValue | null;
  firstHandledAt: Date | null;
  createdAt: Date;
  closedAt: Date | null;
  customerId: number | null;
};

export type LifecycleEvidence = {
  kind: "intake_event" | "conversation" | "identity_proposal" | "suggestion" | "backfill";
  ref: string;
};

export type AppendLifecycleInput = {
  kind: LeadLifecycleEventKind;
  idempotencyKey: string;
  actor?: AuditActor;
  source?: AuditSource;
  fromStatus?: LeadStatusValue | null;
  toStatus?: LeadStatusValue | null;
  nextActionKind?: LeadNextActionKindValue | null;
  dueAt?: Date | null;
  previousDueAt?: Date | null;
  amountKind?: "estimate" | "agreed" | null;
  amount?: string | null;
  evidence?: LifecycleEvidence | null;
  occurredAt?: Date;
  /** Only for `created`: the closed-vocabulary origin for the learning sensor. */
  origin?: LeadOrigin;
};

export type AppendLifecycleResult = { seq: number; duplicate: boolean };

/** Raised when the owner's view of a lead is older than the lead. */
export function staleLifecycleError(): ConflictError {
  return new ConflictError(
    "LEAD_LIFECYCLE_STALE",
    "הליד השתנה מאז שנפתח המסך. רעננו ונסו שוב."
  );
}

/**
 * Lock one lead for a lifecycle change. Tenant-scoped (businessId in the WHERE
 * AND under RLS). Returns null when the lead does not exist in this business.
 */
export async function lockLeadForLifecycle(
  tx: Tx,
  businessId: number,
  leadId: number,
  expectedVersion?: number | null
): Promise<LockedLead | null> {
  const rows = await tx.$queryRaw<
    Array<{
      id: number;
      businessId: number;
      status: LeadStatusValue;
      lifecycleVersion: number;
      nextFollowUpAt: Date | null;
      nextActionKind: string | null;
      firstHandledAt: Date | null;
      createdAt: Date;
      closedAt: Date | null;
      customerId: number | null;
    }>
  >`SELECT "id", "businessId", "status"::text AS "status", "lifecycleVersion", "nextFollowUpAt",
           "nextActionKind", "firstHandledAt", "createdAt", "closedAt", "customerId"
    FROM "Lead" WHERE "id" = ${leadId} AND "businessId" = ${businessId} FOR UPDATE`;
  const row = rows[0];
  if (!row) return null;
  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== row.lifecycleVersion) {
    throw staleLifecycleError();
  }
  return {
    ...row,
    nextActionKind: isLeadNextActionKind(row.nextActionKind) ? row.nextActionKind : null,
  };
}

function actorColumns(actor: AuditActor | undefined, source: AuditSource | undefined) {
  const actorType = actor?.type ?? "UNKNOWN";
  return {
    actorType,
    actorUserId: actor?.type === "OWNER_USER" ? actor.userId : null,
    source: actor ? (source ?? "UNKNOWN") : (source ?? "UNKNOWN"),
  };
}

/**
 * Append one lifecycle step for a LOCKED lead. Mutates `lead.lifecycleVersion`
 * (and `firstHandledAt`) so several steps in one transaction chain correctly.
 */
export async function appendLeadLifecycleEvent(
  tx: Tx,
  lead: LockedLead,
  input: AppendLifecycleInput
): Promise<AppendLifecycleResult> {
  const businessId = lead.businessId;
  const existing = await tx.leadLifecycleEvent.findFirst({
    where: { businessId, idempotencyKey: input.idempotencyKey },
    select: { seq: true, leadId: true },
  });
  if (existing) {
    if (existing.leadId !== lead.id) {
      throw new ConflictError("LEAD_LIFECYCLE_KEY_REUSED", "idempotency key belongs to another lead");
    }
    return { seq: existing.seq, duplicate: true };
  }

  const now = input.occurredAt ?? new Date();
  const seq = lead.lifecycleVersion + 1;
  const { actorType, actorUserId, source } = actorColumns(input.actor, input.source);
  const firstHandled =
    actorType === "OWNER_USER" && lead.firstHandledAt === null && FIRST_HANDLING_KINDS.includes(input.kind);

  const bumped = await tx.lead.updateMany({
    where: { id: lead.id, businessId, lifecycleVersion: lead.lifecycleVersion },
    data: { lifecycleVersion: seq, ...(firstHandled ? { firstHandledAt: now } : {}) },
  });
  if (bumped.count !== 1) throw staleLifecycleError();

  // Duration since the previous stage began — read BEFORE this row exists.
  let previousStageAt: Date | null = null;
  if (input.kind === "status_changed") {
    const prev = await tx.leadLifecycleEvent.findFirst({
      where: { businessId, leadId: lead.id, kind: { in: ["created", "status_changed"] } },
      orderBy: { seq: "desc" },
      select: { occurredAt: true },
    });
    previousStageAt = prev?.occurredAt ?? lead.createdAt;
  }

  await tx.leadLifecycleEvent.create({
    data: {
      businessId,
      leadId: lead.id,
      seq,
      kind: input.kind,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      nextActionKind: input.nextActionKind ?? null,
      dueAt: input.dueAt ?? null,
      previousDueAt: input.previousDueAt ?? null,
      amountKind: input.amountKind ?? null,
      amount: input.amount ?? null,
      actorType,
      actorUserId,
      source,
      evidenceKind: input.evidence?.kind ?? null,
      evidenceRef: input.evidence?.ref ?? null,
      idempotencyKey: input.idempotencyKey,
      occurredAt: now,
    },
  });

  const handledBefore = lead.firstHandledAt;
  lead.lifecycleVersion = seq;
  if (firstHandled) lead.firstHandledAt = now;

  await emitLifecycleSensors(tx, lead, input, { seq, now, firstHandled, previousStageAt, handledBefore });
  return { seq, duplicate: false };
}

/** Who / where / when for every lifecycle sensor: the actor and source of the step itself. */
function lifecycleWho(lead: LockedLead, input: AppendLifecycleInput, now: Date) {
  return {
    businessId: lead.businessId,
    entityId: lead.id,
    actor: input.actor ?? ({ type: "UNKNOWN" } as const),
    source: input.actor ? (input.source ?? "UNKNOWN") : ("UNKNOWN" as const),
    occurredAt: now,
  };
}

async function emitLifecycleSensors(
  tx: Tx,
  lead: LockedLead,
  input: AppendLifecycleInput,
  ctx: { seq: number; now: Date; firstHandled: boolean; previousStageAt: Date | null; handledBefore: Date | null }
): Promise<void> {
  const base = () => lifecycleWho(lead, input, ctx.now);
  const key = (suffix: string) => `lead:${lead.id}:seq:${ctx.seq}:${suffix}`;

  switch (input.kind) {
    case "created":
      await recordSensor(
        {
          ...base(),
          sensor: "LEAD_LIFECYCLE_STARTED",
          payload: { origin: input.origin ?? "MANUAL", contactKnown: lead.customerId !== null },
          idempotencyKey: `lead:${lead.id}:lifecycle-started`,
        },
        { tx }
      );
      break;
    case "status_changed": {
      const from = input.fromStatus ?? null;
      const to = input.toStatus ?? null;
      const closing = to === "WON" || to === "LOST" || to === "DROPPED";
      const reopening = from === "WON" || from === "LOST" || from === "DROPPED";
      await recordSensor(
        {
          ...base(),
          sensor: "LEAD_STAGE_CHANGED",
          payload: {
            fromStage: from,
            toStage: to,
            closing,
            reopening,
            hoursInPreviousStage: ctx.previousStageAt ? hoursBetween(ctx.previousStageAt, ctx.now) : null,
          },
          idempotencyKey: key("stage"),
        },
        { tx }
      );
      if (closing && !reopening) {
        await recordSensor(
          {
            ...base(),
            sensor: "LEAD_OUTCOME_RECORDED",
            payload: {
              outcome: to,
              daysOpen: Math.floor(hoursBetween(lead.createdAt, ctx.now) / 24),
              hadNextAction: lead.nextFollowUpAt !== null,
            },
            idempotencyKey: key("outcome"),
          },
          { tx }
        );
      }
      break;
    }
    case "next_action_set":
    case "next_action_rescheduled":
      await recordSensor(
        {
          ...base(),
          sensor: "LEAD_NEXT_ACTION_SCHEDULED",
          payload: {
            actionKind: input.nextActionKind ?? null,
            rescheduled: input.kind === "next_action_rescheduled",
            dueInHours: input.dueAt ? hoursBetween(ctx.now, input.dueAt) : null,
            fromSuggestion: input.evidence?.kind === "suggestion",
          },
          idempotencyKey: key("scheduled"),
        },
        { tx }
      );
      break;
    case "next_action_completed": {
      const due = input.previousDueAt ?? null;
      await recordSensor(
        {
          ...base(),
          sensor: "LEAD_NEXT_ACTION_COMPLETED",
          payload: {
            actionKind: input.nextActionKind ?? null,
            onTime: due ? ctx.now.getTime() <= due.getTime() : null,
            lateHours: due && ctx.now.getTime() > due.getTime() ? hoursBetween(due, ctx.now) : 0,
          },
          idempotencyKey: key("completed"),
        },
        { tx }
      );
      break;
    }
    case "value_updated":
      await recordSensor(
        {
          ...base(),
          sensor: "LEAD_VALUE_RECORDED",
          payload: { amountKind: input.amountKind ?? null, cleared: input.amount === null },
          idempotencyKey: key("value"),
        },
        { tx }
      );
      break;
    default:
      break;
  }

  if (ctx.firstHandled && ctx.handledBefore === null) {
    await recordSensor(
      {
        ...base(),
        sensor: "LEAD_FIRST_HANDLED",
        payload: { hoursToFirstHandling: hoursBetween(lead.createdAt, ctx.now), firstAction: input.kind },
        idempotencyKey: `lead:${lead.id}:first-handled`,
      },
      { tx }
    );
  }
}

/* ---------------------------------------------------------------- reads --- */

export type LeadLifecycleHistoryItem = {
  seq: number;
  kind: LeadLifecycleEventKind;
  label: string;
  fromStatus: string | null;
  toStatus: string | null;
  nextActionKind: string | null;
  nextActionLabel: string | null;
  dueAt: string | null;
  previousDueAt: string | null;
  amountKind: string | null;
  amount: string | null;
  actorType: string;
  source: string;
  evidenceKind: string | null;
  evidenceRef: string | null;
  occurredAt: string;
};

export async function getLeadLifecycleHistory(
  tx: Tx,
  businessId: number,
  leadId: number,
  limit = 100
): Promise<LeadLifecycleHistoryItem[]> {
  const rows = await tx.leadLifecycleEvent.findMany({
    where: { businessId, leadId },
    orderBy: { seq: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
  });
  return rows.map((r) => ({
    seq: r.seq,
    kind: r.kind as LeadLifecycleEventKind,
    label: LEAD_LIFECYCLE_EVENT_LABELS[r.kind as LeadLifecycleEventKind] ?? r.kind,
    fromStatus: r.fromStatus,
    toStatus: r.toStatus,
    nextActionKind: r.nextActionKind,
    nextActionLabel: isLeadNextActionKind(r.nextActionKind) ? LEAD_NEXT_ACTION_LABELS[r.nextActionKind] : null,
    dueAt: r.dueAt?.toISOString() ?? null,
    previousDueAt: r.previousDueAt?.toISOString() ?? null,
    amountKind: r.amountKind,
    amount: r.amount === null ? null : r.amount.toFixed(2),
    actorType: r.actorType,
    source: r.source,
    evidenceKind: r.evidenceKind,
    evidenceRef: r.evidenceRef,
    occurredAt: r.occurredAt.toISOString(),
  }));
}

/**
 * Suggestion rules the owner dismissed and that are still in force: the
 * dismissal is the lead's LATEST lifecycle step (nothing happened since).
 * Any later change on the lead lets Dubiz propose again.
 */
export async function dismissedSuggestionRules(
  tx: Tx,
  businessId: number,
  leadIds: readonly number[]
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (leadIds.length === 0) return out;
  const rows = await tx.$queryRaw<Array<{ leadId: number; evidenceRef: string }>>`
    SELECT e."leadId", e."evidenceRef"
    FROM "LeadLifecycleEvent" e
    JOIN "Lead" l ON l."id" = e."leadId" AND l."businessId" = e."businessId" AND l."lifecycleVersion" = e."seq"
    WHERE e."businessId" = ${businessId}
      AND e."kind" = 'suggestion_dismissed'
      AND e."leadId" IN (${Prisma.join([...leadIds])})`;
  for (const r of rows) {
    out.set(r.leadId, [...(out.get(r.leadId) ?? []), r.evidenceRef]);
  }
  return out;
}

/** Open M4 identity proposals per lead — "waiting for the owner's decision". */
export async function openIdentityProposalCounts(
  tx: Tx,
  businessId: number,
  leadIds: readonly number[]
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (leadIds.length === 0) return out;
  const rows = await tx.identityProposal.groupBy({
    by: ["leadId"],
    where: { businessId, state: "proposed", leadId: { in: [...leadIds] } },
    _count: { _all: true },
  });
  for (const r of rows) if (r.leadId !== null) out.set(r.leadId, r._count._all);
  return out;
}

/** Latest customer-inbound message time per lead (conversations linked by leadId). */
export async function lastCustomerInboundByLead(
  tx: Tx,
  businessId: number,
  leadIds: readonly number[]
): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  if (leadIds.length === 0) return out;
  const rows = await tx.conversation.groupBy({
    by: ["leadId"],
    where: { businessId, leadId: { in: [...leadIds] }, customerLastInboundAt: { not: null } },
    _max: { customerLastInboundAt: true },
  });
  for (const r of rows) {
    if (r.leadId !== null && r._max.customerLastInboundAt) out.set(r.leadId, r._max.customerLastInboundAt);
  }
  return out;
}
