import { after, NextRequest, NextResponse } from "next/server";
import { parseWhatsAppWebhookPayload } from "@/lib/services/integrations/whatsapp/webhook-parse.service";
import {
  routeInboundWhatsAppMessage,
  routingDecisionLogFields,
} from "@/lib/services/integrations/whatsapp/routing-gate.service";
import { resolveBusinessFromPhoneNumberId } from "@/lib/services/integrations/whatsapp/business-resolve.service";
import {
  verifySubscribeChallenge,
  verifyWebhookSignature,
} from "@/lib/services/integrations/whatsapp/webhook-verify.service";
import { logEvent } from "@/lib/services/integrations/whatsapp/webhook-events";
import { runTenantJob } from "@/lib/tenant/job";
import { BusinessQuarantinedError } from "@/lib/tenant/business-lifecycle";
import { recordReceipts } from "@/lib/intake/intake-event.store";
import type { IntakeReceiptDraft } from "@/lib/intake/core/contract";
import { drainIntake } from "@/lib/intake/core/processor";
import { intakeRegistry } from "@/lib/intake/sources";
import {
  buildMessageReceipt,
  buildStatusReceipt,
  whatsAppIntakeAdapter,
} from "@/lib/intake/whatsapp/whatsapp-intake";

export const runtime = "nodejs";

/**
 * Meta WhatsApp webhook.
 *
 * M2 — ACKNOWLEDGEMENT MEANS RESPONSIBILITY.
 * Before M2 this route answered 200 whatever happened, so a failure while
 * creating the customer, conversation or message lost the event for good: Meta
 * does not redeliver a 200. Now:
 *
 *   1. verify the signature over the raw body (unchanged);
 *   2. resolve each message's tenant through the routing gate — the only tenant
 *      source, keyed on the signed phone_number_id, never a payload field;
 *   3. write one IntakeEvent receipt per event, per business, in a tenant
 *      transaction — idempotent on the provider's id;
 *   4. ONLY THEN answer 200. If any receipt could not be written, answer 500 and
 *      let Meta redeliver (the receipts that did land dedupe on redelivery);
 *   5. process the receipts after the response. A processing failure is
 *      recorded on the receipt and retried — it is no longer a lost message.
 */

/**
 * Run `task` after the response — or, outside a request scope (a script or a CI
 * battery calling the handler directly, where `after()` throws), inline, so the
 * one code path is what gets exercised everywhere.
 */
function afterResponse(task: () => Promise<void>): Promise<void> | null {
  try {
    after(task);
    return null;
  } catch {
    return task();
  }
}

function safeWebhookLog(summary: {
  object: string | null;
  entryCount: number;
  changeCount: number;
  unsupportedChangeCount: number;
  messageCount: number;
  statusCount: number;
  messageTypes: string[];
}): void {
  console.info("[whatsapp-webhook]", summary);
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const result = verifySubscribeChallenge({
    mode: searchParams.get("hub.mode"),
    verifyToken: searchParams.get("hub.verify_token"),
    challenge: searchParams.get("hub.challenge"),
  });

  if (!result.ok) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  return new NextResponse(result.challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function POST(req: NextRequest) {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const signatureResult = verifyWebhookSignature({
    rawBody,
    signatureHeader: req.headers.get("x-hub-signature-256"),
  });

  if (!signatureResult.ok) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const parsed = parseWhatsAppWebhookPayload(body);

  safeWebhookLog({
    object: parsed.object,
    entryCount: parsed.entryCount,
    changeCount: parsed.changeCount,
    unsupportedChangeCount: parsed.unsupportedChangeCount,
    messageCount: parsed.messages.length,
    statusCount: parsed.statuses.length,
    messageTypes: [
      ...new Set(
        parsed.messages
          .map((m) => m.type)
          .filter((t): t is string => typeof t === "string" && t.length > 0)
      ),
    ],
  });

  // ── 1. tenant resolution + receipt building (no tenant writes yet) ─────────
  // A resolution failure that is a DATABASE error propagates to the catch and
  // becomes a 500 — never "not found", never a silent drop.
  const receiptsByBusiness = new Map<number, IntakeReceiptDraft[]>();
  const add = (businessId: number, receipt: IntakeReceiptDraft) => {
    const list = receiptsByBusiness.get(businessId) ?? [];
    list.push(receipt);
    receiptsByBusiness.set(businessId, list);
  };

  try {
    for (const message of parsed.messages) {
      const decision = await routeInboundWhatsAppMessage(message);
      console.info("[whatsapp-webhook-routing]", routingDecisionLogFields(decision));

      if (decision.kind === "STOP") {
        // No tenant (unknown / disconnected number) or no provider id: there is
        // nobody to record it against. Not ours to accept — answered 200.
        if (decision.reason === "unknown_phone_number_id") {
          logEvent("UNKNOWN_PHONE_NUMBER_ID", {
            source: "webhook",
            phoneNumberId: decision.phoneNumberId ?? null,
          });
        }
        continue;
      }
      add(decision.businessId, buildMessageReceipt(decision, message));
    }

    // Delivery / read / failed receipts describe OUTBOUND messages. They are
    // resolved to the same tenant by the same signed phone_number_id, and they
    // never enter the customer-message dispatch above.
    for (const status of parsed.statuses) {
      const business = await resolveBusinessFromPhoneNumberId(status.phoneNumberId);
      if (!business.ok) continue;
      const receipt = buildStatusReceipt(status, business.phoneNumberId);
      if (receipt) add(business.businessId, receipt);
    }
  } catch (resolutionError) {
    console.warn("[whatsapp-webhook] tenant resolution failed; asking Meta to redeliver", {
      error: resolutionError instanceof Error ? resolutionError.name : "unknown",
    });
    return new NextResponse("Service Unavailable", { status: 500 });
  }

  // ── 2. durable receipts — the acknowledgement depends on these ─────────────
  const accepted: Array<{ businessId: number; eventIds: number[] }> = [];
  for (const [businessId, receipts] of receiptsByBusiness) {
    try {
      // The tenant came from the routing gate — the WhatsApp adapter's trusted
      // resolver (phone_number_id → WhatsAppConnection) — never from the payload.
      const recorded = await runTenantJob({ businessId }, () =>
        recordReceipts(businessId, whatsAppIntakeAdapter.sourceKey, receipts)
      );
      accepted.push({ businessId, eventIds: recorded.map((r) => r.id) });
    } catch (error) {
      if (error instanceof BusinessQuarantinedError) {
        // The business is being deleted: it accepts no new data. Recording
        // nothing and answering 200 is the deliberate outcome, not a loss.
        console.info("[whatsapp-webhook] business quarantined; events not accepted", {
          businessId,
          count: receipts.length,
        });
        continue;
      }
      console.warn("[whatsapp-webhook] receipt write failed; asking Meta to redeliver", {
        businessId,
        error: error instanceof Error ? error.name : "unknown",
      });
      return new NextResponse("Service Unavailable", { status: 500 });
    }
  }

  // ── 3. processing, after the response ──────────────────────────────────────
  // Each business in its own explicit tenant job. A failure here is recorded on
  // the receipt and retried (next webhook for the business, or the sweeper).
  const inline: Promise<void>[] = [];
  for (const { businessId, eventIds } of accepted) {
    const pending = afterResponse(() =>
      runTenantJob({ businessId }, () => drainIntake(intakeRegistry, businessId, { eventIds })).then(
        () => undefined,
        (error: unknown) => {
          console.warn("[whatsapp-webhook] post-ack processing failed; receipts will be retried", {
            businessId,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      )
    );
    if (pending) inline.push(pending);
  }
  await Promise.all(inline);

  return new NextResponse("OK", { status: 200 });
}
