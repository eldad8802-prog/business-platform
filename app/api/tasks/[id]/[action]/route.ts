import {
  cancelTask,
  completeTask,
  reopenTask,
  rescheduleTask,
  skipOccurrence,
  snoozeTask,
} from "@/lib/services/tasks/task.service";
import { idempotencyKeyOf, json, jsonBody, positiveId, tasksRoute, TasksHttpError } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; action: string }> };

/** POST — a task transition (spec 6.1): complete, cancel, skip, reopen, reschedule, snooze. */
export async function POST(req: Request, { params }: Params) {
  return tasksRoute(req, async ({ actor }) => {
    const { id: rawId, action } = await params;
    const id = positiveId(rawId);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const r = { idempotencyKey: key };
    const expectedVersion = Number(b.expectedVersion);
    switch (action) {
      case "complete":
        return json(await completeTask(actor, r, id, { expectedVersion }));
      case "cancel":
        return json(await cancelTask(actor, r, id, { expectedVersion }));
      case "skip":
        return json(await skipOccurrence(actor, r, id, { expectedVersion }));
      case "reopen":
        return json(await reopenTask(actor, r, id, { expectedVersion }));
      case "reschedule":
        return json(await rescheduleTask(actor, r, id, { expectedVersion, dueOn: b.dueOn as string }));
      case "snooze":
        return json(await snoozeTask(actor, r, id, { expectedVersion, dueOn: b.dueOn as string }));
      default:
        throw new TasksHttpError(404, "NOT_FOUND");
    }
  });
}
