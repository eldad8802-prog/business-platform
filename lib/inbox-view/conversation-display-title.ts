import type { Translator } from "@/lib/i18n/translate";
import type { InboxItemViewModel } from "./inbox-item.types";
import { INBOX_VIEW_HE_T } from "./inbox-view-i18n";

const SNIPPET_TITLE_MAX = 36;

/** Israeli-style short label from digits only. */
export function formatPhonePreviewLabel(phone: string, t: Translator = INBOX_VIEW_HE_T): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return phone.trim();

  const tail = digits.slice(-4);
  if (digits.startsWith("972") && digits.length >= 11) {
    const local = `0${digits.slice(3, 5)}`;
    return t("insights.inbox.title.customerPhone", { prefix: local, tail });
  }
  if (digits.startsWith("0") && digits.length >= 9) {
    return t("insights.inbox.title.customerPhone", { prefix: digits.slice(0, 3), tail });
  }
  return t("insights.inbox.title.customerTail", { tail });
}

function truncateForTitle(text: string, max = SNIPPET_TITLE_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace >= 12 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

/**
 * List + header title: name → phone → last message → generic fallback.
 */
export function resolveConversationDisplayTitle(
  item: Pick<
    InboxItemViewModel,
    "customerName" | "customerPhone" | "lastMessage"
  > | null,
  t: Translator = INBOX_VIEW_HE_T
): string {
  if (!item) return t("insights.inbox.title.newCustomer");

  const name = item.customerName?.trim();
  if (name) return name;

  const phone = item.customerPhone?.trim();
  if (phone) return formatPhonePreviewLabel(phone, t);

  const snippet = item.lastMessage?.snippet?.trim();
  if (snippet && snippet.length >= 3) {
    return truncateForTitle(snippet);
  }

  return t("insights.inbox.title.newCustomer");
}
