/**
 * Appointments — the HTTP edge shared by every owner appointment route (milestone A). SERVER-ONLY.
 *
 *   - authenticated owner only (401); the business and the user come from the session — never from the request;
 *   - the `appointments` flag: OFF ⇒ 404, as if the route did not exist (the feature is invisible, not forbidden);
 *   - writes carry an `Idempotency-Key` header (the service checks its form and age);
 *   - AppointmentServiceError ⇒ its status + a stable code; anything else ⇒ 500 with no detail.
 * The routes that predate milestone A (POST /api/appointments/[id], the conversation conversion) keep their own edge
 * and are not gated by this flag: switching it never changes them.
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { runWithTenantContext } from "@/lib/tenant/context";

import type { AppointmentPrincipal } from "./appointment-authorization";
import { AppointmentServiceError } from "./appointment-errors";

export type AppointmentsRequestContext = { principal: AppointmentPrincipal };

/** True when the business may use the calendar. Fail-closed: any error reads as OFF. */
export async function appointmentsEnabled(businessId: number): Promise<boolean> {
  try {
    const r = await runWithTenantContext({ businessId }, () => resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.APPOINTMENTS));
    return r.allowed === true;
  } catch {
    return false;
  }
}

export async function appointmentsRoute(
  req: Request,
  handler: (ctx: AppointmentsRequestContext) => Promise<Response>,
): Promise<Response> {
  try {
    const user = await getCurrentUser(req);
    if (!user || !user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await appointmentsEnabled(user.businessId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const principal: AppointmentPrincipal = { kind: "OWNER", businessId: user.businessId, userId: user.id };
    return await runWithTenantContext({ businessId: user.businessId }, () => handler({ principal }));
  } catch (e) {
    return appointmentsError(e);
  }
}

export function appointmentsError(e: unknown): Response {
  if (e instanceof AppointmentServiceError) {
    return NextResponse.json(
      { error: e.code, ...(Object.keys(e.details).length ? { details: e.details } : {}) },
      { status: e.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  console.error("[appointments] unexpected error", e instanceof Error ? e.name : "unknown");
  return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
}

export function idempotencyKeyOf(req: Request): string {
  const key = req.headers.get("idempotency-key");
  if (!key) throw new AppointmentServiceError("IDEMPOTENCY_KEY_INVALID", { header: "missing" });
  return key;
}

export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new AppointmentServiceError("INVALID_INPUT", { field: "body" });
  }
}

/** A route id: a positive integer, or the route answers 404 (never a hint about other businesses' ids). */
export function positiveId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new AppointmentServiceError("NOT_FOUND");
  return n;
}

export function queryOf(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}

/** A numeric query value as a number (or the raw value, for the service to refuse). */
export function numericParam(value: string | undefined): unknown {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
