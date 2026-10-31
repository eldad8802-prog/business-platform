import { NextRequest, NextResponse } from "next/server";
import { handleProviderWebhook } from "@/lib/services/payments/payment-webhook-handler";
import { paymentWebhookDeps } from "@/lib/services/payments/payments.deps";
import { webhookResponse, webhookRouteFailure } from "@/lib/services/payments/payment-webhook-response";
import { isSupportedProvider } from "@/lib/services/payments/providers/provider-registry";

// Public webhook endpoint (no auth). Node.js runtime for raw body access.
export const runtime = "nodejs";

/**
 * Generic provider webhook. The static routes (/webhook/tranzila,
 * /webhook/cardcom) take precedence for the existing providers; this dynamic
 * route catches any additional registered provider with zero new code.
 *
 * The webhook is only a SIGNAL — authority remains the shared orchestration's
 * verification step. Answers 200 { ok: true } for an unknown provider and for every
 * processed or refused event, and 503 only on an infrastructure failure
 * (lib/services/payments/payment-webhook-failure.ts).
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ provider: string }> }
) {
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
    const { provider } = await context.params;
    // URL segment is lowercase; provider keys are uppercase enum values.
    const key = (provider ?? "").toUpperCase();
    if (!isSupportedProvider(key)) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    const result = await handleProviderWebhook(
      { provider: key, rawBody, headers },
      paymentWebhookDeps()
    );
    return webhookResponse(result);
  } catch (error) {
    // Defence in depth: an infrastructure failure asks the provider to resend (503); anything else is
    // acknowledged (200). Class + code only in the log — never the message, the payload or the secret.
    return webhookRouteFailure("payments-webhook-route:generic", error);
  }
}
