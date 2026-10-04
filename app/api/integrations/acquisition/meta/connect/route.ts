/**
 * POST /api/integrations/acquisition/meta/connect — { handle, pageId } (handle from …/meta/pages).
 *
 * The owner chose one of THEIR Pages (from their own Facebook Login for Business). The server
 * opens the handle (this business, unexpired) and re-reads the owner's Pages (never trusts a pageId alone), requires the ADVERTISE
 * task (Meta's condition for reading leads), subscribes the Page to `leadgen` for Dubiz's app,
 * then binds Page → this business with the Page token encrypted. A Page live on another business
 * is refused (one live mapping per Page).
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { bindMetaPage } from "@/lib/intake/acquisition/connection.service";
import { openConnectHandle } from "@/lib/intake/acquisition/connect-handle";
import { isMetaLeadAdsConfigured } from "@/lib/intake/acquisition/meta-config";
import { enabledSources, withOwner } from "@/lib/intake/acquisition/owner-api";
import { listManagedPages, MetaGraphError, subscribePage } from "@/lib/intake/acquisition/providers/meta-graph";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return withOwner(req, async ({ businessId, userId }) => {
    if (!(await enabledSources(businessId))["meta.lead_ads"]) return NextResponse.json({ error: "source_not_enabled" }, { status: 403 });
    if (!isMetaLeadAdsConfigured()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
    const body = (await req.json().catch(() => null)) as { handle?: unknown; pageId?: unknown } | null;
    const pageId = typeof body?.pageId === "string" ? body.pageId.trim() : "";
    if (!/^[0-9]{1,32}$/.test(pageId)) return NextResponse.json({ error: "handle and pageId required" }, { status: 400 });
    const token = openConnectHandle(businessId, body?.handle);
    if (!token) return NextResponse.json({ error: "handle_expired" }, { status: 400 });
    try {
      const page = (await listManagedPages(token)).find((p) => p.id === pageId);
      if (!page) return NextResponse.json({ error: "page_not_managed" }, { status: 403 });
      if (!page.canAdvertise) return NextResponse.json({ error: "advertise_task_required" }, { status: 403 });
      await subscribePage(page.id, page.accessToken);
      const connection = await bindMetaPage({ businessId, userId, pageId: page.id, pageName: page.name, pageAccessToken: page.accessToken });
      return NextResponse.json({ connection }, { status: 201 });
    } catch (e) {
      if (e instanceof MetaGraphError) return NextResponse.json({ error: e.code }, { status: e.code === "provider_error" ? 502 : 403 });
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return NextResponse.json({ error: "page_connected_to_another_business" }, { status: 409 });
      }
      throw e;
    }
  });
}
