/**
 * POST /api/intake/acquisition/web/<publicId> — a submission from the business's website form.
 *
 * Tenant: ONLY the trusted connection behind <publicId> (never a field in the request).
 *   server mode   Authorization: Bearer <key>  → m6_acquisition_resolve_keyed (key hash match)
 *   browser mode  no key → m6_acquisition_resolve_public, and the request Origin must be one the
 *                 owner allowed for this endpoint; honeypot + per-IP / per-business limits.
 * Answers: 202 {ok:true} once durably recorded (or a duplicate / honeypot, silently);
 * 400 malformed / no contact; 401 bad key; 403 origin not allowed; 404 unknown / disabled endpoint;
 * 413 too large; 429 rate-limited; 503 store unavailable (retry).
 */
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { getClientIp } from "@/lib/security/rate-limit";
import { acquisitionReceipt } from "@/lib/intake/acquisition/canonical";
import { ingestAcquisition } from "@/lib/intake/acquisition/ingest";
import { BODY_LIMITS, BodyTooLargeError, parseBody, readBodyLimited } from "@/lib/intake/acquisition/http";
import { resolveKeyedConnection, resolvePublicConnection } from "@/lib/intake/acquisition/resolve";
import { flattenFields, parseWebForm, WEB_FORM_SOURCE } from "@/lib/intake/acquisition/providers/web-form";

export const runtime = "nodejs";

function cors(origin: string | null, allowed: boolean): Record<string, string> {
  return allowed && origin
    ? { "access-control-allow-origin": origin, vary: "origin", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" }
    : { vary: "origin" };
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S{8,200})$/i.exec(h.trim());
  return m ? m[1] : null;
}

/** Browser preflight: answered only for an origin the owner allowed on a live endpoint. */
export async function OPTIONS(req: Request, ctx: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await ctx.params;
  const origin = req.headers.get("origin");
  const conn = await resolvePublicConnection(WEB_FORM_SOURCE, publicId).catch(() => null);
  const allowed = !!conn && !!origin && conn.allowedOrigins.includes(origin);
  return new NextResponse(null, { status: allowed ? 204 : 403, headers: { ...cors(origin, allowed), "access-control-max-age": "600" } });
}

export async function POST(req: Request, ctx: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await ctx.params;
  const origin = req.headers.get("origin");
  const key = bearer(req);

  let conn: { connectionId: number; businessId: number } | null;
  let browser = false;
  try {
    if (key) {
      conn = await resolveKeyedConnection(WEB_FORM_SOURCE, publicId, key);
      if (!conn) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    } else {
      const pub = await resolvePublicConnection(WEB_FORM_SOURCE, publicId);
      if (!pub) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      if (!origin || !pub.allowedOrigins.includes(origin)) {
        return NextResponse.json({ ok: false, error: "origin_not_allowed" }, { status: 403, headers: cors(origin, false) });
      }
      conn = pub;
      browser = true;
    }
  } catch {
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  const headers = cors(origin, browser);

  const limit = await checkRateLimit(
    browser
      ? { bucket: "ACQUISITION_WEB_PUBLIC", business: conn.businessId, ip: getClientIp(req) }
      : { bucket: "ACQUISITION_INTAKE", business: conn.businessId }
  );
  if (!limit.allowed && limit.outcome === "rate_limited") {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429, headers: { ...headers, "retry-after": String(limit.retryAfterSeconds) } });
  }

  let raw: string;
  try {
    raw = await readBodyLimited(req, BODY_LIMITS["web.form"]);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413, headers });
    throw e;
  }
  const fields = flattenFields(parseBody(raw, req.headers.get("content-type")));
  if (!fields) return NextResponse.json({ ok: false, error: "malformed" }, { status: 400, headers });
  const parsed = parseWebForm(fields);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.code }, { status: 400, headers });
  // A bot filled the honeypot: answer like a success, record nothing.
  if (parsed.honeypot) return NextResponse.json({ ok: true }, { status: 202, headers });

  try {
    const out = await ingestAcquisition({
      sourceKey: WEB_FORM_SOURCE,
      accountRef: publicId,
      businessId: conn.businessId,
      connectionId: conn.connectionId,
      receipts: [acquisitionReceipt(parsed.lead, publicId)],
    });
    if (out.status === "refused") return NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers });
    return NextResponse.json({ ok: true }, { status: 202, headers });
  } catch {
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503, headers });
  }
}
