/**
 * POST /api/integrations/commerce/woocommerce — { storeUrl } → { authorizeUrl } (M7-B).
 *
 * The owner (signed in) gives their store's address; the browser is sent to the store's OWN approval page
 * (/wc-auth/v1/authorize). The business travels only inside the sealed state Dubiz issues here — the store
 * never names a business. Requires commerce.woocommerce to be enabled for the business.
 */
import { NextResponse } from "next/server";
import { enabledSources, withOwner } from "@/lib/intake/acquisition/owner-api";
import { startWooConnect } from "@/lib/intake/commerce/woocommerce-connect";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return withOwner(req, async ({ businessId }) => {
    if (!(await enabledSources(businessId))["commerce.woocommerce"]) return NextResponse.json({ error: "source_not_enabled" }, { status: 403 });
    const origin = new URL(req.url).origin;
    // WooCommerce sends the keys only to an HTTPS callback.
    if (!origin.startsWith("https://")) return NextResponse.json({ error: "unavailable" }, { status: 503 });
    const body = (await req.json().catch(() => null)) as { storeUrl?: unknown } | null;
    const r = startWooConnect(businessId, origin, typeof body?.storeUrl === "string" ? body.storeUrl : "");
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json(r);
  });
}
