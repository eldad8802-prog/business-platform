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
 * A plain HTML form post from an allowed site (browser mode, Accept: text/html) gets the same outcome
 * as a short Hebrew page (200 on success) with a link back to the site, instead of JSON.
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

/**
 * A plain HTML form (no script) navigates the visitor's browser to this endpoint. It gets a short
 * Hebrew page — never JSON — with a way back to the business's own site. Only for browser mode,
 * only for a form post that asks for HTML; the back link is the referring page when it belongs to
 * an allowed origin, else that origin. Nothing the visitor typed is echoed.
 */
function wantsHtml(req: Request, browser: boolean): boolean {
  if (!browser) return false;
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  const accept = (req.headers.get("accept") ?? "").toLowerCase();
  return ct.includes("application/x-www-form-urlencoded") && accept.includes("text/html");
}

const PAGE_TEXT: Record<string, [string, string]> = {
  ok: ["תודה! הפנייה התקבלה", "נחזור אליך בהקדם."],
  no_contact: ["חסרים פרטי קשר", "כדי שנוכל לחזור אליך, צריך למלא טלפון או אימייל."],
  malformed: ["לא הצלחנו לקרוא את הטופס", "אפשר לנסות לשלוח שוב."],
  too_large: ["הפנייה ארוכה מדי", "אפשר לקצר את ההודעה ולשלוח שוב."],
  rate_limited: ["נשלחו הרבה פניות ברגע", "אפשר לנסות שוב בעוד דקה."],
  unavailable: ["משהו השתבש אצלנו", "הפנייה לא נשמרה — אפשר לנסות שוב בעוד רגע."],
};

function backLink(req: Request, allowed: string[]): string | null {
  const ref = req.headers.get("referer");
  try {
    if (ref) {
      const u = new URL(ref);
      if (allowed.includes(u.origin) && (u.protocol === "https:" || u.protocol === "http:")) return u.toString();
    }
  } catch {
    /* fall through */
  }
  const origin = req.headers.get("origin");
  return origin && allowed.includes(origin) ? origin : null;
}

function htmlPage(code: keyof typeof PAGE_TEXT, status: number, back: string | null): NextResponse {
  const [title, line] = PAGE_TEXT[code] ?? PAGE_TEXT.unavailable;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const link = back ? `<p><a href="${esc(back)}">חזרה לאתר</a></p>` : "";
  const body =
    `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
    `<style>body{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;margin:0;padding:48px 16px;` +
    `background:#f7f7f8;color:#1f2328;text-align:center}main{max-width:420px;margin:0 auto;background:#fff;` +
    `border-radius:16px;padding:28px 20px;box-shadow:0 1px 4px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 8px}` +
    `p{margin:8px 0;line-height:1.5}a{color:#0b57d0}</style></head>` +
    `<body><main><h1>${esc(title)}</h1><p>${esc(line)}</p>${link}</main></body></html>`;
  return new NextResponse(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
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
  let allowedOrigins: string[] = [];
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
      allowedOrigins = pub.allowedOrigins;
    }
  } catch {
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  const headers = cors(origin, browser);
  const html = wantsHtml(req, browser);
  const reply = (code: keyof typeof PAGE_TEXT, status: number, extra: Record<string, string> = {}) =>
    html
      ? htmlPage(code, status, backLink(req, allowedOrigins))
      : NextResponse.json(code === "ok" ? { ok: true } : { ok: false, error: code }, { status, headers: { ...headers, ...extra } });

  const limit = await checkRateLimit(
    browser
      ? { bucket: "ACQUISITION_WEB_PUBLIC", business: conn.businessId, ip: getClientIp(req) }
      : { bucket: "ACQUISITION_INTAKE", business: conn.businessId }
  );
  if (!limit.allowed && limit.outcome === "rate_limited") {
    return reply("rate_limited", 429, { "retry-after": String(limit.retryAfterSeconds) });
  }

  let raw: string;
  try {
    raw = await readBodyLimited(req, BODY_LIMITS["web.form"]);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return reply("too_large", 413);
    throw e;
  }
  const fields = flattenFields(parseBody(raw, req.headers.get("content-type")));
  if (!fields) return reply("malformed", 400);
  const parsed = parseWebForm(fields);
  if (!parsed.ok) return reply(parsed.code === "no_contact" ? "no_contact" : "malformed", 400);
  // A bot filled the honeypot: answer like a success, record nothing.
  if (parsed.honeypot) return reply("ok", html ? 200 : 202);

  try {
    const out = await ingestAcquisition({
      sourceKey: WEB_FORM_SOURCE,
      accountRef: publicId,
      businessId: conn.businessId,
      connectionId: conn.connectionId,
      receipts: [acquisitionReceipt(parsed.lead, publicId)],
    });
    if (out.status === "refused") return html ? reply("unavailable", 404) : NextResponse.json({ ok: false, error: "not_found" }, { status: 404, headers });
    return reply("ok", html ? 200 : 202);
  } catch {
    return reply("unavailable", 503);
  }
}
