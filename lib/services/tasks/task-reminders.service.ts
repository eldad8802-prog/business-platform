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

/** One dispatcher pass: every due reminder (bounded), optionally for one business only (the in-app poll). */
export async function dispatchDueReminders(now: Date, onlyBusinessId?: number): Promise<{ due: number; sent: number; skipped: number; pushed: number; pushFailed: number }> {
  const due = (await dueReminders(now)).filter((d) => onlyBusinessId === undefined || d.businessId === onlyBusinessId);
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
