import { NextRequest } from "next/server";
import { handleProviderWebhook } from "@/lib/services/payments/payment-webhook-handler";
import { paymentWebhookDeps } from "@/lib/services/payments/payments.deps";
import { webhookResponse, webhookRouteFailure } from "@/lib/services/payments/payment-webhook-response";

// Public webhook endpoint (no auth). Must run on Node.js for crypto/raw body.
export const runtime = "nodejs";

/**
 * Tranzila payment notification. Answers 200 { ok: true } for every processed, duplicate or refused event —
 * never a retry storm — and 503 only when the database or the provider's
 * verification API was unavailable, so the provider resends (see
 * lib/services/payments/payment-webhook-failure.ts). Authenticity, idempotency, and status logic live in the
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
    return webhookResponse(result);
  } catch (error) {
    // Defence in depth: an infrastructure failure asks the provider to resend (503); anything else is
    // acknowledged (200). Class + code only in the log — never the message, the payload or the secret.
    return webhookRouteFailure("payments-webhook-route", error);
  }
}
