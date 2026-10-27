/**
 * Public booking — the HTTP edge of the doors without a session (Milestone C). SERVER-ONLY.
 *
 *   - rate limit FIRST, per IP, fail-CLOSED (a Redis outage answers 503, never "no limit") — D11;
 *   - a POST must be JSON (a cross-site form cannot send it without a CORS preflight, which these routes never grant);
 *   - every answer: no-store, noindex, no-referrer;
 *   - every refusal of a link that does not resolve (unknown, disabled, flag OFF, emergency switch) is the same 404;
 *     errors carry a stable code and a short Hebrew message, never an internal detail.
 */
import { NextResponse } from "next/server";

import { checkRateLimit, type BucketName } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { getClientIp } from "@/lib/security/rate-limit";

import { AppointmentServiceError } from "@/lib/services/appointment/appointment-errors";

export const PUBLIC_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
} as const;

const MESSAGES: Record<string, string> = {
  NOT_FOUND: "הקישור אינו זמין.",
  INVALID_INPUT: "חלק מהפרטים לא תקינים. כדאי לבדוק ולנסות שוב.",
  SLOT_UNAVAILABLE: "השעה הזו כבר לא פנויה. אפשר לבחור שעה אחרת.",
  REQUEST_LIMIT: "יש כבר בקשות פתוחות מהמספר הזה. אפשר לחכות לתשובת העסק.",
  SELF_CANCEL_CLOSED: "כבר אי אפשר לבטל דרך הקישור. אפשר לפנות לעסק ישירות.",
  INVALID_TRANSITION: "אי אפשר לבצע את הפעולה במצב הנוכחי.",
  IDEMPOTENCY_KEY_INVALID: "הבקשה לא תקינה. כדאי לרענן את הדף ולנסות שוב.",
  IDEMPOTENCY_KEY_STALE: "הבקשה לא תקינה. כדאי לרענן את הדף ולנסות שוב.",
  IDEMPOTENCY_KEY_REUSED: "הבקשה לא תקינה. כדאי לרענן את הדף ולנסות שוב.",
};

export function publicJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PUBLIC_HEADERS });
}

export function publicError(e: unknown): NextResponse {
  if (e instanceof AppointmentServiceError) {
    // Public answers name the field of an invalid input (so a form can point at it) and nothing else.
    const details = e.code === "INVALID_INPUT" && typeof e.details.field === "string" ? { field: e.details.field } : undefined;
    const code = e.status === 404 ? "NOT_FOUND" : e.code;
    return publicJson({ error: code, message: MESSAGES[code] ?? "לא הצלחנו להשלים את הפעולה.", ...(details ? { details } : {}) }, e.status === 404 ? 404 : e.status);
  }
  console.error("[public-booking] unexpected error", e instanceof Error ? e.name : "unknown");
  return publicJson({ error: "INTERNAL", message: "משהו השתבש. כדאי לנסות שוב בעוד רגע." }, 500);
}

export async function publicRoute(
  req: Request,
  bucket: BucketName,
  handler: (ctx: { ip: string }) => Promise<Response>,
): Promise<Response> {
  const ip = getClientIp(req);
  let decision;
  try {
    decision = await checkRateLimit({ bucket, ip });
  } catch {
    // A limiter that cannot even be configured closes the door too — never "no limit".
    return publicJson({ error: "rate_limit_unavailable", message: "השירות עמוס כרגע. נסה שוב בעוד רגע." }, 503);
  }
  if (!decision.allowed) {
    const res = buildRateLimitResponse(decision);
    for (const [k, v] of Object.entries(PUBLIC_HEADERS)) res.headers.set(k, v);
    return res;
  }
  if (req.method === "POST" && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return publicJson({ error: "INVALID_INPUT", message: MESSAGES.INVALID_INPUT }, 415);
  }
  try {
    return await handler({ ip });
  } catch (e) {
    return publicError(e);
  }
}

/** The per-business ceiling (D11), applied once the link has resolved. Throws a 429/503 response as an error. */
export class LimitResponse extends Error {
  constructor(readonly response: Response) { super("rate_limited"); }
}

export async function limitBusiness(bucket: BucketName, businessId: number): Promise<void> {
  let decision;
  try {
    decision = await checkRateLimit({ bucket, business: businessId });
  } catch {
    throw new LimitResponse(publicJson({ error: "rate_limit_unavailable", message: "השירות עמוס כרגע. נסה שוב בעוד רגע." }, 503));
  }
  if (!decision.allowed) {
    const res = buildRateLimitResponse(decision);
    for (const [k, v] of Object.entries(PUBLIC_HEADERS)) res.headers.set(k, v);
    throw new LimitResponse(res);
  }
}

export async function jsonBodyOf(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (text.length > 8_000) throw new AppointmentServiceError("INVALID_INPUT", { field: "body" });
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppointmentServiceError("INVALID_INPUT", { field: "body" });
    return body as Record<string, unknown>;
  } catch (e) {
    if (e instanceof AppointmentServiceError) throw e;
    throw new AppointmentServiceError("INVALID_INPUT", { field: "body" });
  }
}
