/**
 * Daily Tasks — the HTTP edge shared by every /api/tasks route (Daily Tasks spec 13). SERVER-ONLY.
 *
 *   - authenticated owner only (401), the business comes from the session — never from the request;
 *   - the `daily_tasks` flag: OFF ⇒ 404, as if the route did not exist (the feature is invisible, not forbidden);
 *   - writes carry an `Idempotency-Key` header (the service checks its form and age);
 *   - TaskServiceError ⇒ its status + a stable code; anything else ⇒ 500 with no detail (public repo, no leaks).
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { AppError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";

import { TaskServiceError, type TaskActor } from "./task.service";

export type TasksRequestContext = { actor: TaskActor };

export class TasksHttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

/** True when the business may see the task centre. Fail-closed: any error reads as OFF. */
export async function dailyTasksEnabled(businessId: number): Promise<boolean> {
  try {
    const r = await runWithTenantContext({ businessId }, () => resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.DAILY_TASKS));
    return r.allowed === true;
  } catch {
    return false;
  }
}

export async function tasksRoute(
  req: Request,
  handler: (ctx: TasksRequestContext) => Promise<Response>,
): Promise<Response> {
  try {
    const user = await getCurrentUser(req);
    if (!user || !user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await dailyTasksEnabled(user.businessId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return await runWithTenantContext({ businessId: user.businessId }, () => handler({ actor: { businessId: user.businessId, userId: user.id } }));
  } catch (e) {
    return tasksError(e);
  }
}

export function tasksError(e: unknown): Response {
  if (e instanceof TaskServiceError) {
    return NextResponse.json({ error: e.code, ...(Object.keys(e.details).length ? { details: e.details } : {}) }, { status: e.status });
  }
  if (e instanceof TasksHttpError) return NextResponse.json({ error: e.code }, { status: e.status });
  // A routed domain action refused by its own service (lead / obligation rules): its status, a stable code.
  if (e instanceof AppError && e.statusCode >= 400 && e.statusCode < 500) {
    return NextResponse.json({ error: e.code ?? "DOMAIN_REJECTED" }, { status: e.statusCode });
  }
  console.error("[tasks] unexpected error", e instanceof Error ? e.name : "unknown");
  return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
}

export function idempotencyKeyOf(req: Request): string {
  const key = req.headers.get("idempotency-key");
  if (!key) throw new TasksHttpError(400, "IDEMPOTENCY_KEY_REQUIRED");
  return key;
}

export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new TasksHttpError(400, "INVALID_JSON");
  }
}

export function positiveId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new TasksHttpError(404, "NOT_FOUND");
  return n;
}

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
