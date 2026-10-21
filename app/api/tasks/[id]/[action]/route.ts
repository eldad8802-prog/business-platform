import {
  cancelTask,
  completeTask,
  pinTask,
  reopenTask,
  rescheduleTask,
  skipOccurrence,
  snoozeReminder,
  snoozeTask,
} from "@/lib/services/tasks/task.service";
import { reminderFollowUp } from "@/lib/services/tasks/reminder-follow-up";
import { idempotencyKeyOf, json, jsonBody, positiveId, tasksRoute, TasksHttpError } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; action: string }> };

/** A form's optional time / reminder: absent keeps them, null clears them. */
function scheduleFields(b: Record<string, unknown>) {
  return {
    ...("dueMinute" in b ? { dueMinute: b.dueMinute as number | null } : {}),
    ...("remindOffsetMinutes" in b ? { remindOffsetMinutes: b.remindOffsetMinutes as number | null } : {}),
  };
}

/**
 * POST — a task transition (spec 6.1): complete, cancel, skip, reopen, reschedule (day, and optionally time and
 * reminder), snooze (the day), snooze-reminder (the reminder only, to `until`); pin / unpin ("חשוב").
 */
export async function POST(req: Request, { params }: Params) {
  return tasksRoute(req, async ({ actor }) => {
    const { id: rawId, action } = await params;
    const id = positiveId(rawId);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const r = { idempotencyKey: key };
    const expectedVersion = Number(b.expectedVersion);
    const done = async (p: ReturnType<typeof completeTask>, kind: "schedule" | "close" | null) => {
      const result = await p;
      if (kind) await reminderFollowUp(actor.businessId, result, kind);
      return json(result);
    };
    switch (action) {
      case "complete":
        return done(completeTask(actor, r, id, { expectedVersion }), "close");
      case "cancel":
        return done(cancelTask(actor, r, id, { expectedVersion }), "close");
      case "skip":
        return done(skipOccurrence(actor, r, id, { expectedVersion }), "close");
      case "reopen":
        return done(reopenTask(actor, r, id, { expectedVersion }), "schedule");
      case "reschedule":
        return done(rescheduleTask(actor, r, id, { expectedVersion, dueOn: b.dueOn as string, ...scheduleFields(b) }), "schedule");
      case "snooze":
        return done(snoozeTask(actor, r, id, { expectedVersion, dueOn: b.dueOn as string }), "schedule");
      case "snooze-reminder":
        return done(snoozeReminder(actor, r, id, { expectedVersion, until: b.until as string }), "schedule");
      case "pin":
      case "unpin":
        return done(pinTask(actor, r, id, { expectedVersion, pinned: action === "pin" }), null);
      default:
        throw new TasksHttpError(404, "NOT_FOUND");
    }
  });
}
