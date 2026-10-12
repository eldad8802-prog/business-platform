import { endSeries, pauseSeries, resumeSeries } from "@/lib/services/tasks/task.service";
import { idempotencyKeyOf, json, jsonBody, positiveId, tasksRoute, TasksHttpError } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; action: string }> };

/** POST — pause, resume or end a series (spec 6.4). */
export async function POST(req: Request, { params }: Params) {
  return tasksRoute(req, async ({ actor }) => {
    const { id: rawId, action } = await params;
    const id = positiveId(rawId);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const input = { expectedVersion: Number(b.expectedVersion) };
    const r = { idempotencyKey: key };
    if (action === "pause") return json(await pauseSeries(actor, r, id, input));
    if (action === "resume") return json(await resumeSeries(actor, r, id, input));
    if (action === "end") return json(await endSeries(actor, r, id, input));
    throw new TasksHttpError(404, "NOT_FOUND");
  });
}
