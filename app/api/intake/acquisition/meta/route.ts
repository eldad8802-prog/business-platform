/**
 * /api/intake/acquisition/meta — Meta Lead Ads webhook (Facebook + Instagram lead ads).
 *
 * GET   subscription handshake: hub.mode=subscribe + hub.verify_token (constant-time) → hub.challenge.
 * POST  X-Hub-Signature-256 = HMAC-SHA256(app secret, raw body), verified BEFORE parsing. Each
 *       `leadgen` change names a Page; the Page id (inside the signed body) → the business that
 *       connected that Page (definer lookup). A Page nobody connected is skipped, never routed.
 *       Receipts are references; the answers are read with the Page token in the processor's
 *       hydrate step, after the 200.
 * Config: the Meta app secret (META_LEAD_ADS_APP_SECRET, else the app's WHATSAPP_APP_SECRET) and
 * META_LEAD_ADS_VERIFY_TOKEN (Dubiz's own value). Missing → 503 (fail closed).
 * Answers: 200 once every Page's receipts are durable; 401 bad signature; 413 too large;
 * 503 config / store unavailable (Meta retries for up to ~36 h).
 */
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { ingestAcquisition } from "@/lib/intake/acquisition/ingest";
import { BODY_LIMITS, BodyTooLargeError, readBodyLimited } from "@/lib/intake/acquisition/http";
import { safeEqual } from "@/lib/intake/acquisition/keys";
import { resolveResourceConnection } from "@/lib/intake/acquisition/resolve";
import { logIntake } from "@/lib/intake/core/observability";
import { metaAppSecret, metaVerifyToken } from "@/lib/intake/acquisition/meta-config";
import {
  META_LEAD_ADS_SOURCE,
  metaReferenceReceipt,
  parseMetaLeadgenWebhook,
  verifyMetaSignature,
} from "@/lib/intake/acquisition/providers/meta-lead-ads";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const expected = metaVerifyToken();
  if (!expected) return new NextResponse("unavailable", { status: 503 });
  const u = new URL(req.url);
  const mode = u.searchParams.get("hub.mode");
  const token = u.searchParams.get("hub.verify_token") ?? "";
  const challenge = u.searchParams.get("hub.challenge") ?? "";
  if (mode !== "subscribe" || !safeEqual(token, expected) || !/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) {
    return new NextResponse("forbidden", { status: 403 });
  }
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

export async function POST(req: Request) {
  const secret = metaAppSecret();
  if (!secret) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  let raw: string;
  try {
    raw = await readBodyLimited(req, BODY_LIMITS["meta.lead_ads"]);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ error: "too_large" }, { status: 413 });
    throw e;
  }
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "malformed" }, { status: 400 });
  }
  const parsed = parseMetaLeadgenWebhook(body);
  // A signed body that is not a Page leadgen delivery: acknowledge (nothing to do), never retry.
  if (!parsed.ok) return NextResponse.json({ ok: true }, { status: 200 });

  try {
    for (const [pageId, refs] of parsed.byPage) {
      const conn = await resolveResourceConnection(META_LEAD_ADS_SOURCE, pageId);
      if (!conn) {
        logIntake("skipped", { sourceKey: META_LEAD_ADS_SOURCE, code: "unknown_page", count: refs.length });
        continue;
      }
      const limit = await checkRateLimit({ bucket: "ACQUISITION_INTAKE", business: conn.businessId });
      if (!limit.allowed && limit.outcome === "rate_limited") {
        // Meta retries a non-2xx delivery; nothing of this delivery was lost.
        return NextResponse.json({ error: "rate_limited" }, { status: 429 });
      }
      await ingestAcquisition({
        sourceKey: META_LEAD_ADS_SOURCE,
        accountRef: pageId,
        businessId: conn.businessId,
        connectionId: conn.connectionId,
        receipts: refs.map(metaReferenceReceipt),
      });
    }
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}
