/**
 * Daily Tasks — reminder dispatch (migration 20261022090000; owner-approved plan 2026-10-21). SERVER-ONLY.
 *
 * Who runs it:
 *   - the dispatcher route (QStash: an exact-moment message per reminder, and a schedule every few minutes as the
 *     safety net), with no session — task_reminders_due() hands it identifiers only;
 *   - the app shell's in-app poll, for the caller's own business (so an open app shows a due reminder within a
 *     minute even if a scheduled call is late).
 *
 * For each due reminder, inside THAT business's tenant transaction:
 *   1. the flag `daily_tasks` must be ON for the business (fail closed: nothing claimed, nothing sent);
 *   2. the CLAIM: one UPDATE sets reminderSentAt only while the task is OPEN, unclaimed, and still has exactly the
 *      remindAt that was found due. Completed, cancelled or snoozed tasks fail it, two dispatchers racing get one
 *      winner — this is what prevents a double send and a stale reminder;
 *   3. a notification row (dedupeKey task-reminder:<task>:<moment>) — the bell shows it until read, so a reminder
 *      that came while the app and the phone were off is still there on the next visit;
 *   4. after commit, Web Push to the live subscriptions of the task's user (its assignee or creator; all the
 *      business's when neither is set), each delivery recorded; 404 / 410 revokes the subscription.
 *
 * Quiet hours do NOT apply: a reminder the owner set for an explicit time is sent at that time (owner decision 3).
 * A reminder is never sent for a moment more than a day old (a long outage must not flood the phone): it is
 * claimed, shown in the bell, and not pushed.
 */
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { sendWebPush, type PushPayload } from "@/lib/push/web-push-sender";
import { clockLabel } from "./task-schedule";
import { dbDateToDayKey } from "./task-core";
import { dailyTasksEnabled } from "./tasks-http";
import { withConnectionRetry } from "@/lib/db/transient-retry";
import { evictDeadConnections } from "@/lib/db/connection-recovery";

export const REMINDER_DOMAIN = "tasks";
export const REMINDER_CATEGORY = "task_reminder";
export const REMINDER_SEVERITY = "REMINDER";
const PUSH_MAX_AGE_MS = 24 * 60 * 60_000;
const BATCH = 100;

export type DueReminder = { businessId: number; taskId: number; remindAt: Date };
export type DispatchOutcome =
  | { taskId: number; result: "sent"; pushed: number; pushFailed: number }
  | { taskId: number; result: "skipped"; reason: "FLAG_OFF" | "NOT_CLAIMED" };

export const reminderDedupeKey = (taskId: number, remindAt: Date) => `task-reminder:${taskId}:${remindAt.toISOString()}`;

/** Due, open, unclaimed reminders of live businesses — identifiers only (the definer function). */
export async function dueReminders(now: Date, limit = BATCH): Promise<DueReminder[]> {
  const rows = await prisma.$queryRaw<{ businessId: number; taskId: number; remindAt: Date }[]>`
    SELECT "businessId", "taskId", "remindAt" FROM public.task_reminders_due(${toUtcTimestamp(now)}::timestamp(3), ${limit}::int)`;
  return rows.map((r) => ({ businessId: Number(r.businessId), taskId: Number(r.taskId), remindAt: fromUtcTimestamp(r.remindAt) }));
}

/**
 * The same due reminders with some businesses left out (task_reminders_due_excluding, migration
 * 20261211090000_notification_engine_followup). DEPLOY ORDER: this code ships only after that migration is applied;
 * if the function is missing anyway, the global pass keeps its first read's flag-on reminders (collectDueSkippingOff).
 */
export async function dueRemindersExcluding(now: Date, limit: number, exclude: number[]): Promise<DueReminder[]> {
  const rows = await prisma.$queryRaw<{ businessId: number; taskId: number; remindAt: Date }[]>`
    SELECT "businessId", "taskId", "remindAt"
      FROM public.task_reminders_due_excluding(${toUtcTimestamp(now)}::timestamp(3), ${limit}::int, ${exclude}::int[])`;
  return rows.map((r) => ({ businessId: Number(r.businessId), taskId: Number(r.taskId), remindAt: fromUtcTimestamp(r.remindAt) }));
}

/** At most this many reads per global pass, and at most this many businesses left out of one read. */
export const STARVATION_MAX_ROUNDS = 5;
export const STARVATION_MAX_EXCLUDED = 1000;

/**
 * The GLOBAL pass's read, without starvation: a business whose `daily_tasks` is OFF keeps its reminders due forever
 * (never claimed — correct), and in the global top-N by remindAt they would fill the batch ahead of every other
 * business. So: read; if the batch holds flag-off businesses, read again with them left out (bounded rounds);
 * return only reminders of flag-on businesses. Nothing is sent to, claimed in or written for a flag-off business,
 * and their reminders' data is not touched. Pure over its two seams (the read and the flag).
 */
export async function collectDueSkippingOff(
  read: (exclude: number[]) => Promise<DueReminder[]>,
  isOn: (businessId: number) => Promise<boolean>,
  opts: { limit: number; maxRounds?: number; maxExcluded?: number },
): Promise<{ due: DueReminder[]; rounds: number; excluded: number[] }> {
  const maxRounds = Math.max(1, opts.maxRounds ?? STARVATION_MAX_ROUNDS);
  const maxExcluded = Math.max(0, opts.maxExcluded ?? STARVATION_MAX_EXCLUDED);
  const flag = new Map<number, boolean>();
  const on = async (b: number) => {
    if (!flag.has(b)) {
      let v = false;
      try {
        v = await isOn(b);
      } catch {
        v = false; // fail closed: an unreadable flag counts as OFF for this pass
      }
      flag.set(b, v);
    }
    return flag.get(b)!;
  };
  const excluded: number[] = [];
  let kept: DueReminder[] = [];
  let rounds = 0;
  while (rounds < maxRounds) {
    let rows: DueReminder[];
    try {
      rows = await read([...excluded]);
    } catch (error) {
      if (rounds === 0) throw error; // the first read is the plain one: its failure is the caller's (retry) concern
      break; // a re-read failed (e.g. the function is not there yet): keep what the previous round found
    }
    rounds += 1;
    const offs: number[] = [];
    kept = [];
    for (const r of rows) {
      if (await on(r.businessId)) kept.push(r);
      else if (!offs.includes(r.businessId)) offs.push(r.businessId);
    }
    if (offs.length === 0 || rows.length < opts.limit) break; // no flag-off noise, or nothing more is due
    const room = maxExcluded - excluded.length;
    if (room <= 0) break;
    excluded.push(...offs.slice(0, room));
  }
  return { due: kept, rounds, excluded };
}

/** Claim, record and push one reminder. Safe to call twice and concurrently: only one call sends. */
export async function dispatchReminder(due: DueReminder, now: Date): Promise<DispatchOutcome> {
  if (!(await dailyTasksEnabled(due.businessId))) return { taskId: due.taskId, result: "skipped", reason: "FLAG_OFF" };

  const claimed = await tenantTx(due.businessId, async (tx) => {
    const n = await tx.task.updateMany({
      where: { id: due.taskId, businessId: due.businessId, status: "OPEN", reminderSentAt: null, remindAt: due.remindAt },
      data: { reminderSentAt: now },
    });
    if (n.count !== 1) return null;
    const task = await tx.task.findFirst({
      where: { id: due.taskId, businessId: due.businessId },
      select: { id: true, title: true, dueOn: true, dueMinute: true, assigneeUserId: true, createdByUserId: true },
    });
    if (!task) return null;
    const href = `/tasks?task=${task.id}`;
    const summary = task.dueOn && task.dueMinute != null ? `לביצוע ב־${clockLabel(task.dueMinute)}` : "תזכורת שקבעת";
    const dedupeKey = reminderDedupeKey(task.id, due.remindAt);
    const notification = await tx.notification.upsert({
      where: { businessId_dedupeKey: { businessId: due.businessId, dedupeKey } },
      create: {
        businessId: due.businessId, dedupeKey, domain: REMINDER_DOMAIN, semanticCategory: REMINDER_CATEGORY,
        severity: REMINDER_SEVERITY, entityType: "task", entityId: task.id, title: task.title || "תזכורת", summary, href,
        intendedChannels: ["IN_APP", "PUSH"], reason: "owner_reminder", cooldownHours: 0,
        firstSurfacedAt: now, lastSurfacedAt: now, lastNotifiedAt: now,
      },
      update: { lastSurfacedAt: now, resolvedAt: null },
      select: { id: true },
    });
    await tx.notificationDelivery.create({
      data: { businessId: due.businessId, notificationId: notification.id, channel: "IN_APP", status: "SENT", attemptedAt: now, createdAt: now },
    });
    const userId = task.assigneeUserId ?? task.createdByUserId;
    const subscriptions = await tx.pushSubscription.findMany({
      where: { businessId: due.businessId, revokedAt: null, ...(userId ? { userId } : {}) },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
      take: 20,
    });
    return { task, href, summary, notificationId: notification.id, subscriptions };
  });
  if (!claimed) return { taskId: due.taskId, result: "skipped", reason: "NOT_CLAIMED" };

  if (now.getTime() - due.remindAt.getTime() > PUSH_MAX_AGE_MS || claimed.subscriptions.length === 0) {
    return { taskId: due.taskId, result: "sent", pushed: 0, pushFailed: 0 };
  }
  const payload: PushPayload = {
    title: claimed.task.title || "תזכורת",
    body: claimed.summary,
    url: claimed.href,
    tag: `task-${claimed.task.id}`,
    taskId: claimed.task.id,
  };
  const results = await Promise.all(claimed.subscriptions.map(async (s) => ({ s, out: await sendWebPush(s, payload) })));
  await tenantTx(due.businessId, async (tx) => {
    for (const { s, out } of results) {
      await tx.notificationDelivery.create({
        data: {
          businessId: due.businessId, notificationId: claimed.notificationId, channel: "PUSH",
          status: out.ok ? "SENT" : "FAILED", attemptedAt: now, createdAt: now,
          error: out.ok ? null : `push_${out.status ?? "error"}`,
        },
      });
      await tx.pushSubscription.updateMany({
        where: { id: s.id, businessId: due.businessId },
        data: out.ok
          ? { lastSuccessAt: now, failureCount: 0 }
          : { lastFailureAt: now, failureCount: { increment: 1 }, ...(out.gone ? { revokedAt: now } : {}) },
      });
    }
  });
  const pushed = results.filter((r) => r.out.ok).length;
  return { taskId: due.taskId, result: "sent", pushed, pushFailed: results.length - pushed };
}

/**
 * The caller's OWN business's due reminders (the in-app poll), read inside its tenant transaction — RLS sees only that
 * business, so another business's reminders can neither crowd it out nor leak in. Same conditions as
 * task_reminders_due(); the business is live by construction (the session gate refuses a business in deletion).
 */
export async function dueRemindersForBusiness(businessId: number, now: Date, limit = BATCH): Promise<DueReminder[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.task.findMany({
      where: { businessId, status: "OPEN", remindAt: { not: null, lte: now }, reminderSentAt: null, erasedAt: null },
      orderBy: [{ remindAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, businessId: true, remindAt: true },
    }),
  );
  return rows.map((r) => ({ businessId: r.businessId, taskId: r.id, remindAt: r.remindAt! }));
}

/**
 * The backstop's lag: it only picks up reminders already this late, so while QStash (an exact-moment message per
 * reminder + a 5-minute schedule) is healthy the backstop finds nothing to do. Must stay above the schedule's cadence.
 */
export const BACKSTOP_LAG_MINUTES = 7;

export type DispatchPassOptions = { onlyBusinessId?: number; minLagMinutes?: number };

/** One dispatcher pass: every due reminder (bounded), optionally for one business only (the in-app poll). */
export async function dispatchDueReminders(now: Date, onlyBusinessIdOrOptions?: number | DispatchPassOptions): Promise<{ due: number; sent: number; skipped: number; pushed: number; pushFailed: number }> {
  const opts: DispatchPassOptions = typeof onlyBusinessIdOrOptions === "number" ? { onlyBusinessId: onlyBusinessIdOrOptions } : onlyBusinessIdOrOptions ?? {};
  const lagMs = Math.max(0, Math.floor(opts.minLagMinutes ?? 0)) * 60_000;
  const cutoff = new Date(now.getTime() - lagMs);
  // A dropped pooled connection fails this first read now and then — several pooled connections can be dead at once
  // after an idle stretch, so the retry first evicts them (connection-recovery.ts) and waits a little longer. The read
  // only lists identifiers (nothing is claimed or written), so reading again is safe. The claim below stays the one
  // guard against a double send. If every attempt fails, nothing was claimed: every reminder stays due for the next pass.
  const first = await withConnectionRetry(
    () => (opts.onlyBusinessId !== undefined ? dueRemindersForBusiness(opts.onlyBusinessId, cutoff) : dueReminders(cutoff)),
    { label: "task-reminders.due", attempts: 3, delayMs: 500, beforeRetry: () => evictDeadConnections(() => (opts.onlyBusinessId !== undefined ? dueRemindersForBusiness(opts.onlyBusinessId, cutoff, 1) : dueReminders(cutoff, 1))) },
  );
  // The global pass leaves flag-off businesses out (re-reading without them) so they cannot starve the others. The
  // per-business poll reads one business only and needs none of this.
  const due = opts.onlyBusinessId !== undefined
    ? first
    : (await collectDueSkippingOff(
        (exclude) => (exclude.length === 0 ? Promise.resolve(first) : dueRemindersExcluding(cutoff, BATCH, exclude)),
        (b) => dailyTasksEnabled(b),
        { limit: BATCH },
      )).due;
  let sent = 0, skipped = 0, pushed = 0, pushFailed = 0;
  for (const d of due) {
    try {
      const out = await dispatchReminder(d, now);
      if (out.result === "sent") { sent += 1; pushed += out.pushed; pushFailed += out.pushFailed; } else skipped += 1;
    } catch {
      skipped += 1; // one bad reminder never blocks the others; it stays due for the next pass
    }
  }
  return { due: due.length, sent, skipped, pushed, pushFailed };
}

/**
 * The task closed (completed / cancelled) or its reminder moved: the bell no longer shows the old reminder as open.
 * Best effort — the dispatcher's own checks are what guarantee no stale send.
 */
export async function resolveTaskReminderNotifications(businessId: number, taskId: number, now: Date): Promise<void> {
  try {
    await tenantTx(businessId, (tx) =>
      tx.notification.updateMany({
        where: { businessId, domain: REMINDER_DOMAIN, entityType: "task", entityId: taskId, resolvedAt: null },
        data: { resolvedAt: now },
      }),
    );
  } catch {
    /* best effort */
  }
}

/** The reminders the owner has not seen yet (for the in-app toast): unread, unresolved, recent. */
export async function unseenReminders(businessId: number, now: Date): Promise<{ id: number; taskId: number; title: string; summary: string | null; href: string; at: string }[]> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const rows = await tenantTx(businessId, (tx) =>
    tx.notification.findMany({
      where: { businessId, domain: REMINDER_DOMAIN, readAt: null, dismissedAt: null, resolvedAt: null, lastSurfacedAt: { gte: since } },
      orderBy: { lastSurfacedAt: "desc" },
      take: 5,
      select: { id: true, entityId: true, title: true, summary: true, href: true, lastSurfacedAt: true },
    }),
  );
  return rows.map((r) => ({ id: r.id, taskId: r.entityId, title: r.title, summary: r.summary, href: r.href, at: r.lastSurfacedAt.toISOString() }));
}

/** The codebase's convention for raw timestamp parameters: a UTC wall-clock string, never the session's zone. */
function toUtcTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}
function fromUtcTimestamp(v: Date | string): Date {
  if (v instanceof Date) return v;
  return new Date(`${String(v).replace(" ", "T")}Z`);
}

export const __test = { toUtcTimestamp, fromUtcTimestamp, dbDateToDayKey };
