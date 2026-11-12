/**
 * DELETE /api/push/devices/current — the app stops push on THIS device (notification engine): every live device
 * bound to the caller's current login session (the access token's sid) is revoked ('unregistered'). Other devices
 * and sessions are untouched. Idempotent. Not behind the engine flag: ending push is always allowed.
 */
import { getAuthContext } from "@/lib/auth";
import { json } from "@/lib/notifications/engine/notifications-http";
import { revokeSessionDevices } from "@/lib/notifications/engine/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request) {
  try {
    const ctx = await getAuthContext(req);
    if (!ctx?.user?.businessId) return json({ error: "Unauthorized" }, 401);
    if (ctx.sessionId === null) return json({ ok: true, revoked: 0 });
    const revoked = await revokeSessionDevices(ctx.user.businessId, ctx.sessionId, "unregistered", new Date(), { userId: ctx.user.id });
    return json({ ok: true, revoked });
  } catch (e) {
    console.error("[notifications] device unregister failed", e instanceof Error ? e.name : "unknown");
    return json({ error: "INTERNAL" }, 500);
  }
}
