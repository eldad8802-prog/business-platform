/**
 * /api/integrations/acquisition — the owner's acquisition sources.
 *
 * GET   which sources are enabled for the business, and its connections (no hash, no token, no key)
 *       with the endpoint URL each provider must call.
 * POST  { sourceKey: "google.lead_form" | "web.form", label?, allowedOrigins? } → a new endpoint and
 *       its key, returned ONCE (only its hash is stored). Requires the source to be enabled.
 * Meta Pages are connected through /api/integrations/acquisition/meta/*.
 */
import { NextResponse } from "next/server";
import { createKeyedConnection, listConnections } from "@/lib/intake/acquisition/connection.service";
import { enabledSources, endpointUrl, isSourceKey, withOwner } from "@/lib/intake/acquisition/owner-api";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return withOwner(req, async ({ businessId }) => {
    const [sources, connections] = await Promise.all([enabledSources(businessId), listConnections()]);
    return NextResponse.json({
      sources,
      connections: connections.map((c) => ({ ...c, endpointUrl: endpointUrl(req, c) })),
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
