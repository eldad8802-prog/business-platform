/**
 * /api/integrations/acquisition — the owner's connections: lead sources (M6), stores and phone lines (M7).
 *
 * GET   which sources are enabled for the business, whether Meta / the Wix app are connectable, and its
 *       connections (no hash, no token, no key) with the endpoint URL each provider must call and their
 *       activation status (last provider test, last real delivery, deliveries in 30 days — counts and times only).
 * POST  { sourceKey, label?, allowedOrigins? } → a new endpoint:
 *         google.lead_form | web.form | telephony.voicenter   + its key, returned ONCE (only its hash is stored;
 *                                                               Voicenter's key is part of its URL)
 *         telephony.cloudtalk                                  + the endpoint URL; the owner then saves CloudTalk's
 *                                                               signing secret and API key (POST …/<id> set_credentials)
 *       Requires the source to be enabled. Stores connect through /api/integrations/commerce/*,
 *       Meta Pages through /api/integrations/acquisition/meta/*.
 */
import { NextResponse } from "next/server";
import { createKeyedConnection, createSignedConnection, listConnections, readConnectionSecrets } from "@/lib/intake/acquisition/connection.service";
import { isMetaLeadAdsConfigured, metaLoginConfig } from "@/lib/intake/acquisition/meta-config";
import { enabledSources, endpointUrl, withOwner } from "@/lib/intake/acquisition/owner-api";
import { connectionActivity } from "@/lib/intake/acquisition/activity";
import { isConnectionSourceKey } from "@/lib/intake/acquisition/gate";
import { wixAppConfig } from "@/lib/intake/commerce/wix";
import { wixInstallUrl } from "@/lib/intake/commerce/wix-connect";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return withOwner(req, async ({ businessId }) => {
    const [sources, connections] = await Promise.all([enabledSources(businessId), listConnections()]);
    const live = connections.filter((c) => c.status !== "REVOKED");
    const activity = await connectionActivity(businessId, live);
    // CloudTalk: which of the owner's CloudTalk credentials are saved (booleans only — never the values).
    const setup = new Map<number, { signingSecret: boolean; apiKey: boolean }>();
    for (const c of live.filter((x) => x.sourceKey === "telephony.cloudtalk")) {
      const s = await readConnectionSecrets(businessId, c.id, { anyLiveStatus: true }).catch(() => null);
      setup.set(c.id, { signingSecret: !!s?.signingSecret.startsWith("whsec_"), apiKey: !!(s?.apiKeyId && s.apiKeySecret) });
    }
    return NextResponse.json({
      sources,
      // Meta is connectable only when Dubiz's Meta app is fully configured; the public login values
      // (app id, login configuration id) are what the browser needs — no secret is ever sent.
      meta: { available: isMetaLeadAdsConfigured(), login: isMetaLeadAdsConfigured() ? metaLoginConfig() : null },
      // The Dubiz Wix app: connectable only when it is configured and has an install link.
      wix: { available: !!wixAppConfig() && !!wixInstallUrl(), installUrl: wixAppConfig() ? wixInstallUrl() : null },
      connections: connections.map((c) => ({ ...c, endpointUrl: endpointUrl(req, c), activity: activity.get(c.id) ?? null, setup: setup.get(c.id) ?? null })),
    });
  });
}

const CREATABLE = new Set(["google.lead_form", "web.form", "telephony.voicenter", "telephony.cloudtalk"]);

export async function POST(req: Request) {
  return withOwner(req, async ({ businessId, userId }) => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const sourceKey = body?.sourceKey;
    if (!isConnectionSourceKey(sourceKey) || !CREATABLE.has(sourceKey)) {
      return NextResponse.json({ error: "sourceKey must be google.lead_form, web.form, telephony.voicenter or telephony.cloudtalk" }, { status: 400 });
    }
    if (!(await enabledSources(businessId))[sourceKey]) {
      return NextResponse.json({ error: "source_not_enabled" }, { status: 403 });
    }
    if (sourceKey === "telephony.cloudtalk") {
      // A Dubiz placeholder secret until the owner saves CloudTalk's own (deliveries fail closed until then).
      const { connection } = await createSignedConnection({ businessId, userId, sourceKey, label: body?.label ?? "CloudTalk" });
      return NextResponse.json({ connection: { ...connection, endpointUrl: endpointUrl(req, connection) } }, { status: 201 });
    }
    const { connection, key } = await createKeyedConnection({
      businessId,
      userId,
      sourceKey: sourceKey as "google.lead_form" | "web.form" | "telephony.voicenter",
      label: body?.label,
      allowedOrigins: body?.allowedOrigins,
    });
    const url = endpointUrl(req, connection);
    return NextResponse.json(
      {
        connection: { ...connection, endpointUrl: sourceKey === "telephony.voicenter" && url ? url.replace("<key>", key) : url },
        key,
      },
      { status: 201 }
    );
  });
}
