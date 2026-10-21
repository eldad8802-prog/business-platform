/**
 * After a task write, keep the reminder's outside world in step (best effort, never fails the request):
 *   - "schedule" (create / reschedule / snooze / snooze the reminder / reopen / series change): an old reminder in
 *     the bell is no longer the current one → resolved; the new moment gets its exact-moment QStash message;
 *   - "close" (complete / cancel / skip): the reminder in the bell is resolved; the series' next occurrence, if one
 *     was created, gets its message.
 * Correctness never depends on this: the dispatcher claims only an OPEN task whose remindAt is still the due one.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { scheduleReminderMessage } from "./reminder-scheduler";
import { resolveTaskReminderNotifications } from "./task-reminders.service";
import type { TaskResult } from "./task.service";

export async function reminderFollowUp(businessId: number, result: TaskResult, kind: "schedule" | "close"): Promise<void> {
  try {
    const now = new Date();
    const t = result.task;
    if (t) {
      if (kind === "close" || t.status !== "OPEN" || !t.reminderSentAt) await resolveTaskReminderNotifications(businessId, t.id, now);
      if (kind === "schedule" && t.status === "OPEN" && !t.reminderSentAt) await scheduleReminderMessage(t.id, t.remindAt);
    }
    if (result.nextTaskId) {
      const next = await tenantTx(businessId, (tx) =>
        tx.task.findFirst({ where: { id: result.nextTaskId!, businessId }, select: { id: true, remindAt: true, reminderSentAt: true } }),
      );
      if (next && !next.reminderSentAt) await scheduleReminderMessage(next.id, next.remindAt);
    }
  } catch {
    /* best effort */
  }
}
