import { changeSeries } from "@/lib/services/tasks/task.service";
import type { SeriesRule } from "@/lib/services/tasks/task-core";
import { idempotencyKeyOf, json, jsonBody, positiveId, tasksRoute } from "@/lib/services/tasks/tasks-http";
import { reminderFollowUp } from "@/lib/services/tasks/reminder-follow-up";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** PATCH — change a series' title / note / rule (spec 6.4: from the next occurrence on). */
export async function PATCH(req: Request, { params }: Params) {
  return tasksRoute(req, async ({ actor }) => {
    const id = positiveId((await params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const result = await changeSeries(actor, { idempotencyKey: key }, id, {
      expectedVersion: Number(b.expectedVersion),
      ...(b.title !== undefined ? { title: b.title as string } : {}),
      ...(b.note !== undefined ? { note: b.note as string | null } : {}),
      ...(b.rule !== undefined ? { rule: b.rule as SeriesRule } : {}),
      ...("dueMinute" in b ? { dueMinute: b.dueMinute as number | null } : {}),
      ...("remindOffsetMinutes" in b ? { remindOffsetMinutes: b.remindOffsetMinutes as number | null } : {}),
    });
    await reminderFollowUp(actor.businessId, result, "schedule");
    return json(result);
  });
}
