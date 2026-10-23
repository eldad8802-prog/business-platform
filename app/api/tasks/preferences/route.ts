import { getServerI18n } from "@/lib/i18n/server";
import { getPreferences, setSourceEnabled } from "@/lib/services/tasks/preferences.service";
import { idempotencyKeyOf, json, jsonBody, tasksRoute } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — which of the eight sources are on. */
export async function GET(req: Request) {
  return tasksRoute(req, async ({ actor }) => {
    const { t } = await getServerI18n();
    return json(await getPreferences(actor.businessId, t));
  });
}

/** PUT — switch one source on or off: { kind, enabled }. */
export async function PUT(req: Request) {
  return tasksRoute(req, async ({ actor }) => {
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const { t } = await getServerI18n();
    return json(await setSourceEnabled(actor, { idempotencyKey: key }, String(b.kind ?? ""), b.enabled as boolean, t));
  });
}
