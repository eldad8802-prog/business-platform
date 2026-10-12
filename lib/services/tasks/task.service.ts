/**
 * Daily Tasks — TaskService: owner tasks and recurring series (Daily Tasks spec, sections 6 and 12). SERVER-ONLY.
 *
 * Milestone A ships the service only: no route, no screen, nothing reachable while the flag `daily_tasks` is
 * off (the routes of milestone B check it first). Every operation:
 *
 *   - runs in ONE tenant transaction (`tenantTx`, app.current_business_id) under the restricted runtime, whose
 *     privileges are SELECT / INSERT / UPDATE on the task tables and SELECT / INSERT on the journal;
 *   - takes the business and the acting user from the server-side session only (the caller passes them;
 *     never from a request body) — the database refuses a user of another business on its own (trigger);
 *   - is idempotent on its Idempotency-Key (task-idempotency.ts): same key + same request → the first result
 *     (`replayed: true`); same key + different request → IDEMPOTENCY_KEY_REUSED; a key older than 24 h may
 *     not write; two concurrent first requests end in one write and the same answer;
 *   - carries `expectedVersion` for every change of an existing row: a stale version → VERSION_CONFLICT;
 *   - writes one journal event per state change, in the same transaction; system consequences (the next
 *     occurrence, missed occurrences) are journaled as SYSTEM, never counted as the owner's behaviour;
 *   - locks the series row first for anything touching a series (6.5), with the partial unique index as the
 *     last line: two OPEN occurrences of one series cannot exist.
 *
 * It never touches money, obligations, leads or any other domain: an entity link is a reference only, checked
 * to belong to the same business (here, and by the composite foreign keys in the database).
 */
import { Prisma, type Task, type TaskSeries } from "@prisma/client";

import { CLOSED_LEAD_STATUSES } from "@/lib/services/crm/lead-core";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { addCalendarDays, daysBetweenDayKeys, jerusalemDayKey, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

import {
  canTransition,
  compactPayload,
  dayKeyToDbDate,
  dbDateToDayKey,
  firstOccurrenceOnOrAfter,
  isDayKey,
  missedOccurrences,
  nextOccurrenceAfterClose,
  normalizeRule,
  occurrenceOnResume,
  validatePayload,
  validateRule,
  validateText,
  type SeriesRule,
  type TaskAction,
  type TaskState,
} from "./task-core";
import {
  FINGERPRINT_TTL_MS,
  checkIdempotencyKey,
  digestKeysFromEnv,
  digestWithKeyId,
  requestDigest,
  sameDigest,
  type RequestIdentity,
} from "./task-idempotency";
import {
  appendEvents,
  findFingerprint,
  findJournalOrigin,
  lockSeries,
  lockTask,
  maxSequence,
  recordFingerprint,
  type JournalEntry,
  type ResultRef,
  type TaskTx,
} from "./task.store";

// ── Errors and inputs ───────────────────────────────────────────────────────────────────────────

export type TaskErrorCode =
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_KEY_STALE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "VERSION_CONFLICT"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "INVALID_INPUT"
  | "LINK_NOT_FOUND"
  | "LINK_LEAD_OPEN"
  | "NOT_AN_OCCURRENCE"
  | "NEXT_OCCURRENCE_IN_PROGRESS"
  | "NOT_LATEST_OCCURRENCE"
  | "SERIES_ENDED"
  | "CONFLICT";

const STATUS: Record<TaskErrorCode, number> = {
  IDEMPOTENCY_KEY_INVALID: 400,
  IDEMPOTENCY_KEY_STALE: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  VERSION_CONFLICT: 409,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  INVALID_INPUT: 400,
  LINK_NOT_FOUND: 404,
  LINK_LEAD_OPEN: 409,
  NOT_AN_OCCURRENCE: 409,
  NEXT_OCCURRENCE_IN_PROGRESS: 409,
  NOT_LATEST_OCCURRENCE: 409,
  SERIES_ENDED: 409,
  CONFLICT: 409,
};

export class TaskServiceError extends Error {
  readonly status: number;
  constructor(readonly code: TaskErrorCode, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "TaskServiceError";
    this.status = STATUS[code];
  }
}

/** Who acts, from the server-side session only. */
export type TaskActor = { businessId: number; userId: number };
/** The request's Idempotency-Key; `now` is injectable for tests. */
export type TaskRequest = { idempotencyKey: string; now?: Date };

export type TaskLink = { kind: "customer" | "supplier" | "lead" | "document"; id: number } | null;

export type TaskResult = {
  task: Task | null;
  series: TaskSeries | null;
  nextTaskId: number | null;
  withdrawnTaskId: number | null;
  replayed: boolean;
};

const LINK_COLUMN = { customer: "customerId", supplier: "supplierId", lead: "leadId", document: "documentId" } as const;

function linkColumns(link: TaskLink | undefined) {
  if (link === undefined) return {};
  const cols = { customerId: null as number | null, supplierId: null as number | null, leadId: null as number | null, documentId: null as number | null };
  if (link) cols[LINK_COLUMN[link.kind]] = link.id;
  return cols;
}
function linkToken(link: TaskLink | undefined): string | undefined {
  return link ? link.kind : undefined;
}

async function assertLink(tx: TaskTx, businessId: number, link: TaskLink | undefined): Promise<void> {
  if (!link) return;
  if (!Number.isInteger(link.id) || link.id <= 0) throw new TaskServiceError("INVALID_INPUT", { field: "link" });
  const where = { id: link.id, businessId };
  let found = false;
  if (link.kind === "customer") found = !!(await tx.customer.findFirst({ where, select: { id: true } }));
  else if (link.kind === "supplier") found = !!(await tx.supplier.findFirst({ where, select: { id: true } }));
  else if (link.kind === "document") found = !!(await tx.document.findFirst({ where, select: { id: true } }));
  else if (link.kind === "lead") {
    const lead = await tx.lead.findFirst({ where, select: { status: true } });
    found = !!lead;
    // A task on an OPEN lead would be a second follow-up engine: the lead's own nextFollowUpAt is the only
    // slot (spec 3.3). Only a closed lead can be referenced.
    if (lead && !(CLOSED_LEAD_STATUSES as readonly string[]).includes(String(lead.status))) throw new TaskServiceError("LINK_LEAD_OPEN");
  } else throw new TaskServiceError("INVALID_INPUT", { field: "link.kind" });
  if (!found) throw new TaskServiceError("LINK_NOT_FOUND", { kind: link.kind });
}

function assertText(title: string | undefined, note: string | null | undefined) {
  const problem = validateText(title, note);
  if (problem) throw new TaskServiceError("INVALID_INPUT", { problem });
}

function assertDay(field: string, value: unknown): asserts value is JerusalemDayKey {
  if (!isDayKey(value)) throw new TaskServiceError("INVALID_INPUT", { field });
}

function isUniqueViolation(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return e.code === "P2002";
  const msg = e instanceof Error ? e.message : String(e);
  return /23505|unique constraint/i.test(msg);
}

// ── The idempotent envelope ─────────────────────────────────────────────────────────────────────

type Ctx = { tx: TaskTx; businessId: number; userId: number; now: Date; today: JerusalemDayKey; events: JournalEntry[] };

/**
 * One request = one transaction: look for an earlier answer to this key, else do the work, journal it, and
 * record the fingerprint — atomically. A concurrent first request loses on a unique key and is answered from
 * the winner's result in a fresh transaction (never a 500).
 */
async function idempotent(
  actor: TaskActor,
  req: TaskRequest,
  route: string,
  body: unknown,
  work: (ctx: Ctx) => Promise<ResultRef>,
): Promise<TaskResult> {
  const now = req.now ?? new Date();
  const key = req.idempotencyKey;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new TaskServiceError("IDEMPOTENCY_KEY_INVALID");
  const keys = digestKeysFromEnv();
  const ident: RequestIdentity = { route, businessId: actor.businessId, userId: actor.userId, body };
  const digest = { value: requestDigest(keys.current, ident), keyId: keys.current.id };

  const attempt = () =>
    tenantTx(actor.businessId, async (tx) => {
      // 1. The fingerprint ledger — a row older than 7 days counts as absent.
      const fp = await findFingerprint(tx, actor.businessId, key, new Date(now.getTime() - FINGERPRINT_TTL_MS));
      if (fp) {
        const expected = digestWithKeyId(keys, fp.digestKeyId, ident);
        if (!expected || !sameDigest(expected, fp.requestDigest)) throw new TaskServiceError("IDEMPOTENCY_KEY_REUSED");
        return { replay: fp.resultRef as ResultRef };
      }
      // 2. The journal — the second line, for a fingerprint already gone.
      const origin = await findJournalOrigin(tx, actor.businessId, key);
      if (origin) {
        if (!origin.requestDigest || !origin.digestKeyId) throw new TaskServiceError("IDEMPOTENCY_KEY_REUSED");
        const expected = digestWithKeyId(keys, origin.digestKeyId, ident);
        if (!expected || !sameDigest(expected, origin.requestDigest)) throw new TaskServiceError("IDEMPOTENCY_KEY_REUSED");
        const p = (origin.payload ?? {}) as Record<string, unknown>;
        return {
          replay: {
            taskId: origin.taskId ?? (typeof p.firstTaskId === "number" ? p.firstTaskId : undefined),
            seriesId: origin.seriesId ?? undefined,
            nextTaskId: typeof p.nextTaskId === "number" ? p.nextTaskId : undefined,
            withdrawnTaskId: typeof p.withdrawnTaskId === "number" ? p.withdrawnTaskId : undefined,
          } satisfies ResultRef,
        };
      }
      // 3. A new write: only a young key may cause one.
      const verdict = checkIdempotencyKey(key, now);
      if (!verdict.ok) throw new TaskServiceError(verdict.code);
      const ctx: Ctx = { tx, businessId: actor.businessId, userId: actor.userId, now, today: jerusalemDayKey(now), events: [] };
      const result = await work(ctx);
      for (const e of ctx.events) {
        const problem = validatePayload(e.eventType, e.payload);
        if (problem) throw new Error(`task journal payload refused: ${e.eventType}.${problem.key} ${problem.problem}`);
      }
      await appendEvents(tx, actor.businessId, key, digest, now, ctx.events);
      // A fingerprint older than 7 days counts as absent (T-T5); the retention path may not have removed it yet,
      // so it is cleared here (this business, this key only) before the fresh one takes its place.
      await tx.taskRequestLedger.deleteMany({
        where: { businessId: actor.businessId, idempotencyKey: key, createdAt: { lt: new Date(now.getTime() - FINGERPRINT_TTL_MS) } },
      });
      await recordFingerprint(tx, actor.businessId, key, digest, result);
      return { written: result };
    });

  let out: { replay: ResultRef } | { written: ResultRef };
  try {
    out = await attempt();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // A concurrent first request with the same key won (or the state moved under us): answer from what exists.
    try {
      out = await attempt();
    } catch (e2) {
      if (isUniqueViolation(e2)) throw new TaskServiceError("CONFLICT");
      throw e2;
    }
  }
  const ref = "replay" in out ? out.replay : out.written;
  return materialize(actor.businessId, ref, "replay" in out);
}

async function materialize(businessId: number, ref: ResultRef, replayed: boolean): Promise<TaskResult> {
  return tenantTx(businessId, async (tx) => ({
    task: ref.taskId ? await tx.task.findFirst({ where: { id: ref.taskId, businessId } }) : null,
    series: ref.seriesId ? await tx.taskSeries.findFirst({ where: { id: ref.seriesId, businessId } }) : null,
    nextTaskId: ref.nextTaskId ?? null,
    withdrawnTaskId: ref.withdrawnTaskId ?? null,
    replayed,
  }));
}

// ── Helpers inside a request ────────────────────────────────────────────────────────────────────

function own(ctx: Ctx, e: Omit<JournalEntry, "actor" | "actorUserId">) {
  ctx.events.push({ ...e, actor: "OWNER_USER", actorUserId: ctx.userId, payload: compactPayload(e.payload) });
}
function system(ctx: Ctx, e: Omit<JournalEntry, "actor" | "actorUserId">) {
  ctx.events.push({ ...e, actor: "SYSTEM", actorUserId: null, payload: compactPayload(e.payload) });
}

async function loadTask(ctx: Ctx, taskId: number): Promise<Task> {
  if (!Number.isInteger(taskId) || taskId <= 0) throw new TaskServiceError("NOT_FOUND");
  const t = await ctx.tx.task.findFirst({ where: { id: taskId, businessId: ctx.businessId } });
  if (!t) throw new TaskServiceError("NOT_FOUND");
  return t;
}

/** Version-guarded update: the row changes only if nobody changed it since the caller read it. */
async function updateTask(ctx: Ctx, task: Task, expectedVersion: number, data: Prisma.TaskUpdateManyMutationInput): Promise<Task> {
  const n = await ctx.tx.task.updateMany({
    where: { id: task.id, businessId: ctx.businessId, version: expectedVersion },
    data: { ...data, version: { increment: 1 } },
  });
  if (n.count !== 1) {
    const current = await ctx.tx.task.findFirst({ where: { id: task.id, businessId: ctx.businessId } });
    throw new TaskServiceError(current ? "VERSION_CONFLICT" : "NOT_FOUND", { currentVersion: current?.version ?? null });
  }
  return (await ctx.tx.task.findFirst({ where: { id: task.id, businessId: ctx.businessId } }))!;
}

async function updateSeries(ctx: Ctx, series: TaskSeries, expectedVersion: number | null, data: Prisma.TaskSeriesUpdateManyMutationInput): Promise<TaskSeries> {
  const n = await ctx.tx.taskSeries.updateMany({
    where: { id: series.id, businessId: ctx.businessId, ...(expectedVersion === null ? {} : { version: expectedVersion }) },
    data: { ...data, version: { increment: 1 } },
  });
  if (n.count !== 1) throw new TaskServiceError("VERSION_CONFLICT", { currentVersion: series.version });
  return (await ctx.tx.taskSeries.findFirst({ where: { id: series.id, businessId: ctx.businessId } }))!;
}

function ruleOf(s: TaskSeries): SeriesRule {
  switch (s.ruleKind) {
    case "DAILY": return { kind: "DAILY" };
    case "WEEKDAYS": return { kind: "WEEKDAYS", weekdays: s.ruleWeekdays };
    case "MONTH_DAY": return { kind: "MONTH_DAY", monthDay: s.ruleMonthDay ?? 1 };
    case "EVERY_N_DAYS": return { kind: "EVERY_N_DAYS", intervalDays: s.ruleIntervalDays ?? 2 };
  }
}

function ruleColumns(rule: SeriesRule) {
  return {
    ruleKind: rule.kind,
    ruleWeekdays: rule.kind === "WEEKDAYS" ? rule.weekdays : [],
    ruleMonthDay: rule.kind === "MONTH_DAY" ? rule.monthDay : null,
    ruleIntervalDays: rule.kind === "EVERY_N_DAYS" ? rule.intervalDays : null,
  };
}

/** The series' new OPEN occurrence on `dueOn`, created by the system as a consequence of an owner action. */
async function createOccurrence(ctx: Ctx, series: TaskSeries, dueOn: JerusalemDayKey, actor: "OWNER" | "SYSTEM"): Promise<Task> {
  const sequence = (await maxSequence(ctx.tx, ctx.businessId, series.id)) + 1;
  const t = await ctx.tx.task.create({
    data: {
      businessId: ctx.businessId,
      title: series.title,
      description: series.note,
      dueOn: dayKeyToDbDate(dueOn),
      seriesId: series.id,
      sequence,
      origin: "OWNER",
      createdByUserId: actor === "OWNER" ? ctx.userId : null,
      customerId: series.customerId,
      supplierId: series.supplierId,
      leadId: series.leadId,
      documentId: series.documentId,
    },
  });
  const entry = { eventType: "TASK_CREATED" as const, taskId: t.id, seriesId: series.id, payload: { dueOn, seriesSequence: sequence } };
  if (actor === "OWNER") own(ctx, entry);
  else system(ctx, entry);
  return t;
}

async function openOccurrence(ctx: Ctx, seriesId: number): Promise<Task | null> {
  return ctx.tx.task.findFirst({ where: { businessId: ctx.businessId, seriesId, status: "OPEN" } });
}

/**
 * After an occurrence closes (complete / cancel / skip): journal the occurrences it missed, and — for an
 * active series with no other open occurrence — create the next one on the first rule day after today.
 */
async function afterOccurrenceClosed(ctx: Ctx, series: TaskSeries, closed: Task): Promise<Task | null> {
  const rule = ruleOf(series);
  const startOn = dbDateToDayKey(series.startOn);
  const dueOn = closed.dueOn ? dbDateToDayKey(closed.dueOn) : null;
  if (dueOn) {
    const missed = missedOccurrences(rule, startOn, dueOn, ctx.today);
    if (missed.count > 0) system(ctx, { eventType: "OCCURRENCES_MISSED", taskId: closed.id, seriesId: series.id, payload: { count: missed.count, dates: missed.dates } });
  }
  if (series.pausedAt || series.endedAt) return null;
  if (await openOccurrence(ctx, series.id)) return null;
  return createOccurrence(ctx, series, nextOccurrenceAfterClose(rule, startOn, dueOn, ctx.today), "SYSTEM");
}

async function seriesOf(ctx: Ctx, task: Task): Promise<TaskSeries | null> {
  if (!task.seriesId) return null;
  await lockSeries(ctx.tx, ctx.businessId, task.seriesId);
  return ctx.tx.taskSeries.findFirst({ where: { id: task.seriesId, businessId: ctx.businessId } });
}

// ── Tasks ───────────────────────────────────────────────────────────────────────────────────────

export type CreateTaskInput = { title: string; note?: string | null; dueOn?: JerusalemDayKey | null; link?: TaskLink; origin?: "OWNER" | "SECRETARY" };

export function createTask(actor: TaskActor, req: TaskRequest, input: CreateTaskInput): Promise<TaskResult> {
  return idempotent(actor, req, "task.create", input, async (ctx) => {
    assertText(input.title, input.note);
    if (input.dueOn != null) assertDay("dueOn", input.dueOn);
    if (input.origin && input.origin !== "OWNER" && input.origin !== "SECRETARY") throw new TaskServiceError("INVALID_INPUT", { field: "origin" });
    await assertLink(ctx.tx, ctx.businessId, input.link);
    const t = await ctx.tx.task.create({
      data: {
        businessId: ctx.businessId,
        title: input.title.trim(),
        description: input.note ?? null,
        dueOn: input.dueOn ? dayKeyToDbDate(input.dueOn) : null,
        origin: input.origin ?? "OWNER",
        createdByUserId: ctx.userId,
        ...linkColumns(input.link),
      },
    });
    own(ctx, { eventType: "TASK_CREATED", taskId: t.id, payload: { dueOn: input.dueOn ?? undefined, origin: t.origin, link: linkToken(input.link) } });
    return { taskId: t.id };
  });
}

export type EditTaskInput = { expectedVersion: number; title?: string; note?: string | null; link?: TaskLink };

export function editTask(actor: TaskActor, req: TaskRequest, taskId: number, input: EditTaskInput): Promise<TaskResult> {
  return idempotent(actor, req, "task.edit", { taskId, ...input }, async (ctx) => {
    assertText(input.title, input.note);
    await lockTask(ctx.tx, ctx.businessId, taskId);
    const task = await loadTask(ctx, taskId);
    if (!canTransition("EDIT", task.status as TaskState)) throw new TaskServiceError("INVALID_STATE", { status: task.status });
    await assertLink(ctx.tx, ctx.businessId, input.link);
    const fields = [input.title !== undefined && "title", input.note !== undefined && "note", input.link !== undefined && "link"].filter(Boolean) as string[];
    if (fields.length === 0) throw new TaskServiceError("INVALID_INPUT", { problem: "NOTHING_TO_CHANGE" });
    await updateTask(ctx, task, input.expectedVersion, {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.note !== undefined ? { description: input.note } : {}),
      ...linkColumns(input.link),
    });
    own(ctx, { eventType: "TASK_EDITED", taskId, seriesId: task.seriesId, payload: { fields } });
    return { taskId };
  });
}

/** A new due day from a form (RESCHEDULE) or from the agenda (SNOOZE — the learning signal, kept apart). */
function moveTask(kind: "RESCHEDULE" | "SNOOZE") {
  return (actor: TaskActor, req: TaskRequest, taskId: number, input: { expectedVersion: number; dueOn: JerusalemDayKey }): Promise<TaskResult> =>
    idempotent(actor, req, kind === "SNOOZE" ? "task.snooze" : "task.reschedule", { taskId, ...input }, async (ctx) => {
      assertDay("dueOn", input.dueOn);
      const task = await loadTask(ctx, taskId);
      await seriesOf(ctx, task);
      await lockTask(ctx.tx, ctx.businessId, taskId);
      const locked = await loadTask(ctx, taskId);
      if (!canTransition(kind as TaskAction, locked.status as TaskState)) throw new TaskServiceError("INVALID_STATE", { status: locked.status });
      if (kind === "SNOOZE" && input.dueOn <= ctx.today) throw new TaskServiceError("INVALID_INPUT", { field: "dueOn", problem: "SNOOZE_NOT_IN_FUTURE" });
      const from = locked.dueOn ? dbDateToDayKey(locked.dueOn) : undefined;
      await updateTask(ctx, locked, input.expectedVersion, { dueOn: dayKeyToDbDate(input.dueOn) });
      own(ctx, { eventType: kind === "SNOOZE" ? "TASK_SNOOZED" : "TASK_RESCHEDULED", taskId, seriesId: locked.seriesId, payload: { from, to: input.dueOn } });
      return { taskId };
    });
}
export const rescheduleTask = moveTask("RESCHEDULE");
export const snoozeTask = moveTask("SNOOZE");

export function completeTask(actor: TaskActor, req: TaskRequest, taskId: number, input: { expectedVersion: number }): Promise<TaskResult> {
  return idempotent(actor, req, "task.complete", { taskId, ...input }, async (ctx) => {
    const first = await loadTask(ctx, taskId);
    const series = await seriesOf(ctx, first);
    await lockTask(ctx.tx, ctx.businessId, taskId);
    const task = await loadTask(ctx, taskId);
    if (!canTransition("COMPLETE", task.status as TaskState)) throw new TaskServiceError("INVALID_STATE", { status: task.status });
    await updateTask(ctx, task, input.expectedVersion, { status: "DONE", completedAt: ctx.now, completedByUserId: ctx.userId, closeReason: null });
    const dueOn = task.dueOn ? dbDateToDayKey(task.dueOn) : undefined;
    const lateDays = dueOn ? Math.max(0, daysBetweenDayKeys(dueOn, ctx.today)) : undefined;
    const completedIdx = ctx.events.length;
    own(ctx, { eventType: "TASK_COMPLETED", taskId, seriesId: task.seriesId, payload: { dueOn, lateDays } });
    const next = series ? await afterOccurrenceClosed(ctx, series, task) : null;
    if (next) ctx.events[completedIdx].payload.nextTaskId = next.id;
    return { taskId, seriesId: series?.id, nextTaskId: next?.id };
  });
}

function closeTask(kind: "CANCEL" | "SKIP") {
  return (actor: TaskActor, req: TaskRequest, taskId: number, input: { expectedVersion: number }): Promise<TaskResult> =>
    idempotent(actor, req, kind === "SKIP" ? "task.skip" : "task.cancel", { taskId, ...input }, async (ctx) => {
      const first = await loadTask(ctx, taskId);
      const series = await seriesOf(ctx, first);
      await lockTask(ctx.tx, ctx.businessId, taskId);
      const task = await loadTask(ctx, taskId);
      if (kind === "SKIP" && !task.seriesId) throw new TaskServiceError("NOT_AN_OCCURRENCE");
      if (!canTransition(kind, task.status as TaskState)) throw new TaskServiceError("INVALID_STATE", { status: task.status });
      await updateTask(ctx, task, input.expectedVersion, { status: "CANCELED", closeReason: kind === "SKIP" ? "SKIPPED" : null });
      const idx = ctx.events.length;
      own(ctx, { eventType: "TASK_CANCELED", taskId, seriesId: task.seriesId, payload: { closeReason: kind === "SKIP" ? "SKIPPED" : undefined } });
      const next = series ? await afterOccurrenceClosed(ctx, series, task) : null;
      if (next) ctx.events[idx].payload.nextTaskId = next.id;
      return { taskId, seriesId: series?.id, nextTaskId: next?.id };
    });
}
export const cancelTask = closeTask("CANCEL");
export const skipOccurrence = closeTask("SKIP");

/**
 * Reopen (6.1, 6.5). A one-off task simply returns to OPEN. An occurrence may reopen only if it is the series'
 * latest closed one; if the next occurrence is open and untouched since its creation (version 1), it is
 * withdrawn in the same transaction (WITHDRAWN_BY_REOPEN); if it was already acted on, the reopen is refused —
 * two open occurrences never exist.
 */
export function reopenTask(actor: TaskActor, req: TaskRequest, taskId: number, input: { expectedVersion: number }): Promise<TaskResult> {
  return idempotent(actor, req, "task.reopen", { taskId, ...input }, async (ctx) => {
    const first = await loadTask(ctx, taskId);
    const series = await seriesOf(ctx, first);
    await lockTask(ctx.tx, ctx.businessId, taskId);
    const task = await loadTask(ctx, taskId);
    if (!canTransition("REOPEN", task.status as TaskState)) throw new TaskServiceError("INVALID_STATE", { status: task.status });
    let withdrawn: Task | null = null;
    if (series) {
      const laterClosed = await ctx.tx.task.count({
        where: { businessId: ctx.businessId, seriesId: series.id, sequence: { gt: task.sequence ?? 0 }, status: { not: "OPEN" },
                 OR: [{ closeReason: null }, { closeReason: { not: "WITHDRAWN_BY_REOPEN" } }] },
      });
      if (laterClosed > 0) throw new TaskServiceError("NOT_LATEST_OCCURRENCE");
      const open = await openOccurrence(ctx, series.id);
      if (open) {
        if (open.version !== 1 || (open.sequence ?? 0) < (task.sequence ?? 0)) throw new TaskServiceError("NEXT_OCCURRENCE_IN_PROGRESS", { openTaskId: open.id });
        withdrawn = await updateTask(ctx, open, 1, { status: "CANCELED", closeReason: "WITHDRAWN_BY_REOPEN" });
        own(ctx, { eventType: "TASK_CANCELED", taskId: open.id, seriesId: series.id, payload: { closeReason: "WITHDRAWN_BY_REOPEN" } });
      }
    }
    await updateTask(ctx, task, input.expectedVersion, { status: "OPEN", completedAt: null, completedByUserId: null, closeReason: null });
    own(ctx, { eventType: "TASK_REOPENED", taskId, seriesId: task.seriesId, payload: { from: task.status, withdrawnTaskId: withdrawn?.id } });
    return { taskId, seriesId: series?.id, withdrawnTaskId: withdrawn?.id };
  });
}

// ── Series ──────────────────────────────────────────────────────────────────────────────────────

export type CreateSeriesInput = { title: string; note?: string | null; link?: TaskLink; rule: SeriesRule; startOn?: JerusalemDayKey };

export function createSeries(actor: TaskActor, req: TaskRequest, input: CreateSeriesInput): Promise<TaskResult> {
  return idempotent(actor, req, "series.create", input, async (ctx) => {
    assertText(input.title, input.note);
    const problem = validateRule(input.rule);
    if (problem) throw new TaskServiceError("INVALID_INPUT", { field: "rule", problem });
    const rule = normalizeRule(input.rule);
    const startOn = input.startOn ?? ctx.today;
    assertDay("startOn", startOn);
    await assertLink(ctx.tx, ctx.businessId, input.link);
    const series = await ctx.tx.taskSeries.create({
      data: {
        businessId: ctx.businessId,
        title: input.title.trim(),
        note: input.note ?? null,
        startOn: dayKeyToDbDate(startOn),
        createdByUserId: ctx.userId,
        ...ruleColumns(rule),
        ...linkColumns(input.link),
      },
    });
    const idx = ctx.events.length;
    own(ctx, { eventType: "SERIES_CREATED", seriesId: series.id, payload: { ruleKind: rule.kind, startOn } });
    const firstDay = firstOccurrenceOnOrAfter(rule, startOn, startOn > ctx.today ? startOn : ctx.today);
    const first = await createOccurrence(ctx, series, firstDay, "OWNER");
    ctx.events[idx].payload.firstTaskId = first.id;
    return { seriesId: series.id, taskId: first.id };
  });
}

export type ChangeSeriesInput = { expectedVersion: number; title?: string; note?: string | null; rule?: SeriesRule };

/**
 * Title / note apply to the series and its open occurrence (closed ones keep their history). A new rule closes
 * the open occurrence (SERIES_CHANGED) and opens one under the new rule from today, so the history keeps the
 * rule each occurrence was born under.
 */
export function changeSeries(actor: TaskActor, req: TaskRequest, seriesId: number, input: ChangeSeriesInput): Promise<TaskResult> {
  return idempotent(actor, req, "series.change", { seriesId, ...input }, async (ctx) => {
    assertText(input.title, input.note);
    if (!(await lockSeries(ctx.tx, ctx.businessId, seriesId))) throw new TaskServiceError("NOT_FOUND");
    const series = (await ctx.tx.taskSeries.findFirst({ where: { id: seriesId, businessId: ctx.businessId } }))!;
    if (series.endedAt) throw new TaskServiceError("SERIES_ENDED");
    let rule: SeriesRule | null = null;
    if (input.rule) {
      const problem = validateRule(input.rule);
      if (problem) throw new TaskServiceError("INVALID_INPUT", { field: "rule", problem });
      rule = normalizeRule(input.rule);
    }
    const fields = [input.title !== undefined && "title", input.note !== undefined && "note", rule && "rule"].filter(Boolean) as string[];
    if (fields.length === 0) throw new TaskServiceError("INVALID_INPUT", { problem: "NOTHING_TO_CHANGE" });
    const updated = await updateSeries(ctx, series, input.expectedVersion, {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(rule ? { ...ruleColumns(rule), startOn: dayKeyToDbDate(ctx.today) } : {}),
    });
    const open = await openOccurrence(ctx, seriesId);
    let closedId: number | undefined;
    let nextId: number | undefined;
    if (open && rule) {
      await updateTask(ctx, open, open.version, { status: "CANCELED", closeReason: "SERIES_CHANGED" });
      own(ctx, { eventType: "TASK_CANCELED", taskId: open.id, seriesId, payload: { closeReason: "SERIES_CHANGED" } });
      closedId = open.id;
    } else if (open && (input.title !== undefined || input.note !== undefined)) {
      await updateTask(ctx, open, open.version, {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.note !== undefined ? { description: input.note } : {}),
      });
    }
    if (rule && !updated.pausedAt) {
      const day = firstOccurrenceOnOrAfter(rule, ctx.today, ctx.today);
      nextId = (await createOccurrence(ctx, updated, day, "SYSTEM")).id;
    }
    own(ctx, { eventType: "SERIES_CHANGED", seriesId, payload: { fields, ruleKind: rule?.kind, closedTaskId: closedId, nextTaskId: nextId } });
    return { seriesId, taskId: nextId ?? open?.id, nextTaskId: nextId };
  });
}

function seriesState(kind: "PAUSE" | "RESUME" | "END") {
  return (actor: TaskActor, req: TaskRequest, seriesId: number, input: { expectedVersion: number }): Promise<TaskResult> =>
    idempotent(actor, req, `series.${kind.toLowerCase()}`, { seriesId, ...input }, async (ctx) => {
      if (!(await lockSeries(ctx.tx, ctx.businessId, seriesId))) throw new TaskServiceError("NOT_FOUND");
      const series = (await ctx.tx.taskSeries.findFirst({ where: { id: seriesId, businessId: ctx.businessId } }))!;
      if (series.endedAt) throw new TaskServiceError("SERIES_ENDED");
      if (kind === "PAUSE") {
        if (series.pausedAt) throw new TaskServiceError("INVALID_STATE", { problem: "ALREADY_PAUSED" });
        await updateSeries(ctx, series, input.expectedVersion, { pausedAt: ctx.now });
        own(ctx, { eventType: "SERIES_PAUSED", seriesId, payload: {} });
        return { seriesId };
      }
      if (kind === "END") {
        await updateSeries(ctx, series, input.expectedVersion, { endedAt: ctx.now });
        own(ctx, { eventType: "SERIES_ENDED", seriesId, payload: {} });
        return { seriesId };
      }
      if (!series.pausedAt) throw new TaskServiceError("INVALID_STATE", { problem: "NOT_PAUSED" });
      const resumed = await updateSeries(ctx, series, input.expectedVersion, { pausedAt: null });
      const idx = ctx.events.length;
      own(ctx, { eventType: "SERIES_RESUMED", seriesId, payload: {} });
      // An open occurrence stays as it is (6.5); without one, exactly one is created from today.
      if (await openOccurrence(ctx, seriesId)) return { seriesId };
      const day = occurrenceOnResume(ruleOf(resumed), dbDateToDayKey(resumed.startOn), ctx.today);
      const created = await createOccurrence(ctx, resumed, day, "SYSTEM");
      ctx.events[idx].payload.createdTaskId = created.id;
      return { seriesId, taskId: created.id, nextTaskId: created.id };
    });
}
export const pauseSeries = seriesState("PAUSE");
export const resumeSeries = seriesState("RESUME");
export const endSeries = seriesState("END");

/** Calendar day helper re-exported for callers that build agenda days (milestone B). */
export { addCalendarDays };
