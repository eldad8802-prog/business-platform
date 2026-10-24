import { createSeries, type TaskLink } from "@/lib/services/tasks/task.service";
import type { SeriesRule } from "@/lib/services/tasks/task-core";
import { idempotencyKeyOf, json, jsonBody, tasksRoute } from "@/lib/services/tasks/tasks-http";
import { reminderFollowUp } from "@/lib/services/tasks/reminder-follow-up";

export const runtime = "nodejs";

/** POST — a recurring task (spec 5.1, 6.4): the series and its first occurrence, in one transaction. */
export async function POST(req: Request) {
  return tasksRoute(req, async ({ actor }) => {
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const result = await createSeries(actor, { idempotencyKey: key }, {
      title: b.title as string,
      note: (b.note as string | null | undefined) ?? null,
      link: (b.link as TaskLink | undefined) ?? null,
      rule: b.rule as SeriesRule,
      ...(typeof b.startOn === "string" ? { startOn: b.startOn } : {}),
      dueMinute: (b.dueMinute as number | null | undefined) ?? null,
      remindOffsetMinutes: (b.remindOffsetMinutes as number | null | undefined) ?? null,
    });
    await reminderFollowUp(actor.businessId, result, "schedule");
    return json(result, result.replayed ? 200 : 201);
  });
}
