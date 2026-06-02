/** Why routing stopped — no processing beyond this point. */
export type RoutingStopReason =
  | "missing_phone_number_id"
  | "mapping_not_configured"
  | "unknown_phone_number_id"
  | "allowlist_not_configured"
  | "missing_sender"
  | "sender_not_allowlisted"
  | "unsupported_message_type"
  | "missing_media_id"
  | "missing_text_body"
  | "invalid_message";

export type DocumentsIntakeMediaType = "image" | "document";

/**
 * Explicit routing contract for WhatsApp intake.
 *
 * Three outcomes (Bot-MVP-1 expands from two):
 *   - `DOCUMENTS_INTAKE`     — image/document media → OCR + document flow
 *   - `CONVERSATION_INTAKE`  — text → Conversation + bot pipeline
 *   - `STOP`                 — anything else, with structured reason
 *
 * Note on allowlist asymmetry: `DOCUMENTS_INTAKE` enforces the existing
 * per-business allowlist (the `sender` field comes from the allowlist
 * match). `CONVERSATION_INTAKE` bypasses the allowlist because real
 * customers cannot be pre-allowlisted; the business gate for text intake
 * is the presence of a `WhatsAppConnection` row in `CONNECTED` status.
 */
export type RoutingDecision =
  | {
      kind: "DOCUMENTS_INTAKE";
      businessId: number;
      phoneNumberId: string;
      /** Normalized digits-only sender (from allowlist match or webhook). */
      sender: string;
      wamid: string;
      mediaType: DocumentsIntakeMediaType;
      mediaId: string;
      /**
       * Trust origin of the sender:
       *   - `allowlist`    — sender matched the per-business allowlist.
       *   - `conversation` — sender NOT allowlisted, but the business is
       *     identified (`WhatsAppConnection`); media arrived inside a normal
       *     customer conversation. Same downstream pipeline, distinct origin.
       */
      senderTrust: "allowlist" | "conversation";
    }
  | {
      kind: "CONVERSATION_INTAKE";
      businessId: number;
      phoneNumberId: string;
      /** Raw digits-only sender from the webhook — not allowlist-filtered. */
      senderPhone: string;
      wamid: string;
      /** Text body of the customer message, already known to be non-empty. */
      text: string;
    }
  | {
      kind: "STOP";
      reason: RoutingStopReason;
      phoneNumberId?: string;
    };
