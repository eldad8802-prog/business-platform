/**
 * The WhatsApp connection experience's copy (invitation, connecting, error, connected states,
 * settings card, reconnect banner, disconnect dialog).
 *
 * The strings now live in the i18n dictionary (`inbox.whatsapp.*` in
 * lib/i18n/messages/areas/inbox.ts) — components read them with `t()`. `WA_COPY` stays as the
 * Hebrew source view of that same copy (tests pin it); the helpers below resolve the
 * dynamically-keyed lines (error code / connection status → sentence) in the active language.
 */
import { inboxHe } from "@/lib/i18n/messages/areas/inbox";
import type { MessageKey, Translator } from "@/lib/i18n/translate";

const W = inboxHe.whatsapp;

/** Hebrew source copy (verbatim the approved UX document, "שלושה רגעים"). */
export const WA_COPY = {
  ...W,
  error: { ...W.error, reasons: W.error.reasons as Readonly<Record<string, string>> },
  attention: W.attention as { readonly badge: string } & Readonly<Record<string, string>>,
  disconnectedNotice: W.disconnectedNotice as Readonly<Record<string, string>>,
} as const;

const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * The owner-facing reason for a failed connect attempt (falls back to the generic line).
 * Without `t` it returns the Hebrew source text.
 */
export function waConnectErrorText(code: string | null | undefined, t?: Translator): string {
  if (code && has(W.error.reasons, code)) {
    return t ? t(`inbox.whatsapp.error.reasons.${code}` as MessageKey) : WA_COPY.error.reasons[code];
  }
  return t ? t("inbox.whatsapp.error.body") : WA_COPY.error.body;
}

/** The "needs attention" reason for a connection status, or null when none applies. */
export function waAttentionText(status: string, t: Translator): string | null {
  if (status === "badge" || !has(W.attention, status)) return null;
  return t(`inbox.whatsapp.attention.${status}` as MessageKey);
}

/** Why a previous number no longer receives messages (unknown statuses → DISCONNECTED). */
export function waDisconnectedNoticeText(status: string, t: Translator): string {
  const known = status !== "numberLabel" && has(W.disconnectedNotice, status);
  return t(`inbox.whatsapp.disconnectedNotice.${known ? status : "DISCONNECTED"}` as MessageKey);
}

export type WaOutboundReason = keyof typeof W.outbound;
