/**
 * One override of the caller's own (notification engine; flag notifications_engine, OFF ⇒ 404).
 *
 * PUT    /api/notifications/settings/preferences/<key> — { inApp?, push?, delivery? } (each a value or null).
 * DELETE /api/notifications/settings/preferences/<key> — remove the override.
 *
 * <key> is `domain:<a catalog domain>` or `category:<a catalog category>`; anything else is 400 UNKNOWN_KEY. An
 * aspect the category does not let the user change (security in-app) is 400 NOT_MUTABLE. The actor is the
 * session's user only.
 */
import { engineActor, json, readJson } from "@/lib/notifications/engine/notifications-http";
import { validatePreferenceBody, validatePreferenceKey } from "@/lib/notifications/preferences";
import { deletePreference, putPreference } from "@/lib/notifications/preferences-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

async function keyOf(ctx: Ctx) {
  const { key } = await ctx.params;
  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    return validatePreferenceKey(null);
  }
  return validatePreferenceKey(decoded);
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const actor = await engineActor(req);
    if (actor instanceof Response) return actor;
    const k = await keyOf(ctx);
    if (!k.ok) return json({ error: k.error }, 400);
    const b = validatePreferenceBody(await readJson(req), k.value.categories);
    if (!b.ok) return json({ error: b.error }, 400);
    await putPreference(actor, k.value.key, b.value, new Date());
    return json({ ok: true, key: k.value.key, ...b.value });
  } catch (e) {
    console.error("[notifications] preference write failed", e instanceof Error ? e.name : "unknown");
    return json({ error: "INTERNAL" }, 500);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const actor = await engineActor(req);
    if (actor instanceof Response) return actor;
    const k = await keyOf(ctx);
    if (!k.ok) return json({ error: k.error }, 400);
    const removed = await deletePreference(actor, k.value.key);
    return json({ ok: true, removed });
  } catch (e) {
    console.error("[notifications] preference delete failed", e instanceof Error ? e.name : "unknown");
    return json({ error: "INTERNAL" }, 500);
  }
}
