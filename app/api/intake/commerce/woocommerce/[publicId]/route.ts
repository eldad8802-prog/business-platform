/**
 * POST /api/intake/commerce/woocommerce/<publicId> — a WooCommerce store's order webhook (M7-B).
 *
 * The endpoint id names the connection; the store signs every delivery with the secret Dubiz gave it when it
 * created the webhook (X-WC-Webhook-Signature = base64 HMAC-SHA256 of the raw body), verified BEFORE parsing.
 * The delivering store must also be the one connected (X-WC-Webhook-Source host). Nothing in the payload can
 * choose the business.
 *
 *   200  recorded, a duplicate, the creation ping, a trashed order, or the source is OFF for the business
 *   401  unknown / paused / revoked endpoint, bad signature, another store
 *   400  authenticated but not an order
 *   503  rate-limited or the store is unavailable (WooCommerce never retries: the reconciler recovers)
 */
import { NextResponse } from "next/server";
import { BODY_LIMITS, BodyTooLargeError, readBodyLimited } from "@/lib/intake/acquisition/http";
import { receiveSignedDelivery } from "@/lib/intake/acquisition/receive";
import { resolvePublicConnection } from "@/lib/intake/acquisition/resolve";
import { verifyHmacSha256Base64 } from "@/lib/intake/acquisition/signatures";
import { isWooPing, parseWooOrder, storeHostOf, WOO_SOURCE } from "@/lib/intake/commerce/woocommerce";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await ctx.params;
  let raw: string;
  try {
    raw = await readBodyLimited(req, BODY_LIMITS[WOO_SOURCE]);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ error: "too_large" }, { status: 413 });
    throw e;
  }
  // The creation ping (`webhook_id=<n>`, unsigned) must get exactly 200 — but only for an endpoint that exists.
  if (isWooPing(raw)) {
    const conn = await resolvePublicConnection(WOO_SOURCE, publicId).catch(() => null);
    return conn ? NextResponse.json({ ok: true }, { status: 200 }) : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const signature = req.headers.get("x-wc-webhook-signature");
  const topic = req.headers.get("x-wc-webhook-topic");
  const sourceHost = storeHostOf(req.headers.get("x-wc-webhook-source") ?? "");
  const r = await receiveSignedDelivery({
    sourceKey: WOO_SOURCE,
    publicId,
    raw,
    verify: (secrets) =>
      verifyHmacSha256Base64(raw, signature, secrets.signingSecret) && !!sourceHost && sourceHost === storeHostOf(secrets.siteUrl ?? ""),
    parse: (body) => {
      let order: unknown;
      try {
        order = JSON.parse(body);
      } catch {
        return { ok: false, code: "malformed" };
      }
      const p = parseWooOrder(order, topic, publicId);
      if (!p.ok) return { ok: false, code: p.code };
      return { ok: true, receipts: "receipt" in p ? [p.receipt] : [] };
    },
  });
  return NextResponse.json(r.body, { status: r.status, headers: r.headers });
}
