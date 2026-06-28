import { NextRequest, NextResponse } from "next/server";
import { handleProviderWebhook } from "@/lib/services/payments/payment-webhook-handler";
import { paymentWebhookDeps } from "@/lib/services/payments/payments.deps";

// Public webhook endpoint (no auth). Must run on Node.js for crypto/raw body.
export const runtime = "nodejs";

/**
 * Tranzila payment notification. Always answers 200 { ok: true } — even on a
 * bad/duplicate/unrecognized event or an internal error — to avoid provider
 * retry storms. Authenticity, idempotency, and status logic live in the
 * service/DB; the raw payload is persisted before processing.
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
      { provider: "TRANZILA", rawBody, headers },
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
