import { NextResponse } from "next/server";

import { runSync } from "@/lib/services/tasks/sync.service";
import { idempotencyKeyOf, tasksRoute } from "@/lib/services/tasks/tasks-http";
import { checkIdempotencyKey } from "@/lib/services/tasks/task-idempotency";
import { TaskServiceError } from "@/lib/services/tasks/task.service";

export const runtime = "nodejs";

/**
 * POST — the write path of system observations (8.6). Idempotent by construction; the key is still required
 * and checked so a client retries with the same key (8.7 step 4). IN_PROGRESS ⇒ 409 + Retry-After.
 */
export async function POST(req: Request) {
  return tasksRoute(req, async ({ actor }) => {
    const key = idempotencyKeyOf(req);
    const verdict = checkIdempotencyKey(key, new Date());
    if (!verdict.ok) throw new TaskServiceError(verdict.code);
    const out = await runSync(actor.businessId);
    if (out.status === "IN_PROGRESS") {
      return NextResponse.json(out, { status: 409, headers: { "Retry-After": String(out.retryAfterSeconds), "Cache-Control": "no-store" } });
    }
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  });
}
