/**
 * /api/integrations/acquisition — the owner's acquisition sources.
 *
 * GET   which sources are enabled for the business, whether Meta is connectable, and its connections (no hash, no token, no key)
 *       with the endpoint URL each provider must call and their activation status (last provider test,
 *       last real delivery, deliveries in 30 days — counts and times only).
 * POST  { sourceKey: "google.lead_form" | "web.form", label?, allowedOrigins? } → a new endpoint and
 *       its key, returned ONCE (only its hash is stored). Requires the source to be enabled.
 * Meta Pages are connected through /api/integrations/acquisition/meta/*.
 */
import { NextResponse } from "next/server";
import { createKeyedConnection, listConnections } from "@/lib/intake/acquisition/connection.service";
import { isMetaLeadAdsConfigured, metaLoginConfig } from "@/lib/intake/acquisition/meta-config";
import { enabledSources, endpointUrl, isSourceKey, withOwner } from "@/lib/intake/acquisition/owner-api";
import { connectionActivity } from "@/lib/intake/acquisition/activity";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return withOwner(req, async ({ businessId }) => {
    const [sources, connections] = await Promise.all([enabledSources(businessId), listConnections()]);
    const activity = await connectionActivity(businessId, connections.filter((c) => c.status !== "REVOKED"));
    return NextResponse.json({
      sources,
      // Meta is connectable only when Dubiz's Meta app is fully configured; the public login values
      // (app id, login configuration id) are what the browser needs — no secret is ever sent.
      meta: { available: isMetaLeadAdsConfigured(), login: isMetaLeadAdsConfigured() ? metaLoginConfig() : null },
      connections: connections.map((c) => ({ ...c, endpointUrl: endpointUrl(req, c), activity: activity.get(c.id) ?? null })),
    });
  });
}

export async function POST(req: Request) {
  return withOwner(req, async ({ businessId, userId }) => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const sourceKey = body?.sourceKey;
    if (!isSourceKey(sourceKey) || sourceKey === "meta.lead_ads") {
      return NextResponse.json({ error: "sourceKey must be google.lead_form or web.form" }, { status: 400 });
    }
    if (!(await enabledSources(businessId))[sourceKey]) {
      return NextResponse.json({ error: "source_not_enabled" }, { status: 403 });
    }
    const { connection, key } = await createKeyedConnection({
      businessId,
      userId,
      sourceKey,
      label: body?.label,
      allowedOrigins: body?.allowedOrigins,
    });
    return NextResponse.json({ connection: { ...connection, endpointUrl: endpointUrl(req, connection) }, key }, { status: 201 });
  });
}
