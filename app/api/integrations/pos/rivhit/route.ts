/**
 * /api/integrations/pos/rivhit — the owner's Rivhit connection (S1-A). docs/revenue-sources-s1a-rivhit.md.
 *
 * GET    ?connectionId=<id>   what the poller does for that connection: roles, cursor, backfill, unreadable
 *                             documents, day checks (never the token); without it, the business's Rivhit connections
 * POST   { apiToken, label? } connect: checks the token with Rivhit, binds the company, PROPOSES the type roles
 * PATCH  { connectionId, action: "confirm_types", types }   the owner confirms the roles; reading starts from now
 *        { connectionId, action: "backfill", fromDay }      history from a day, read day by day
 *
 * Signed-in owner only, the business from the session. `pos_rivhit` OFF for the business ⇒ 404, as if the route did not
 * exist. Read-only towards Rivhit: nothing here can create, cancel or change a Rivhit document.
 */
import { NextResponse } from "next/server";
import { withOwner } from "@/lib/intake/acquisition/owner-api";
import { listConnections } from "@/lib/intake/acquisition/connection.service";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { confirmRivhitTypes, connectRivhit, requestRivhitBackfill, rivhitStatus } from "@/lib/revenue-sources/rivhit/connect";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });

async function enabled(businessId: number): Promise<boolean> {
  try {
    return (await resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.POS_RIVHIT)).allowed === true;
  } catch {
    return false;
  }
}

function connectionIdOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function GET(req: Request) {
  return withOwner(req, async ({ businessId }) => {
    if (!(await enabled(businessId))) return notFound();
    const id = connectionIdOf(new URL(req.url).searchParams.get("connectionId"));
    if (id === null) {
      const connections = (await listConnections("pos.rivhit")).filter((c) => c.status !== "REVOKED");
      return NextResponse.json({ connections }, { headers: NO_STORE });
    }
    return NextResponse.json({ status: await rivhitStatus(businessId, id) }, { headers: NO_STORE });
  });
}

export async function POST(req: Request) {
  return withOwner(req, async ({ businessId, userId }) => {
    if (!(await enabled(businessId))) return notFound();
    const body = (await req.json().catch(() => null)) as { apiToken?: unknown; label?: unknown } | null;
    const r = await connectRivhit({ businessId, userId, apiToken: body?.apiToken, label: body?.label });
    return NextResponse.json(r, { status: 201, headers: NO_STORE });
  });
}

export async function PATCH(req: Request) {
  return withOwner(req, async ({ businessId }) => {
    if (!(await enabled(businessId))) return notFound();
    const body = (await req.json().catch(() => null)) as { connectionId?: unknown; action?: unknown; types?: unknown; fromDay?: unknown } | null;
    const id = connectionIdOf(body?.connectionId);
    if (id === null) return NextResponse.json({ error: "connectionId required" }, { status: 400, headers: NO_STORE });
    if (body?.action === "confirm_types") return NextResponse.json(await confirmRivhitTypes(businessId, id, body.types), { headers: NO_STORE });
    if (body?.action === "backfill") return NextResponse.json(await requestRivhitBackfill(businessId, id, body.fromDay), { headers: NO_STORE });
    return NextResponse.json({ error: "unknown action" }, { status: 400, headers: NO_STORE });
  });
}
