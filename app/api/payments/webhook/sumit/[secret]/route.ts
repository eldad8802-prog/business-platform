import { NextRequest, NextResponse } from "next/server";
import { handleProviderWebhook } from "@/lib/services/payments/payment-webhook-handler";
import { paymentWebhookDeps } from "@/lib/services/payments/payments.deps";
import { extractCallbackSecretFromPath } from "@/lib/services/payments/payment-callback-secret";

// Public webhook endpoint. Node.js runtime: the body must be read exactly as
// received, and the secret is compared against a hash computed here.
export const runtime = "nodejs";

/**
 * SUMIT payment notification.
 *
 * WHY THE SECRET IS IN THE PATH.
 *
 * SUMIT signs nothing. Its callback carries no HMAC, no signature header and no
 * shared secret — a live sandbox delivery showed only transport headers. What it
 * does carry is the fact that it arrived at a URL nobody else was given, which is
 * the same property SUMIT's own reference plugin relies on.
 *
 * So the secret is a path segment rather than a query parameter. Query strings
 * end up in access logs, referrer headers and analytics far more readily than
 * paths do, and a provider that can register a URL can register a path.
 *
 * WHAT THIS ROUTE DOES NOT REVEAL.
 *
 * Every outcome below is the same 200 `{ ok: true }` once SUMIT is an enabled
 * capability: a valid secret, a wrong one, a truncated one, a missing one, a
 * malformed body. A caller therefore cannot use this endpoint to discover
 * whether a given secret exists, which would otherwise turn it into an oracle
 * for enumerating live payment requests. While SUMIT is a disabled capability
 * the shared handler answers 404 before any processing at all.
 *
 * WHAT THE CALLBACK IS ALLOWED TO DO.
 *
 * Name a request, and nothing more. The payload carries `customerid`,
 * `documentid` and `valid`; none of them settles anything. The secret resolves
 * which PaymentRequest this is, and the outcome is then established by asking
 * SUMIT directly. The observed body is form-encoded despite a `text/plain`
 * content type, which the adapter's parser handles.
 */
async function handle(req: NextRequest) {
  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    rawBody = "";
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // The secret comes from the PATH and only from the path. Taking it from the
  // body would let a payload choose how it is correlated, which is the whole
  // thing this design exists to prevent.
  let callbackSecret: string | null = null;
  try {
    callbackSecret = extractCallbackSecretFromPath(new URL(req.url).pathname);
  } catch {
    callbackSecret = null;
  }

  try {
    const result = await handleProviderWebhook(
      { provider: "SUMIT", rawBody, headers, callbackSecret },
      paymentWebhookDeps()
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    // Defence in depth: never answer non-200 for an enabled provider, and never
    // echo the payload, the secret or an internal detail back out. The message
    // is deliberately not interpolated with anything request-derived.
    console.warn(
      "[payments-webhook-route:sumit] unexpected failure:",
      error instanceof Error ? error.name : "unknown"
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  return handle(req);
}

/**
 * GET is accepted as well.
 *
 * The observed delivery is a POST, so POST is the real path. GET exists because
 * SUMIT's redirect-era documentation describes a GET-shaped callback and the
 * cost of accepting it is nil: a GET carries no body, so it fails the adapter's
 * structural gate before anything is looked up, and it still has to present a
 * valid secret to get that far. If a future delivery arrives as a GET it is
 * recorded rather than silently 405'd.
 */
export async function GET(req: NextRequest) {
  return handle(req);
}
