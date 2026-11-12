/**
 * "Restore defaults" for the caller (notification engine; flag notifications_engine, OFF ⇒ 404): the caller's own
 * NotificationSettings row and NotificationPreference rows are deleted — everything reads the product default
 * again. Nobody else's rows can be touched: the actor is the session's user.
 */
import { engineActor, json } from "@/lib/notifications/engine/notifications-http";
import { resetPreferences } from "@/lib/notifications/preferences-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const actor = await engineActor(req);
    if (actor instanceof Response) return actor;
    const removed = await resetPreferences(actor);
    return json({ ok: true, removed });
  } catch (e) {
    console.error("[notifications] reset failed", e instanceof Error ? e.name : "unknown");
    return json({ error: "INTERNAL" }, 500);
  }
}
