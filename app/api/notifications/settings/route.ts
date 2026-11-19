/**
 * The caller's own notification settings (notification engine; flag notifications_engine, OFF ⇒ 404).
 *
 * GET   — the effective settings (stored value or default, per field), the business time zone, and every catalog
 *         category resolved for the caller: available (its feature is on for the business), in-app, push, delivery,
 *         quiet-hours bypass and which aspects are changeable; plus the caller's stored overrides. A category whose
 *         feature is unavailable is reported unavailable — its stored overrides are kept, never deleted here.
 * PATCH — { pushEnabled?, quietHoursEnabled?, quietStartMinute?, quietEndMinute?, digestEnabled?, digestMinute?,
 *           lockScreenDetails?, appointmentReminderMinutes? (30 | 60 | 120 | 1440) }: each a value or null (= back to
 *           the default). Unknown fields, and a lead time outside the four choices, refused (400).
 *
 * The actor is the session's user only: no user id is ever read from the request.
 */
import { businessGates } from "@/lib/notifications/engine/engine-gate";
import { engineActor, json, readJson } from "@/lib/notifications/engine/notifications-http";
import { effectiveSettings, resolveAll, validateSettingsPatch } from "@/lib/notifications/preferences";
import { loadPreferences, patchSettings } from "@/lib/notifications/preferences-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function view(actor: { businessId: number; userId: number }) {
  const stored = await loadPreferences(actor);
  const gates = await businessGates(actor.businessId);
  const settings = effectiveSettings(stored.settings);
  return {
    settings,
    storedSettings: stored.settings,
    timeZone: stored.timeZone,
    categories: resolveAll(settings, stored.prefs, gates.categoryAvailable),
    overrides: stored.prefs,
  };
}

export async function GET(req: Request) {
  try {
    const actor = await engineActor(req);
    if (actor instanceof Response) return actor;
    return json(await view(actor));
  } catch (e) {
    console.error("[notifications] settings read failed", e instanceof Error ? e.name : "unknown");
    return json({ error: "INTERNAL" }, 500);
  }
}

export async function PATCH(req: Request) {
  try {
    const actor = await engineActor(req);
    if (actor instanceof Response) return actor;
    const v = validateSettingsPatch(await readJson(req));
    if (!v.ok) return json({ error: v.error }, 400);
    await patchSettings(actor, v.value, new Date());
    return json(await view(actor));
  } catch (e) {
    console.error("[notifications] settings write failed", e instanceof Error ? e.name : "unknown");
    return json({ error: "INTERNAL" }, 500);
  }
}
