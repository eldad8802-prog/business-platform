/**
 * The Android app's push device (notification engine; flag notifications_engine, OFF ⇒ 404).
 *
 * POST — { provider: "FCM", token, platform, appVersion? } with the app's normal Bearer auth. Upserts the device by
 *        (business, `fcm:<token>`), bound to the session's user and to THIS login session (the access token's sid —
 *        required: a device is never pushed to once its session ends), revoke cleared; any other live FCM device of
 *        the same session (the app's previous token after a rotation) is revoked 'replaced'. Unknown fields, another
 *        provider, a malformed token / platform / version: 400. The token never appears in a log or an answer.
 */
import { engineActor, json, readJson } from "@/lib/notifications/engine/notifications-http";
import { registerFcmDevice, validateFcmRegistration } from "@/lib/notifications/engine/devices";
import { consumeRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const actor = await engineActor(req);
    if (actor instanceof Response) return actor;
    if (actor.sessionId === null) return json({ error: "SESSION_REQUIRED" }, 400);
    const rl = await consumeRateLimit({ key: `push:devices:u${actor.userId}`, limit: 30, windowMs: 60 * 60_000 });
    if (!rl.allowed) return json({ error: "RATE_LIMITED" }, 429);
    const v = validateFcmRegistration(await readJson(req));
    if (!v.ok) return json({ error: v.error }, 400);
    const out = await registerFcmDevice({ businessId: actor.businessId, userId: actor.userId, sessionId: actor.sessionId }, v.value, new Date());
    return json({ ok: true, id: out.id, replaced: out.replaced }, 201);
  } catch (e) {
    console.error("[notifications] device register failed", e instanceof Error ? e.name : "unknown");
    return json({ error: "INTERNAL" }, 500);
  }
}
