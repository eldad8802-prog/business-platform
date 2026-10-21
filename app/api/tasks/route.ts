import { createTask, type TaskLink } from "@/lib/services/tasks/task.service";
import { idempotencyKeyOf, json, jsonBody, tasksRoute } from "@/lib/services/tasks/tasks-http";
import { reminderFollowUp } from "@/lib/services/tasks/reminder-follow-up";

export const runtime = "nodejs";

/** POST — a manual task (spec 5.1). `origin: "SECRETARY"` when created from the secretary's capture screen. */
export async function POST(req: Request) {
  return tasksRoute(req, async ({ actor }) => {
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const result = await createTask(actor, { idempotencyKey: key }, {
      title: b.title as string,
      note: (b.note as string | null | undefined) ?? null,
      dueOn: (b.dueOn as string | null | undefined) ?? null,
      link: (b.link as TaskLink | undefined) ?? null,
      origin: b.origin === "SECRETARY" ? "SECRETARY" : "OWNER",
      dueMinute: (b.dueMinute as number | null | undefined) ?? null,
      remindOffsetMinutes: (b.remindOffsetMinutes as number | null | undefined) ?? null,
    });
    await reminderFollowUp(actor.businessId, result, "schedule");
    return json(result, result.replayed ? 200 : 201);
  });
}
