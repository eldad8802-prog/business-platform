/**
 * Website-form live proof — the TEMPORARY pilot page on Dubiz's own site (business 9 only).
 *
 * Why it exists: the M6 website path has never received a real browser submission in Production.
 * This page serves the EXACT form an owner pastes into their site (`webFormSnippet`, unchanged) from
 * https://promaxgroup.co.il, so a real browser posts it to the real public endpoint
 * (/api/intake/acquisition/web/<publicId>) — the same Origin check, honeypot, rate limits, durable
 * receipt and intake as any business's website. Nothing here writes: no lead, no receipt, no row.
 *
 * Who can open it: Dubiz auth is a Bearer token, which a page navigation never carries. So:
 *   1. the platform admin asks POST /api/platform-admin/web-form-pilot/pass (Bearer + allowlist + MFA,
 *      the canonical guard) for a connection's publicId;
 *   2. that route checks the publicId is a LIVE website connection of business 9 and sets a short
 *      pass — HMAC-signed, 15 minutes, httpOnly, SameSite=Strict, scoped to the pilot path only;
 *   3. GET /lab/web-form-pilot verifies the pass AND re-resolves the connection to business 9 on every
 *      load. Anything else — no pass, a forged / expired pass, another publicId, another business, a
 *      paused or revoked connection, a malformed submission id — is the same plain 404.
 *
 * Off switch: revoking (or pausing) the connection makes this page AND the endpoint 404 at once.
 * Removal: delete this file, its test, the two routes and the admin page (one PR).
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { PlatformAdminUser } from "@/lib/auth/platform-admin";
import { PUBLIC_ID_PATTERN } from "./keys";
import { WEB_FORM_SCRIPT, webFormSnippet } from "./web-form-snippet";

/** The ONLY business this pilot serves. Never 38, never a parameter. */
export const PILOT_BUSINESS_ID = 9;
export const PILOT_PATH = "/lab/web-form-pilot";
export const PILOT_COOKIE = "dubiz_wfp";
export const PILOT_PASS_TTL_SECONDS = 15 * 60;

const VERSION = 1;
const PURPOSE = "web-form-pilot";
const KEY_DERIVATION_LABEL = "dubiz-web-form-pilot-v1";
/** A submission id the page pre-fills: a lower-case UUID, nothing else. */
const SID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type PassPayload = { v: number; purpose: string; sub: number; pid: string; nonce: string; iat: number; exp: number };

function deriveKey(): Buffer | null {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  // Fail closed — no secret, no pass (the page answers 404).
  return secret ? createHmac("sha256", secret).update(KEY_DERIVATION_LABEL).digest() : null;
}

/** A pass for one admin and one connection, valid for 15 minutes. Null when signing is unavailable. */
export function mintPilotPass(adminId: number, publicId: string, nowMs = Date.now()): string | null {
  const key = deriveKey();
  if (!key || !Number.isInteger(adminId) || adminId <= 0 || !PUBLIC_ID_PATTERN.test(publicId)) return null;
  const iat = Math.floor(nowMs / 1000);
  const payload: PassPayload = {
    v: VERSION,
    purpose: PURPOSE,
    sub: adminId,
    pid: publicId,
    nonce: randomBytes(16).toString("base64url"),
    iat,
    exp: iat + PILOT_PASS_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** The publicId a pass was issued for, or null (forged, expired, malformed, wrong purpose). Never throws. */
export function verifyPilotPass(raw: string | null | undefined, nowMs = Date.now()): string | null {
  const key = deriveKey();
  if (!key || typeof raw !== "string" || raw.length === 0 || raw.length > 1024) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1 || raw.indexOf(".", dot + 1) !== -1) return null;
  const body = raw.slice(0, dot);
  const provided = Buffer.from(raw.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", key).update(body).digest();
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let p: PassPayload;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PassPayload;
  } catch {
    return null;
  }
  if (p?.purpose !== PURPOSE || p.v !== VERSION) return null;
  if (!Number.isInteger(p.sub) || p.sub <= 0 || !Number.isInteger(p.exp) || typeof p.pid !== "string") return null;
  if (!PUBLIC_ID_PATTERN.test(p.pid)) return null;
  if (Math.floor(nowMs / 1000) >= p.exp) return null;
  return p.pid;
}

export function isPilotSubmissionId(v: unknown): v is string {
  return typeof v === "string" && SID_PATTERN.test(v);
}

/** The public endpoint the form posts to — on the request's own origin, never a stored host. */
export function pilotEndpointUrl(origin: string, publicId: string): string {
  return `${origin}/api/intake/acquisition/web/${publicId}`;
}

const SCRIPT_HASH = `'sha256-${createHash("sha256").update(WEB_FORM_SCRIPT, "utf8").digest("base64")}'`;

/**
 * The page: `webFormSnippet` byte-for-byte, except that the empty submission_id input gets the
 * pre-filled value (the snippet's own script keeps a value that is already there). The CSP lets ONLY
 * that script run and lets the form post ONLY to this origin.
 */
export function renderPilotPage(endpoint: string, sid: string): string {
  if (!isPilotSubmissionId(sid)) throw new Error("submission id must be a UUID");
  const empty = `<input type="hidden" name="submission_id">`;
  const snippet = webFormSnippet(endpoint);
  if (snippet.split(empty).length !== 2) throw new Error("webFormSnippet changed: submission_id input not found exactly once");
  const form = snippet.replace(empty, `<input type="hidden" name="submission_id" value="${sid}">`);
  return [
    `<!doctype html>`,
    `<html lang="he" dir="rtl"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="robots" content="noindex,nofollow">`,
    `<title>ניסוי טופס אתר</title>`,
    `<style>body{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;margin:0;padding:32px 16px;background:#f7f7f8;color:#1f2328}main{max-width:460px;margin:0 auto;background:#fff;border-radius:16px;padding:24px 20px;box-shadow:0 1px 4px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;line-height:1.5}</style>`,
    `</head><body><main>`,
    `<h1>ניסוי טופס אתר — עסק ${PILOT_BUSINESS_ID}</h1>`,
    `<p>עמוד ניסוי פנימי. הטופס נשלח לנקודת הקליטה הציבורית, בדיוק כמו טופס באתר של עסק.</p>`,
    form,
    `</main></body></html>`,
  ].join("\n");
}

const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    `default-src 'none'; script-src ${SCRIPT_HASH}; style-src 'unsafe-inline'; form-action 'self'; ` +
    `base-uri 'none'; frame-ancestors 'none'`,
};

function notFound(): NextResponse {
  return new NextResponse("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

type Resolve = (publicId: string) => Promise<{ businessId: number } | null>;

export type PilotDeps = {
  resolve: Resolve;
  now?: () => number;
};

/** True only for a LIVE website connection that belongs to business 9. */
async function isPilotConnection(resolve: Resolve, publicId: string): Promise<boolean> {
  if (!PUBLIC_ID_PATTERN.test(publicId)) return false;
  const conn = await resolve(publicId);
  return !!conn && conn.businessId === PILOT_BUSINESS_ID;
}

/**
 * POST /api/platform-admin/web-form-pilot/pass  {publicId} — called by the route AFTER the canonical
 * guard (401/403 never reach here). 404 unless the publicId is a live business-9 website connection;
 * 200 {url} with the pass cookie. The url carries a fresh submission id — open the SAME url again to
 * resubmit with the same id.
 */
export async function handlePilotPass(req: Request, admin: PlatformAdminUser, deps: PilotDeps): Promise<NextResponse> {
  let publicId: unknown;
  try {
    publicId = ((await req.json()) as { publicId?: unknown })?.publicId;
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (typeof publicId !== "string") return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  try {
    if (!(await isPilotConnection(deps.resolve, publicId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  }
  const pass = mintPilotPass(admin.id, publicId, deps.now?.());
  if (!pass) return NextResponse.json({ error: "Unavailable" }, { status: 503 });
  const res = NextResponse.json(
    { url: `${PILOT_PATH}?id=${publicId}&sid=${randomUUID()}`, expiresInSeconds: PILOT_PASS_TTL_SECONDS },
    { headers: { "cache-control": "no-store" } }
  );
  res.cookies.set({
    name: PILOT_COOKIE,
    value: pass,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: PILOT_PATH,
    maxAge: PILOT_PASS_TTL_SECONDS,
  });
  return res;
}

/** GET /lab/web-form-pilot?id=<publicId>&sid=<uuid> — the form, or 404. */
export async function handlePilotPage(req: Request, deps: PilotDeps): Promise<NextResponse> {
  const url = new URL(req.url);
  const publicId = url.searchParams.get("id") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  if (!isPilotSubmissionId(sid)) return notFound();
  const passFor = verifyPilotPass(readCookie(req, PILOT_COOKIE), deps.now?.());
  if (!passFor || passFor !== publicId) return notFound();
  try {
    if (!(await isPilotConnection(deps.resolve, publicId))) return notFound();
  } catch {
    return notFound();
  }
  return new NextResponse(renderPilotPage(pilotEndpointUrl(url.origin, publicId), sid), { status: 200, headers: PAGE_HEADERS });
}
