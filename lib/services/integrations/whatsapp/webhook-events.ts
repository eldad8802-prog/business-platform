/**
 * Structured logging primitives for the WhatsApp inbound + intake pipeline.
 *
 * Why this exists
 *   First-real-customer debugging is impossible without consistent event
 *   tags. Every observable transition in the inbound pipeline emits one
 *   event with a stable name + a small structured payload.
 *
 * Output format
 *   Each `logEvent(name, fields)` call produces:
 *
 *     console.info("[wa-event:NAME]", { ...fields })
 *
 *   matching the existing convention used by `webhook-parse` /
 *   `routing-gate` (`[whatsapp-webhook]`, `[whatsapp-webhook-routing]`).
 *
 * Discipline
 *   - Never log the customer's raw phone number — use `maskSenderDigits`.
 *   - Never log the message body in full — use `contentLength` instead. The
 *     existing `/api/message` flow does not log content either; we keep
 *     parity.
 *   - Never log access tokens, IVs, or auth tags. Crypto values live only
 *     inside `token-crypto.service`.
 *   - Always log `businessId`, `conversationId` (when resolved) so events
 *     can be joined across a single inbound message.
 */

export type WhatsAppPipelineEvent =
  /** Webhook accepted a parsed text message and is about to route. */
  | "INBOUND_WHATSAPP_RECEIVED"
  /** Routing layer could not resolve a business for this phoneNumberId. */
  | "UNKNOWN_PHONE_NUMBER_ID"
  /** Intake upserted (or matched) a Customer row for this sender. */
  | "CUSTOMER_RESOLVED"
  /** Intake reused or created an OPEN Conversation for this customer. */
  | "CONVERSATION_RESOLVED"
  /** Pipeline analyzed a customer-inbound message (intent + stage). */
  | "MESSAGE_ANALYZED"
  /** Bot policy engine returned a decision (eligible / handoff / etc). */
  | "BOT_POLICY_DECISION"
  /** Starter bot planner wrote a ReplySuggestion for owner review. */
  | "STARTER_BOT_DRAFT_CREATED"
  /** Outbound send service was asked to deliver an owner message. */
  | "OUTBOUND_SEND_REQUESTED"
  /** Graph API accepted the outbound; provider wamid recorded. */
  | "OUTBOUND_SEND_SUCCESS"
  /** Graph API rejected the outbound; sendStatus = FAILED. */
  | "OUTBOUND_SEND_FAILED"
  /** Outbound blocked because 24h customer-service window expired. */
  | "WINDOW_EXPIRED";

/**
 * Emit a structured pipeline event. Single source of truth for the
 * log-line shape so downstream log aggregation (Datadog, BetterStack,
 * Logflare, etc.) can pivot on the `wa-event:NAME` tag.
 */
export function logEvent(
  event: WhatsAppPipelineEvent,
  fields: Record<string, unknown>
): void {
  // Strip any accidentally-present sensitive keys before emitting.
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const kl = k.toLowerCase();
    if (
      kl.includes("token") ||
      kl.includes("secret") ||
      kl === "accesstoken" ||
      kl === "iv" ||
      kl === "tag"
    ) {
      continue; // never let a caller leak a token through this helper
    }
    safe[k] = v;
  }
  console.info(`[wa-event:${event}]`, safe);
}

/**
 * Mask a sender phone for log emission. Mirrors the masking done by
 * `routing-gate.maskSenderDigits` but accepts arbitrary input length.
 */
export function maskSenderForLog(digits: string | null | undefined): string {
  if (!digits) return "****";
  if (digits.length <= 4) return "****";
  return `***${digits.slice(-4)}`;
}

/**
 * Truncate a wamid for log emission. Full wamid is high-entropy but long;
 * a 16-char prefix is enough to correlate across log lines and trace tools.
 */
export function wamidPrefixForLog(wamid: string | null | undefined): string {
  if (!wamid) return "";
  return wamid.length <= 16 ? wamid : wamid.slice(0, 16);
}
