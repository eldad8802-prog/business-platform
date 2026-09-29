/**
 * Server-side completion of WhatsApp Embedded Signup — the orchestration behind
 * `POST /api/integrations/whatsapp/embedded-signup`, with its collaborators
 * injected so every outcome is unit-tested without Meta or a database.
 *
 * Order is load-bearing and unchanged:
 *   1. exchange `code` → access token   (App Secret, server-side)
 *   2. resolve the phone number         (Graph, with that token): the given
 *      phone_number_id's display number, or — for coexistence onboarding,
 *      whose finish event carries only waba_id — the WABA's single number
 *   3. subscribe the WABA to our app    (Graph POST /{waba-id}/subscribed_apps)
 *   4. persist WhatsAppConnection       (encrypted token, status=CONNECTED)
 *
 * The persist is the ONLY write and it runs LAST: if any Graph step fails,
 * nothing is written — no half-connected row, no stored token.
 *
 * Failure responses name the failed `stage` and a safe `code` (the Graph
 * status/error-number vocabulary built by graph.service's `safeError`, or a
 * fixed label). Never the Graph message, the code, the token or the App Secret.
 */
import type {
  ExchangeResult,
  PhoneDisplayResult,
  SubscribeWabaResult,
  WabaPhoneResult,
} from "./graph.service";
import type { PublicConnection } from "./connection.service";

export type EmbeddedSignupStage = "input" | "exchange" | "display" | "subscribe" | "persist";

export type EmbeddedSignupCompleteDeps = {
  exchangeCodeForToken: (code: string) => Promise<ExchangeResult>;
  fetchPhoneNumberDisplay: (phoneNumberId: string, accessToken: string) => Promise<PhoneDisplayResult>;
  fetchWabaPhoneNumber: (wabaId: string, accessToken: string) => Promise<WabaPhoneResult>;
  subscribeWabaToApp: (input: { wabaId: string; accessToken: string }) => Promise<SubscribeWabaResult>;
  persistFromEmbeddedSignup: (input: {
    businessId: number;
    phoneNumberId: string;
    displayPhoneNumber: string;
    wabaId: string;
    accessToken: string;
  }) => Promise<PublicConnection>;
  warn?: (event: string, fields: Record<string, unknown>) => void;
};

export type EmbeddedSignupCompleteResponse = {
  status: number;
  body:
    | { connection: PublicConnection }
    | { error: string; stage: EmbeddedSignupStage; code: string };
};

const GENERIC = "Could not complete WhatsApp connection";

function isUniqueConflict(err: unknown): boolean {
  return (err as { code?: unknown })?.code === "P2002";
}

function fail(
  status: number,
  stage: EmbeddedSignupStage,
  code: string,
  error = GENERIC
): EmbeddedSignupCompleteResponse {
  return { status, body: { error, stage, code: code.slice(0, 64) } };
}

export async function completeEmbeddedSignup(
  input: { businessId: number; body: Record<string, unknown> },
  deps: EmbeddedSignupCompleteDeps
): Promise<EmbeddedSignupCompleteResponse> {
  const warn = deps.warn ?? (() => {});
  const { body, businessId } = input;
  const code = typeof body.code === "string" ? body.code : "";
  const phoneNumberId = typeof body.phoneNumberId === "string" ? body.phoneNumberId.trim() : "";
  const wabaId = typeof body.wabaId === "string" ? body.wabaId.trim() : "";

  if (!code || !wabaId) {
    return fail(400, "input", "missing_fields", "code and wabaId are required");
  }

  // ── 1: token exchange (no DB write) ─────────────────────────────────────
  const exchange = await deps.exchangeCodeForToken(code);
  if (!exchange.ok) {
    warn("exchange_failed", { code: exchange.code });
    return fail(502, "exchange", exchange.code);
  }

  // ── 2: phone number (no DB write) ───────────────────────────────────────
  let resolvedPhoneNumberId: string;
  let displayPhoneNumber: string;
  if (phoneNumberId) {
    const display = await deps.fetchPhoneNumberDisplay(phoneNumberId, exchange.accessToken);
    if (!display.ok) {
      warn("display_failed", { code: display.code });
      return fail(502, "display", display.code);
    }
    resolvedPhoneNumberId = phoneNumberId;
    displayPhoneNumber = display.displayPhoneNumber;
  } else {
    // Coexistence: Meta reported only the WABA. Resolve its one number with the
    // token the owner just granted — it can only see that owner's WABA.
    const phone = await deps.fetchWabaPhoneNumber(wabaId, exchange.accessToken);
    if (!phone.ok) {
      warn("waba_phone_failed", { code: phone.code });
      return fail(502, "display", phone.code);
    }
    resolvedPhoneNumberId = phone.phoneNumberId;
    displayPhoneNumber = phone.displayPhoneNumber;
  }

  // ── 3: register the WABA on our app's webhooks (no DB write) ────────────
  // Must succeed BEFORE we persist — a CONNECTED row without a live webhook
  // subscription would silently never receive inbound events.
  const subscription = await deps.subscribeWabaToApp({ wabaId, accessToken: exchange.accessToken });
  if (!subscription.ok) {
    warn("subscribe_failed", { code: subscription.code });
    return fail(502, "subscribe", subscription.code);
  }

  // ── 4: persist (ONLY DB write, only after 1–3 succeeded) ────────────────
  try {
    const connection = await deps.persistFromEmbeddedSignup({
      businessId,
      phoneNumberId: resolvedPhoneNumberId,
      displayPhoneNumber,
      wabaId,
      accessToken: exchange.accessToken,
    });
    return { status: 201, body: { connection } };
  } catch (err) {
    if (isUniqueConflict(err)) {
      return fail(
        409,
        "persist",
        "number_taken",
        "This WhatsApp number is already connected to another account"
      );
    }
    // Do not echo err (may hint at encryption-key config).
    warn("persist_failed", {});
    return fail(500, "persist", "persist_failed");
  }
}
