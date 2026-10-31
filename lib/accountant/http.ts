/**
 * The HTTP edge of the monthly accountant workflow. SERVER-ONLY.
 *
 *   - authenticated owner only (401); the business comes from the session, never from the request;
 *   - the `accountant_month_close` flag: OFF ⇒ 404, as if the route did not exist;
 *   - AccountantError ⇒ its status + a stable code; anything else ⇒ 500 with no detail.
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { runWithTenantContext } from "@/lib/tenant/context";

export type AccountantActor = { businessId: number; userId: number };

export class AccountantError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: Record<string, string | number | boolean> = {}
  ) {
    super(code);
    this.name = "AccountantError";
  }
}

/** True when the business has the monthly workflow. Fail-closed: any error reads as OFF. */
export async function accountantWorkflowEnabled(businessId: number): Promise<boolean> {
  try {
    const r = await runWithTenantContext({ businessId }, () =>
      resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.ACCOUNTANT_MONTH_CLOSE)
    );
    return r.allowed === true;
  } catch {
    return false;
  }
}

/**
 * True when the business may SEND its package from Dubiz (G5 M4: the per-business permission `accountant_delivery`,
 * opened only by a platform admin). Separate from the workflow itself, and from the global master switch
 * ACCOUNTANT_DELIVERY_ENABLED — sending needs both. Fail-closed: any error reads as NOT permitted.
 */
export async function accountantDeliveryPermitted(businessId: number): Promise<boolean> {
  try {
    const r = await runWithTenantContext({ businessId }, () =>
      resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.ACCOUNTANT_DELIVERY)
    );
    return r.allowed === true;
  } catch {
    return false;
  }
}

export async function accountantRoute(
  req: Request,
  handler: (actor: AccountantActor) => Promise<Response>
): Promise<Response> {
  try {
    const user = await getCurrentUser(req);
    if (!user || !user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await accountantWorkflowEnabled(user.businessId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return await runWithTenantContext({ businessId: user.businessId }, () =>
      handler({ businessId: user.businessId, userId: user.id })
    );
  } catch (e) {
    return accountantError(e);
  }
}

export function accountantError(e: unknown): Response {
  if (e instanceof AccountantError) {
    return NextResponse.json(
      { error: e.code, ...(Object.keys(e.details).length ? { details: e.details } : {}) },
      { status: e.status, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  console.error("[accountant] unexpected error", e instanceof Error ? e.name : "unknown");
  return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
}

export function json(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new AccountantError(400, "INVALID_JSON");
  }
}

export function positiveId(raw: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new AccountantError(404, "NOT_FOUND");
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n > 2_147_483_647) throw new AccountantError(404, "NOT_FOUND");
  return n;
}
