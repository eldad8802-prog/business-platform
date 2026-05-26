import type { InboxItemViewModel } from "./inbox-item.types";

const SNIPPET_TITLE_MAX = 36;

/** Israeli-style short label from digits only. */
export function formatPhonePreviewLabel(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return phone.trim();

  const tail = digits.slice(-4);
  if (digits.startsWith("972") && digits.length >= 11) {
    const local = `0${digits.slice(3, 5)}`;
    return `לקוח ${local}…${tail}`;
  }
  if (digits.startsWith("0") && digits.length >= 9) {
    return `לקוח ${digits.slice(0, 3)}…${tail}`;
  }
  return `לקוח …${tail}`;
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
  > | null
): string {
  if (!item) return "לקוח חדש";

  const name = item.customerName?.trim();
  if (name) return name;

  const phone = item.customerPhone?.trim();
  if (phone) return formatPhonePreviewLabel(phone);

  const snippet = item.lastMessage?.snippet?.trim();
  if (snippet && snippet.length >= 3) {
    return truncateForTitle(snippet);
  }

  return "לקוח חדש";
}
