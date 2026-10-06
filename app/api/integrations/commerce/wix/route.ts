/**
 * POST /api/integrations/commerce/wix — { instance } → binds the owner's Wix store (M7-B).
 *
 * Called from Dubiz's Wix landing page by the signed-in owner, with Wix's SIGNED `instance` parameter. The
 * installation is bound to the caller's business only after Wix confirms it is a live installation of Dubiz's
 * app (see lib/intake/commerce/wix-connect.ts). Requires commerce.wix to be enabled for the business.
 */
import { NextResponse } from "next/server";
import { withOwner } from "@/lib/intake/acquisition/owner-api";
import { completeWixConnect } from "@/lib/intake/commerce/wix-connect";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return withOwner(req, async ({ businessId }) => {
    const body = (await req.json().catch(() => null)) as { instance?: unknown } | null;
    const r = await completeWixConnect(businessId, body?.instance);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ connection: r.connection }, { status: 201 });
  });
}
