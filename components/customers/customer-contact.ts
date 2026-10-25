import { toWhatsAppNumber } from "@/lib/services/billing/collection/collection-display";

/**
 * Contact links for the customer list cards and the customer file.
 *
 * Each returns null when the stored value cannot be trusted, and the screen
 * then shows that action as unavailable instead of dialing, messaging or
 * mailing a guess. WhatsApp only opens the chat — no `?text=` is ever attached,
 * so nothing is pre-written or sent on the owner's behalf.
 */

/** `tel:` link. A canonical Israeli number (`972…`) gets its `+`; anything else keeps its own digits. */
export function telHref(phone: string | null | undefined): string | null {
  const trimmed = (phone ?? "").trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) return null;
  const international = trimmed.startsWith("+") || digits.startsWith("972");
  return `tel:${international ? "+" : ""}${digits}`;
}

/** Opens the WhatsApp chat with the customer — same number rules as Collection's send button. */
export function whatsAppChatHref(phone: string | null | undefined): string | null {
  const number = toWhatsAppNumber(phone);
  return number ? `https://wa.me/${number}` : null;
}

/** `mailto:` link for a plausible single address. */
export function mailHref(email: string | null | undefined): string | null {
  const trimmed = (email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return `mailto:${trimmed}`;
}

/** Two-letter initials for the avatar: first letters of the first two words, or the first two letters of one word. */
export function customerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] ?? "") + (parts[1][0] ?? "");
}
