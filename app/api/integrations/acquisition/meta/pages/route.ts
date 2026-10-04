/**
 * POST /api/integrations/acquisition/meta/pages — { code } from the owner's own Facebook Login for
 * Business (JS SDK code flow) → the Pages they manage (id, name, whether they may advertise on it)
 * and a short-lived sealed `handle` for the connect step. The code is exchanged server-side; the
 * user token is never returned, logged or stored — only sealed into the handle (10 min, this
 * business only). Requires the Meta source to be enabled and fully configured.
 */
import { NextResponse } from "next/server";
import { sealConnectHandle } from "@/lib/intake/acquisition/connect-handle";
import { isMetaLeadAdsConfigured } from "@/lib/intake/acquisition/meta-config";
import { enabledSources, withOwner } from "@/lib/intake/acquisition/owner-api";
import { exchangeLoginCode, listManagedPages, MetaGraphError } from "@/lib/intake/acquisition/providers/meta-graph";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return withOwner(req, async ({ businessId }) => {
    if (!(await enabledSources(businessId))["meta.lead_ads"]) return NextResponse.json({ error: "source_not_enabled" }, { status: 403 });
    if (!isMetaLeadAdsConfigured()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
    const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code || code.length > 2048) return NextResponse.json({ error: "code required" }, { status: 400 });
    try {
      const token = await exchangeLoginCode(code);
      const pages = await listManagedPages(token);
      return NextResponse.json({
        handle: sealConnectHandle(businessId, token),
        pages: pages.map(({ id, name, canAdvertise }) => ({ id, name, canAdvertise })),
      });
    } catch (e) {
      if (e instanceof MetaGraphError) return NextResponse.json({ error: e.code }, { status: e.code === "provider_error" ? 502 : 403 });
      throw e;
    }
  });
}
