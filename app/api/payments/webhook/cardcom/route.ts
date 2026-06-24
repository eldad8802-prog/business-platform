import { NextRequest, NextResponse } from "next/server";
import { handleProviderWebhook } from "@/lib/services/payments/payment-webhook-handler";
import { paymentWebhookDeps } from "@/lib/services/payments/payments.deps";

// Public webhook endpoint (no auth). Must run on Node.js for crypto/raw body.
export const runtime = "nodejs";

/**
 * CardCom payment notification. Always answers 200 { ok: true } — even on a
 * bad/duplicate/unrecognized event or an internal error — to avoid provider
 * retry storms.
 *
 * The webhook is only a SIGNAL. Authority is the shared orchestration's
 * verification step (CardCom GetLpResult); a request reaches PAID only when
 * verification confirms it. This route adds no provider-specific authority
 * logic — it just feeds the raw payload into the shared orchestration.
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
      { provider: "CARDCOM", rawBody, headers },
      paymentWebhookDeps()
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    // Defense in depth: never let the webhook return non-200.
    console.warn(
      "[payments-webhook-route] unexpected failure:",
      error instanceof Error ? error.message : String(error)
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}
