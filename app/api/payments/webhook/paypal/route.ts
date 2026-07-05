import { NextRequest, NextResponse } from "next/server";
import { handleProviderWebhook } from "@/lib/services/payments/payment-webhook-handler";
import { paymentWebhookDeps } from "@/lib/services/payments/payments.deps";

// Public webhook endpoint (no auth). Must run on Node.js for raw body access.
export const runtime = "nodejs";

/**
 * PayPal payment notification. Always answers 200 { ok: true } — even on a
 * bad/duplicate/unrecognized event or an internal error — to avoid provider
 * retry storms.
 *
 * The webhook is only a SIGNAL. Authority is the shared orchestration's
 * verification step (PayPal Orders GET + capture); a request reaches PAID only
 * when verification confirms a COMPLETED capture. This route adds no
 * provider-specific authority logic — it feeds the raw payload into the shared
 * orchestration. A forged webhook cannot make a request PAID.
 */
export async function POST(req: NextRequest) {
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
      { provider: "PAYPAL", rawBody, headers },
      paymentWebhookDeps()
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.warn(
      "[payments-webhook-route:paypal] unexpected failure:",
      error instanceof Error ? error.message : String(error)
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}
