import { tenantTx } from "@/lib/tenant/tenant-tx";
import { editTask, TaskServiceError, type TaskLink } from "@/lib/services/tasks/task.service";
import { idempotencyKeyOf, json, jsonBody, positiveId, tasksRoute } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** GET — one task of this business and its recent history (the details panel / a deep link). */
export async function GET(req: Request, { params }: Params) {
  return tasksRoute(req, async ({ actor }) => {
    const id = positiveId((await params).id);
    const found = await tenantTx(actor.businessId, async (tx) => {
      const task = await tx.task.findFirst({ where: { id, businessId: actor.businessId } });
      if (!task) return null;
      // The series' recent occurrences tell "בוצע / דולג / באיחור"; a one-off task has its own events only.
      const where = task.seriesId ? { businessId: actor.businessId, seriesId: task.seriesId } : { businessId: actor.businessId, taskId: task.id };
      const events = await tx.taskEvent.findMany({
        where: { ...where, eventType: { in: ["TASK_COMPLETED", "TASK_CANCELED", "TASK_SNOOZED", "TASK_RESCHEDULED", "TASK_REOPENED", "TASK_CREATED"] } },
        orderBy: { id: "desc" },
        take: 12,
        select: { eventType: true, actor: true, occurredAt: true, payload: true },
      });
      return { task, history: events.map((e) => ({ type: e.eventType, actor: e.actor, at: e.occurredAt.toISOString(), payload: e.payload })) };
    });
    if (!found) throw new TaskServiceError("NOT_FOUND");
    return json(found);
  });
}

/** PATCH — edit title / note / link (spec 5.1). Dates move through /[id]/reschedule. */
export async function PATCH(req: Request, { params }: Params) {
  return tasksRoute(req, async ({ actor }) => {
    const id = positiveId((await params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const result = await editTask(actor, { idempotencyKey: key }, id, {
      expectedVersion: Number(b.expectedVersion),
      ...(b.title !== undefined ? { title: b.title as string } : {}),
      ...(b.note !== undefined ? { note: b.note as string | null } : {}),
      ...(b.link !== undefined ? { link: b.link as TaskLink } : {}),
    });
    return json(result);
  });
}
