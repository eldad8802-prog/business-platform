import { changeSeries } from "@/lib/services/tasks/task.service";
import type { SeriesRule } from "@/lib/services/tasks/task-core";
import { idempotencyKeyOf, json, jsonBody, positiveId, tasksRoute } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** PATCH — change a series' title / note / rule (spec 6.4: from the next occurrence on). */
export async function PATCH(req: Request, { params }: Params) {
  return tasksRoute(req, async ({ actor }) => {
    const id = positiveId((await params).id);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await changeSeries(actor, { idempotencyKey: key }, id, {
      expectedVersion: Number(b.expectedVersion),
      ...(b.title !== undefined ? { title: b.title as string } : {}),
      ...(b.note !== undefined ? { note: b.note as string | null } : {}),
      ...(b.rule !== undefined ? { rule: b.rule as SeriesRule } : {}),
    }));
  });
}
