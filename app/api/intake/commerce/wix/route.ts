/**
 * POST /api/intake/commerce/wix — the Dubiz Wix app's webhook (M7-B), one endpoint for every installation.
 *
 * The body is a JWT signed by Wix, verified with the app's public key (WIX_APP_PUBLIC_KEY) BEFORE anything else.
 * The installation (instanceId, inside what Wix signed) → the business that connected it (definer lookup;
 * one live mapping per instance). An installation nobody connected is acknowledged and skipped. Wix waits
 * 1250 ms: the receipt is stored, the answer sent, the processing done after.
 *
 *   200  recorded / duplicate / not an order event / unknown installation / source OFF
 *   401  bad signature
 *   503  app not configured, rate-limited or the store is unavailable (Wix retries up to 12 times)
 */
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { BODY_LIMITS, BodyTooLargeError, readBodyLimited } from "@/lib/intake/acquisition/http";
import { ingestAcquisition } from "@/lib/intake/acquisition/ingest";
import { resolveResourceConnection } from "@/lib/intake/acquisition/resolve";
import { logIntake } from "@/lib/intake/core/observability";
import { parseWixOrder, verifyWixWebhook, WIX_ORDER_FQDN, WIX_SOURCE, wixAppConfig } from "@/lib/intake/commerce/wix";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const cfg = wixAppConfig();
  if (!cfg) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  let raw: string;
  try {
    raw = await readBodyLimited(req, BODY_LIMITS[WIX_SOURCE]);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ error: "too_large" }, { status: 413 });
    throw e;
  }
  const env = await verifyWixWebhook(raw, cfg.publicKey);
  if (!env) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  if (env.entityFqdn !== WIX_ORDER_FQDN) return NextResponse.json({}, { status: 200 });

  let conn;
  try {
    conn = await resolveResourceConnection(WIX_SOURCE, env.instanceId);
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  if (!conn) {
    logIntake("skipped", { sourceKey: WIX_SOURCE, code: "unknown_instance", count: 1 });
    return NextResponse.json({}, { status: 200 });
  }
  const parsed = parseWixOrder(env.order, { slug: env.slug, eventId: env.eventId, sequence: env.sequence }, env.instanceId);
  if (!parsed.ok) {
    logIntake("refused", { businessId: conn.businessId, sourceKey: WIX_SOURCE, code: `parse_${parsed.code}` });
    return NextResponse.json({}, { status: 200 }); // a signed body Dubiz cannot read: retrying cannot fix it
  }
  if (!("receipt" in parsed)) return NextResponse.json({}, { status: 200 });
  const limit = await checkRateLimit({ bucket: "ACQUISITION_INTAKE", business: conn.businessId });
  if (!limit.allowed && limit.outcome === "rate_limited") {
    return NextResponse.json({ error: "rate_limited" }, { status: 503, headers: { "retry-after": String(limit.retryAfterSeconds) } });
  }
  try {
    await ingestAcquisition({
      sourceKey: WIX_SOURCE,
      accountRef: env.instanceId,
      businessId: conn.businessId,
      connectionId: conn.connectionId,
      receipts: [parsed.receipt],
    });
    return NextResponse.json({}, { status: 200 });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
