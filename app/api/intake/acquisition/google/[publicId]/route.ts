/**
 * POST /api/intake/acquisition/google/<publicId> — Google Ads lead form webhook.
 *
 * Google sends JSON with the shared key in `google_key` (there is no signature). The endpoint id +
 * that key, matched by hash against the trusted connection, are the ONLY tenant evidence.
 * Google retries 5xx and does not retry 4xx, so:
 *   200 {}  recorded (or a duplicate, or the source is off for the business — a decision, not an outage)
 *   400     malformed / no lead_id;  401 wrong key (incl. unknown endpoint);  413 too large;
 *   429     rate-limited (retry later is acceptable to Google);  503 store unavailable (Google retries).
 */
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { acquisitionReceipt } from "@/lib/intake/acquisition/canonical";
import { ingestAcquisition } from "@/lib/intake/acquisition/ingest";
import { BODY_LIMITS, BodyTooLargeError, readBodyLimited } from "@/lib/intake/acquisition/http";
import { resolveKeyedConnection } from "@/lib/intake/acquisition/resolve";
import { GOOGLE_LEAD_FORM_SOURCE, parseGoogleLead } from "@/lib/intake/acquisition/providers/google-lead-form";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await ctx.params;
  let raw: string;
  try {
    raw = await readBodyLimited(req, BODY_LIMITS["google.lead_form"]);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ error: "too_large" }, { status: 413 });
    throw e;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "malformed" }, { status: 400 });
  }
  const parsed = parseGoogleLead(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.code }, { status: parsed.code === "missing_key" ? 401 : 400 });

  let conn;
  try {
    conn = await resolveKeyedConnection(GOOGLE_LEAD_FORM_SOURCE, publicId, parsed.googleKey);
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  if (!conn) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const limit = await checkRateLimit({ bucket: "ACQUISITION_INTAKE", business: conn.businessId });
  if (!limit.allowed && limit.outcome === "rate_limited") {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } });
  }

  try {
    await ingestAcquisition({
      sourceKey: GOOGLE_LEAD_FORM_SOURCE,
      accountRef: publicId,
      businessId: conn.businessId,
      connectionId: conn.connectionId,
      receipts: [acquisitionReceipt(parsed.lead, publicId)],
    });
    return NextResponse.json({}, { status: 200 });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
