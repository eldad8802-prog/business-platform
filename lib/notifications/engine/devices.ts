/**
 * Push devices and login sessions (notifications track spec, 2026-11-12). SERVER-ONLY.
 *
 *   registerFcmDevice — POST /api/push/devices: upsert by (businessId, `fcm:<token>`), bound to the session's user
 *                       and login session (authSessionId = the request's sid), revoke cleared; any OTHER live FCM
 *                       device of the same session (a rotated token) is revoked 'replaced'.
 *   revokeSessionDevices / revokeUserDevices — the logout hooks and DELETE /api/push/devices/current. Best effort:
 *                       the worker's own session-liveness check (auth_sessions_live) is the guarantee, so a failure
 *                       here never fails the sign-out that called it (the `*BestEffort` wrappers never throw).
 *                       The hooks always revoke the app's FCM devices; WEB PUSH subscriptions only where the engine
 *                       is ON for the business — with it OFF the task / booking reminders keep their existing
 *                       behaviour exactly (a browser's subscription is not ended by a sign-out there).
 *
 * Every write is on the tenant table PushSubscription inside the business's tenant transaction — never an auth
 * table. The business and the user always come from the verified session.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { FCM_TOKEN_PATTERN } from "../push/fcm-client";
import { notificationsEngineEnabled } from "./engine-gate";

export type DeviceRevokeReason = "logout" | "logout_all" | "session_ended" | "replaced" | "gone" | "unregistered";

const PLATFORMS = new Set(["android", "ios", "desktop", "other"]);
const APP_VERSION = /^[0-9A-Za-z.+_-]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FcmRegistration = { token: string; platform: string; appVersion: string | null };

/** Strict validation of the POST body: { provider: "FCM", token, platform, appVersion? } and nothing else. */
export function validateFcmRegistration(body: unknown): { ok: true; value: FcmRegistration } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "INVALID_BODY" };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!["provider", "token", "platform", "appVersion"].includes(k)) return { ok: false, error: "UNKNOWN_FIELD" };
  if (b.provider !== "FCM") return { ok: false, error: "UNSUPPORTED_PROVIDER" };
  if (typeof b.token !== "string" || !FCM_TOKEN_PATTERN.test(b.token)) return { ok: false, error: "INVALID_TOKEN" };
  if (typeof b.platform !== "string" || !PLATFORMS.has(b.platform)) return { ok: false, error: "INVALID_PLATFORM" };
  if (b.appVersion !== undefined && b.appVersion !== null && (typeof b.appVersion !== "string" || !APP_VERSION.test(b.appVersion))) {
    return { ok: false, error: "INVALID_APP_VERSION" };
  }
  return { ok: true, value: { token: b.token, platform: b.platform, appVersion: typeof b.appVersion === "string" ? b.appVersion : null } };
}

export async function registerFcmDevice(
  actor: { businessId: number; userId: number; sessionId: string },
  reg: FcmRegistration,
  now: Date,
): Promise<{ id: number; replaced: number }> {
  if (!UUID.test(actor.sessionId)) throw new Error("registerFcmDevice: a session id is required");
  const endpoint = `fcm:${reg.token}`;
  const { businessId } = actor;
  return tenantTx(businessId, async (tx) => {
    const existing = await tx.pushSubscription.findFirst({ where: { businessId, endpoint }, select: { id: true } });
    const data = {
      userId: actor.userId,
      provider: "FCM",
      platform: reg.platform,
      appVersion: reg.appVersion,
      authSessionId: actor.sessionId,
      revokedAt: null,
      revokedReason: null,
      failureCount: 0,
      lastSeenAt: now,
    };
    const row = existing
      ? await tx.pushSubscription.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.pushSubscription.create({ data: { businessId, endpoint, p256dh: "", auth: "", updatedAt: now, ...data }, select: { id: true } });
    const replaced = await tx.pushSubscription.updateMany({
      where: { businessId, provider: "FCM", authSessionId: actor.sessionId, revokedAt: null, id: { not: row.id } },
      data: { revokedAt: now, revokedReason: "replaced" },
    });
    return { id: row.id, replaced: replaced.count };
  });
}

/** Revoke every live device bound to one login session (FCM and session-bound web push). */
export type ProviderScope = "all" | "fcm_only";
const providerWhere = (scope: ProviderScope) => (scope === "fcm_only" ? { provider: "FCM" } : {});

export async function revokeSessionDevices(
  businessId: number,
  sessionId: string,
  reason: DeviceRevokeReason,
  now: Date,
  opts: { userId?: number; scope?: ProviderScope } = {},
): Promise<number> {
  if (!UUID.test(sessionId)) return 0;
  return tenantTx(businessId, async (tx) =>
    (await tx.pushSubscription.updateMany({
      where: {
        businessId, authSessionId: sessionId, revokedAt: null,
        ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
        ...providerWhere(opts.scope ?? "all"),
      },
      data: { revokedAt: now, revokedReason: reason },
    })).count,
  );
}

/**
 * Revoke a user's live devices: all of them ("log out of every device" — legacy web push included), or, with
 * `exceptSessionId`, every SESSION-BOUND device except the current session's ("end the other sessions").
 */
export async function revokeUserDevices(
  businessId: number,
  userId: number,
  reason: DeviceRevokeReason,
  now: Date,
  opts: { exceptSessionId?: string; scope?: ProviderScope } = {},
): Promise<number> {
  return tenantTx(businessId, async (tx) =>
    (await tx.pushSubscription.updateMany({
      where: {
        businessId,
        userId,
        revokedAt: null,
        ...providerWhere(opts.scope ?? "all"),
        ...(opts.exceptSessionId !== undefined ? { authSessionId: { not: null }, NOT: { authSessionId: opts.exceptSessionId } } : {}),
      },
      data: { revokedAt: now, revokedReason: reason },
    })).count,
  );
}

function logHookFailure(hook: string, error: unknown): void {
  console.warn("[notifications] device revoke failed", JSON.stringify({ hook, error: error instanceof Error ? error.name : "unknown" }));
}

async function hookScope(businessId: number): Promise<ProviderScope> {
  return (await notificationsEngineEnabled(businessId)) ? "all" : "fcm_only";
}

/** Never throws: a logout must not fail because the device bookkeeping did. */
export async function revokeSessionDevicesBestEffort(businessId: number, sessionId: string, reason: DeviceRevokeReason, userId?: number): Promise<void> {
  try {
    await revokeSessionDevices(businessId, sessionId, reason, new Date(), { userId, scope: await hookScope(businessId) });
  } catch (e) {
    logHookFailure(reason, e);
  }
}

/** Never throws. */
export async function revokeUserDevicesBestEffort(businessId: number, userId: number, reason: DeviceRevokeReason, opts: { exceptSessionId?: string } = {}): Promise<void> {
  try {
    await revokeUserDevices(businessId, userId, reason, new Date(), { ...opts, scope: await hookScope(businessId) });
  } catch (e) {
    logHookFailure(reason, e);
  }
}
