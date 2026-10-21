import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { isAllowedPushEndpoint, pushConfigured, vapidConfig } from "@/lib/push/web-push-sender";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { dailyTasksEnabled } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLATFORMS = new Set(["android", "ios", "desktop", "other"]);
const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * GET — is push available, and the application server key to subscribe with (public by definition).
 * POST — this browser accepted push: store (or revive) its subscription for the session's user and business.
 *   Body: { endpoint, keys: { p256dh, auth }, platform }. The endpoint must be a known browser push service
 *   (no arbitrary host is ever called by the server). The business and the user come from the session only.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Push serves task reminders only: while daily_tasks is off for the business, it does not exist.
  if (!(await dailyTasksEnabled(user.businessId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const cfg = vapidConfig();
  return NextResponse.json({ configured: pushConfigured(), publicKey: cfg?.publicKey ?? null });
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // Push serves task reminders only: while daily_tasks is off for the business, it does not exist.
    if (!(await dailyTasksEnabled(user.businessId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!pushConfigured()) return NextResponse.json({ error: "PUSH_NOT_CONFIGURED" }, { status: 503 });
    const b = (await req.json().catch(() => null)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; platform?: unknown } | null;
    const endpoint = typeof b?.endpoint === "string" ? b.endpoint : "";
    const p256dh = typeof b?.keys?.p256dh === "string" ? b.keys.p256dh : "";
    const auth = typeof b?.keys?.auth === "string" ? b.keys.auth : "";
    const platform = typeof b?.platform === "string" && PLATFORMS.has(b.platform) ? b.platform : "other";
    if (!endpoint || endpoint.length > 1024 || !isAllowedPushEndpoint(endpoint)) return NextResponse.json({ error: "INVALID_ENDPOINT" }, { status: 400 });
    if (!B64URL.test(p256dh) || p256dh.length > 200 || !B64URL.test(auth) || auth.length > 64) return NextResponse.json({ error: "INVALID_KEYS" }, { status: 400 });
    const now = new Date();
    const businessId = user.businessId;
    const row = await tenantTx(businessId, async (tx) => {
      const existing = await tx.pushSubscription.findFirst({ where: { businessId, endpoint }, select: { id: true } });
      if (existing) {
        return tx.pushSubscription.update({
          where: { id: existing.id },
          data: { userId: user.id, p256dh, auth, platform, revokedAt: null, failureCount: 0 },
          select: { id: true },
        });
      }
      return tx.pushSubscription.create({ data: { businessId, userId: user.id, endpoint, p256dh, auth, platform, updatedAt: now }, select: { id: true } });
    });
    return NextResponse.json({ ok: true, id: row.id }, { status: 201 });
  } catch {
    console.error("[push] subscribe failed");
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
