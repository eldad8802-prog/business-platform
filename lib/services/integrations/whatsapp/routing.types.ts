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
 * is a `WhatsAppConnection` row whose status still accepts inbound
 * (`connectionAcceptsInbound`).
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
      /**
       * M2: the tenant IS known and the provider event is real, but Dubiz does
       * not materialise this kind of message (audio, sticker, location, a text
       * with no body, media without an id, a message with no usable sender).
       * Before M2 this was a STOP and left no trace; it is now recorded as an
       * IGNORED intake receipt, so what arrived stays visible.
       */
      kind: "UNSUPPORTED";
      businessId: number;
      phoneNumberId: string;
      wamid: string;
      reason: RoutingStopReason;
      /** Provider message type, lower-cased; empty when Meta sent none. */
      messageType: string;
    }
  | {
      /** No tenant, or no provider id: nothing can be recorded against anyone. */
      kind: "STOP";
      reason: RoutingStopReason;
      phoneNumberId?: string;
    };
