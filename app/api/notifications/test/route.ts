/**
 * A test push to the CALLER's own devices (notification engine; flag notifications_engine, OFF ⇒ 404).
 *
 * POST — records one notification of category system.test for the session's user only (userId = the caller) with
 * one owed push, then runs the worker for exactly that owed row: it reaches only the caller's live devices (a live
 * login session for the Android app), never anyone else's. Rate limited per user (3 per 10 minutes). The answer is
 * counts only.
 */
import { runPushWorker } from "@/lib/notifications/engine/push-worker";
import { engineActor, json } from "@/lib/notifications/engine/notifications-http";
import { notify } from "@/lib/notifications/engine/notify";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const actor = await engineActor(req);
    if (actor instanceof Response) return actor;
    const rl = await consumeRateLimit({ key: `notifications:test:u${actor.userId}`, limit: 3, windowMs: 10 * 60_000 });
    if (!rl.allowed) return json({ error: "RATE_LIMITED" }, 429);
    const now = new Date();
    const out = await tenantTx(actor.businessId, (tx) =>
      notify(tx, {
        businessId: actor.businessId,
        category: "system.test",
        entity: { type: "test", id: actor.userId },
        dedupeKey: `test:u${actor.userId}:${now.getTime()}`,
        title: "התראת בדיקה",
        summary: "זו התראת בדיקה",
        href: "/notifications",
        userId: actor.userId,
        now,
      }),
    );
    if (out.owedDeliveryId === null) return json({ ok: true, sent: 0, failed: 0, suppressed: 0 });
    const report = await runPushWorker(now, { businessId: actor.businessId, deliveryIds: [out.owedDeliveryId], quiet: true });
    return json({
      ok: true,
      sent: report.devicesSent,
      failed: report.devicesFailed,
      suppressed: report.suppressed,
      retrying: report.retried,
    });
  } catch (e) {
    console.error("[notifications] test push failed", e instanceof Error ? e.name : "unknown");
    return json({ error: "INTERNAL" }, 500);
  }
}
