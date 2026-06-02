/** Parsed fields from a single inbound WhatsApp message (Cloud API webhook). */
export type WhatsAppWebhookMessageSummary = {
  phoneNumberId: string | null;
  from: string | null;
  wamid: string | null;
  type: string | null;
  mediaId: string | null;
  /** Text body for type=text messages. Trimmed; null when absent or empty. */
  textBody: string | null;
};

/** Safe subset of a Meta WhatsApp webhook payload for logging and PR1 validation. */
export type WhatsAppWebhookParseResult = {
  object: string | null;
  entryCount: number;
  changeCount: number;
  messages: WhatsAppWebhookMessageSummary[];
};
