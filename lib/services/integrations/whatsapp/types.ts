/** Parsed fields from a single inbound WhatsApp message (Cloud API webhook). */
export type WhatsAppWebhookMessageSummary = {
  phoneNumberId: string | null;
  from: string | null;
  wamid: string | null;
  type: string | null;
  mediaId: string | null;
  /** Text body for type=text messages. Trimmed; null when absent or empty. */
  textBody: string | null;
  /** Meta's unix-seconds `timestamp` for the message, verbatim. Null when absent. */
  timestamp: string | null;
  /**
   * The sender's WhatsApp profile name, from `value.contacts[]` matched on
   * `wa_id`. Null when Meta sent none. Personal data — never logged.
   */
  profileName: string | null;
  /** Click-to-WhatsApp ad referral, reduced to non-personal ad identifiers. */
  referral: WhatsAppReferralSummary | null;
};

/**
 * Meta's `messages[].referral` for a conversation started from a
 * click-to-WhatsApp ad or post. Only the ad-side identifiers are kept — they
 * describe the business's own campaign, not the person.
 */
export type WhatsAppReferralSummary = {
  sourceType: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  headline: string | null;
  ctwaClid: string | null;
};

/**
 * One `value.statuses[]` entry: Meta reporting on a message the BUSINESS sent.
 * Never a customer message. The recipient's number is deliberately not kept.
 */
export type WhatsAppWebhookStatusSummary = {
  phoneNumberId: string | null;
  /** The outbound message's wamid. */
  wamid: string | null;
  /** sent | delivered | read | failed (lower-cased). */
  status: string | null;
  timestamp: string | null;
  /** First error code Meta attached to a failed status. */
  errorCode: string | null;
};

/** Safe subset of a Meta WhatsApp webhook payload for logging and PR1 validation. */
export type WhatsAppWebhookParseResult = {
  object: string | null;
  entryCount: number;
  changeCount: number;
  /**
   * Changes dropped because their `field` is not the supported event class.
   * Surfaced so the boundary is visible in logs — a security boundary nobody
   * can observe is one nobody can verify.
   */
  unsupportedChangeCount: number;
  messages: WhatsAppWebhookMessageSummary[];
  /**
   * Delivery / read / failed receipts for OUTBOUND messages, from
   * `value.statuses[]` under the supported field. Kept apart from `messages`
   * by construction: a receipt can never be dispatched as a customer message.
   */
  statuses: WhatsAppWebhookStatusSummary[];
};
