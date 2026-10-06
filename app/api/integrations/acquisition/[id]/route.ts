/**
 * POST /api/integrations/acquisition/<id> — manage one of the owner's connections.
 *   { action: "rotate" }                       Google / website: a new key (shown once), the old dies
 *   { action: "pause" | "resume" }             stop / restart accepting
 *   { action: "set_origins", allowedOrigins }  website browser origins
 *   { action: "set_credentials", signingSecret?, apiKeyId?, apiKeySecret? }
 *                                              CloudTalk: the webhook signing secret (whsec_…) and the API key
 *                                              (call history, for the call's real outcome) — stored ENCRYPTED,
 *                                              never returned; the response says only which are set
 *   { action: "set_line_labels", lineLabels } CloudTalk / Voicenter: the owner's names for their own phone lines
 *                                              ({"<number>": "<name>"}; attribution of the calls on that line)
 *   { action: "revoke" }                       permanent; a Meta Page is also unsubscribed and a WooCommerce
 *                                              store's Dubiz webhooks are removed (best-effort)
 * FORCE RLS confines every action to the caller's business: another business's id is "not found".
 */
import { NextResponse } from "next/server";
import {
  readMetaPageToken,
  revokeConnection,
  rotateKey,
  setAllowedOrigins,
  setLineLabels,
  setPaused,
  listConnections,
  readConnectionSecrets,
  updateConnectionSecrets,
} from "@/lib/intake/acquisition/connection.service";
import { unsubscribePage } from "@/lib/intake/acquisition/providers/meta-graph";
import { endpointUrl, withOwner } from "@/lib/intake/acquisition/owner-api";
import { disconnectWooStore } from "@/lib/intake/commerce/woocommerce-connect";

const WHSEC = /^whsec_[A-Za-z0-9+/=]{24,128}$/;
const API_KEY_PART = /^[A-Za-z0-9_-]{8,128}$/;

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
    if (action === "set_line_labels") {
      const c = await setLineLabels(id, body?.lineLabels);
      return c ? NextResponse.json({ connection: c }) : notFound;
    }
    if (action === "set_credentials") {
      const existing = (await listConnections("telephony.cloudtalk")).find((c) => c.id === id && c.status !== "REVOKED");
      if (!existing) return notFound;
      const patch: Record<string, string> = {};
      const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
      const signingSecret = str(body?.signingSecret);
      const apiKeyId = str(body?.apiKeyId);
      const apiKeySecret = str(body?.apiKeySecret);
      if (signingSecret !== undefined) {
        if (!WHSEC.test(signingSecret)) return NextResponse.json({ error: "signing_secret_invalid" }, { status: 400 });
        patch.signingSecret = signingSecret;
      }
      if (apiKeyId !== undefined || apiKeySecret !== undefined) {
        if (!apiKeyId || !apiKeySecret || !API_KEY_PART.test(apiKeyId) || !API_KEY_PART.test(apiKeySecret)) {
          return NextResponse.json({ error: "api_key_invalid" }, { status: 400 });
        }
        patch.apiKeyId = apiKeyId;
        patch.apiKeySecret = apiKeySecret;
      }
      if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing_to_set" }, { status: 400 });
      if (!(await updateConnectionSecrets(businessId, id, patch))) return notFound;
      const s = await readConnectionSecrets(businessId, id, { anyLiveStatus: true });
      return NextResponse.json({
        connection: { ...existing, endpointUrl: endpointUrl(req, existing) },
        setup: { signingSecret: !!s?.signingSecret.startsWith("whsec_"), apiKey: !!(s?.apiKeyId && s.apiKeySecret) },
      });
    }
    if (action === "revoke") {
      const existing = (await listConnections()).find((c) => c.id === id && c.status !== "REVOKED");
      if (!existing) return notFound;
      if (existing.sourceKey === "meta.lead_ads" && existing.externalResourceId) {
        const cred = await readMetaPageToken(businessId, existing.externalResourceId).catch(() => null);
        if (cred) await unsubscribePage(existing.externalResourceId, cred.token).catch(() => undefined);
      }
      const c = existing.sourceKey === "commerce.woocommerce" ? await disconnectWooStore(businessId, id) : await revokeConnection(id);
      return c ? NextResponse.json({ connection: c }) : notFound;
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  });
}
