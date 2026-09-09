import { NextRequest, NextResponse } from "next/server";
import { handleProviderWebhook } from "@/lib/services/payments/payment-webhook-handler";
import { paymentWebhookDeps } from "@/lib/services/payments/payments.deps";

// Public webhook endpoint (no auth at the transport layer). Node.js runtime is
// required: PayPlus signs the RAW request body, so the handler needs the bytes
// exactly as received.
export const runtime = "nodejs";

/**
 * PayPlus payment notification.
 *
 * WHY A DEDICATED ROUTE RATHER THAN THE GENERIC `/[provider]` ONE.
 *
 * PayPlus documents its merchant callback as a **GET** to the `refURL_callback`
 * registered at LowProfile creation, while the generic route exports POST only.
 * Rather than add GET to the shared route — which would change every other
 * provider's behaviour for a method none of them use, turning a clean 405 into
 * a 200-with-refusal for CardCom — PayPlus gets its own route, matching the
 * existing per-provider convention (cardcom, tranzila, paypal each have one).
 *
 * ⚠️ DOCS-CONFIRM. The published callback reference is shaped as a GET, but a
 * GET carrying a signed JSON body is unusual, and the signature reference
 * describes hashing a JSON body. Both methods are therefore accepted and both
 * funnel into the identical shared orchestration. This widens nothing: a
 * request with no body fails the structural gate before any lookup, and a
 * request that cannot produce a valid merchant HMAC is refused before the first
 * write. The sandbox end-to-end is what settles which method PayPlus actually
 * uses; the unused one should then be deleted.
 *
 * The remaining unknown is benign by construction. If PayPlus turns out to send
 * a GET carrying its fields in the QUERY STRING rather than a body, this route
 * refuses it — there would be no signed body to authenticate, and inventing a
 * canonical string to hash would be worse than refusing. The cost is a delayed
 * settlement, never a wrong one: under the Authority Principle the callback
 * only prompts a `/Transactions/View` lookup, so a callback that never arrives
 * leaves the request exactly where it was.
 *
 * Authority model is the shared one and this route adds nothing to it: the
 * callback is a SIGNAL. It is authenticated against the correlated merchant's
 * own secret key, and a request only reaches PAID when `/Transactions/View`
 * says so.
 *
 * Always answers 200 { ok: true } once PayPlus is an enabled capability — even
 * for a bad, duplicate or unrecognised event — to avoid provider retry storms
 * and to deny an enumeration oracle. While PayPlus is a disabled capability the
 * shared handler refuses with 404 before any processing.
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

  try {
    const result = await handleProviderWebhook(
      { provider: "PAYPLUS", rawBody, headers },
      paymentWebhookDeps()
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    // Defence in depth: never let the webhook return non-200 for an enabled
    // provider, and never echo the payload or an internal detail back out.
    console.warn(
      "[payments-webhook-route:payplus] unexpected failure:",
      error instanceof Error ? error.message : String(error)
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
