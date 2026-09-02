import { NextRequest, NextResponse } from "next/server";
import { parseWhatsAppWebhookPayload } from "@/lib/services/integrations/whatsapp/webhook-parse.service";
import {
  intakeOutcomeLogFields as documentsIntakeLogFields,
  processWhatsAppDocumentsIntake,
} from "@/lib/services/integrations/whatsapp/documents-intake.service";
import {
  intakeOutcomeLogFields as conversationIntakeLogFields,
  processWhatsAppConversationIntake,
} from "@/lib/services/integrations/whatsapp/conversation-intake.service";
import {
  routeInboundWhatsAppMessage,
  routingDecisionLogFields,
} from "@/lib/services/integrations/whatsapp/routing-gate.service";
import {
  verifySubscribeChallenge,
  verifyWebhookSignature,
} from "@/lib/services/integrations/whatsapp/webhook-verify.service";
import { logEvent } from "@/lib/services/integrations/whatsapp/webhook-events";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { runTenantJob } from "@/lib/tenant/job";

export const runtime = "nodejs";

function safeWebhookLog(summary: {
  object: string | null;
  entryCount: number;
  changeCount: number;
  unsupportedChangeCount: number;
  messageCount: number;
  messageTypes: string[];
}): void {
  console.info("[whatsapp-webhook]", {
    object: summary.object,
    entryCount: summary.entryCount,
    changeCount: summary.changeCount,
    // Changes dropped by the event-class boundary (field !== "messages").
    unsupportedChangeCount: summary.unsupportedChangeCount,
    messageCount: summary.messageCount,
    messageTypes: summary.messageTypes,
  });
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
    messageTypes: [
      ...new Set(
        parsed.messages
          .map((m) => m.type)
          .filter((t): t is string => typeof t === "string" && t.length > 0)
      ),
    ],
  });

  for (const message of parsed.messages) {
    // Per-message try/catch — webhook MUST always return 200 even if a
    // single message handler explodes, otherwise Meta will retry-storm
    // the whole batch.
    try {
      const decision = await routeInboundWhatsAppMessage(message);
      console.info(
        "[whatsapp-webhook-routing]",
        routingDecisionLogFields(decision)
      );

      if (decision.kind === "STOP") {
        if (decision.reason === "unknown_phone_number_id") {
          logEvent("UNKNOWN_PHONE_NUMBER_ID", {
            source: "webhook",
            phoneNumberId: decision.phoneNumberId ?? null,
          });
        }
        continue;
      }

      if (decision.kind === "DOCUMENTS_INTAKE") {
        // Per-business abuse/cost throttle. Fail-open (a Redis blip must not drop
        // legitimate documents). On genuine over-limit we skip processing this
        // message but still return 200 so Meta does not retry-storm.
        const intakeGate = await checkRateLimit({
          bucket: "WHATSAPP_INTAKE",
          business: decision.businessId,
        });
        if (!intakeGate.allowed) {
          console.warn("[whatsapp-webhook] intake throttled", {
            businessId: decision.businessId,
            retryAfterSeconds: intakeGate.retryAfterSeconds,
          });
          continue;
        }

        // D2/P7-W4A: the trusted, server-resolved businessId (WhatsAppConnection
        // lookup by phone_number_id — never a payload field) becomes the
        // explicit tenant context for the whole per-message intake.
        const outcome = await runTenantJob({ businessId: decision.businessId }, () =>
          processWhatsAppDocumentsIntake({
            businessId: decision.businessId,
            phoneNumberId: decision.phoneNumberId,
            sender: decision.sender,
            wamid: decision.wamid,
            mediaType: decision.mediaType,
            mediaId: decision.mediaId,
          })
        );
        console.info(
          "[whatsapp-webhook-intake]",
          documentsIntakeLogFields(
            decision.businessId,
            decision.wamid,
            outcome
          )
        );
        continue;
      }

      if (decision.kind === "CONVERSATION_INTAKE") {
        // D2/P7-W4A: explicit tenant context from the trusted mapping (see above).
        const outcome = await runTenantJob({ businessId: decision.businessId }, () =>
          processWhatsAppConversationIntake({
            businessId: decision.businessId,
            phoneNumberId: decision.phoneNumberId,
            senderPhone: decision.senderPhone,
            wamid: decision.wamid,
            text: decision.text,
          })
        );
        console.info(
          "[whatsapp-webhook-conversation-intake]",
          conversationIntakeLogFields(
            decision.businessId,
            decision.wamid,
            outcome
          )
        );
        continue;
      }
    } catch (perMessageErr) {
      // Structured log + swallow — webhook integrity (always 200) wins.
      console.warn(
        "[whatsapp-webhook] per-message handler failed:",
        perMessageErr instanceof Error
          ? perMessageErr.message
          : String(perMessageErr)
      );
    }
  }

  return new NextResponse("OK", { status: 200 });
}
