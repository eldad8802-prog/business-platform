/**
 * POST /api/integrations/acquisition/<id> — manage one of the owner's connections.
 *   { action: "rotate" }                       Google / website: a new key (shown once), the old dies
 *   { action: "pause" | "resume" }             stop / restart accepting
 *   { action: "set_origins", allowedOrigins }  website browser origins
 *   { action: "revoke" }                       permanent; a Meta Page is also unsubscribed (best-effort)
 * FORCE RLS confines every action to the caller's business: another business's id is "not found".
 */
import { NextResponse } from "next/server";
import {
  readMetaPageToken,
  revokeConnection,
  rotateKey,
  setAllowedOrigins,
  setPaused,
  listConnections,
} from "@/lib/intake/acquisition/connection.service";
import { unsubscribePage } from "@/lib/intake/acquisition/providers/meta-graph";
import { endpointUrl, withOwner } from "@/lib/intake/acquisition/owner-api";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: raw } = await ctx.params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return withOwner(req, async ({ businessId }) => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const action = body?.action;
    const notFound = NextResponse.json({ error: "not_found" }, { status: 404 });
    if (action === "rotate") {
      const r = await rotateKey(id);
      return r ? NextResponse.json({ connection: { ...r.connection, endpointUrl: endpointUrl(req, r.connection) }, key: r.key }) : notFound;
    }
    if (action === "pause" || action === "resume") {
      const c = await setPaused(id, action === "pause");
      return c ? NextResponse.json({ connection: c }) : notFound;
    }
    if (action === "set_origins") {
      const c = await setAllowedOrigins(id, body?.allowedOrigins);
      return c ? NextResponse.json({ connection: c }) : notFound;
    }
    if (action === "revoke") {
      const existing = (await listConnections()).find((c) => c.id === id && c.status !== "REVOKED");
      if (!existing) return notFound;
      if (existing.sourceKey === "meta.lead_ads" && existing.externalResourceId) {
        const cred = await readMetaPageToken(businessId, existing.externalResourceId).catch(() => null);
        if (cred) await unsubscribePage(existing.externalResourceId, cred.token);
      }
      const c = await revokeConnection(id);
      return c ? NextResponse.json({ connection: c }) : notFound;
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  });
}
