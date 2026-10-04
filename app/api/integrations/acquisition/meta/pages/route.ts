/**
 * POST /api/integrations/acquisition/meta/pages — { userAccessToken } from the owner's own Facebook
 * Login for Business → the Pages they manage (id, name, whether they may advertise on it). The user
 * token is used for this call only and never stored; no Page token is returned to the browser.
 * Requires the Meta source to be enabled for the business.
 */
import { NextResponse } from "next/server";
import { enabledSources, withOwner } from "@/lib/intake/acquisition/owner-api";
import { listManagedPages, MetaGraphError } from "@/lib/intake/acquisition/providers/meta-graph";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return withOwner(req, async ({ businessId }) => {
    if (!(await enabledSources(businessId))["meta.lead_ads"]) return NextResponse.json({ error: "source_not_enabled" }, { status: 403 });
    const body = (await req.json().catch(() => null)) as { userAccessToken?: unknown } | null;
    const token = typeof body?.userAccessToken === "string" ? body.userAccessToken.trim() : "";
    if (!token || token.length > 1024) return NextResponse.json({ error: "userAccessToken required" }, { status: 400 });
    try {
      const pages = await listManagedPages(token);
      return NextResponse.json({ pages: pages.map(({ id, name, canAdvertise }) => ({ id, name, canAdvertise })) });
    } catch (e) {
      if (e instanceof MetaGraphError) return NextResponse.json({ error: e.code }, { status: e.code === "provider_error" ? 502 : 403 });
      throw e;
    }
  });
}
