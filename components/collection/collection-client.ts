"use client";

/**
 * Client-side seam for the collection product (/collection).
 *
 * One place for: the authenticated fetch, money/date formatting, and the
 * owner-facing words for every state. The words are deliberately limited to
 * what Dubiz can prove:
 *   ממתין      — asked; no terminal answer yet
 *   נכשל       — the provider authoritatively refused the payment
 *   דורש טיפול — the outcome or the accounting cannot safely be completed yet
 *   בוטל       — the owner stopped asking
 *   שולם       — the provider verified the money
 * There is no "sent", "delivered" or "read": Dubiz opens WhatsApp or copies a
 * link; it cannot see what happens after.
 */

import { useMemo } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import { formatAmount } from "@/lib/i18n/format";
import { moneyHe } from "@/lib/i18n/messages/areas/money";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
import { currencySymbol } from "@/lib/services/billing/collection/collection-display";

export function authToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

export class CollectionApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** Authenticated JSON fetch. A 401 sends the owner to login, like every other screen. */
export async function collectionFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = authToken();
  if (!token) {
    window.location.href = "/login";
    throw new CollectionApiError("unauthenticated", 401);
  }
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new CollectionApiError("unauthenticated", 401);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; code?: string };
  if (!res.ok) {
    throw new CollectionApiError(body.error || body.message || "שגיאה", res.status, body.code);
  }
  return body as T;
}

export function money(amount: string | number, currency = "ILS", locale: Locale = "he"): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  // Non-Hebrew locales use the shared formatter; Hebrew keeps its exact legacy shape ("1,500 ₪").
  if (locale !== "he") {
    return Number.isFinite(n) ? formatAmount(n, currency, { locale }, { fixedFraction: n % 1 !== 0 }) : String(amount);
  }
  const formatted = Number.isFinite(n)
    ? n.toLocaleString("he-IL", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })
    : String(amount);
  return `${formatted} ${currencySymbol(currency)}`;
}

export function shortDate(iso: string | null | undefined, locale: Locale = "he"): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(intlTag(locale), { day: "numeric", month: "numeric", year: "2-digit" });
}

export function dateTime(iso: string | null | undefined, locale: Locale = "he"): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(intlTag(locale), { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Why a verified payment's receipt is paused — and what the owner can do. */
export const ATTENTION_REASON_TEXT: Record<string, { title: string; action: "NAME_CUSTOMER" | "FIX_BUSINESS" | "RETRY" | "REVIEW" }> = {
  // M1 — the provider charged a different sum or currency than was requested.
  // Retrying cannot change what the provider charged, so it is not the lead action.
  VERIFIED_AMOUNT_MISMATCH: { title: moneyHe.collection.attention.VERIFIED_AMOUNT_MISMATCH, action: "REVIEW" },
  VERIFIED_CURRENCY_MISMATCH: { title: moneyHe.collection.attention.VERIFIED_CURRENCY_MISMATCH, action: "REVIEW" },
  NO_CUSTOMER: { title: moneyHe.collection.attention.NO_CUSTOMER, action: "NAME_CUSTOMER" },
  BILLING_IDENTITY_INCOMPLETE: { title: moneyHe.collection.attention.BILLING_IDENTITY_INCOMPLETE, action: "FIX_BUSINESS" },
  RETRY_EXHAUSTED: { title: moneyHe.collection.attention.RETRY_EXHAUSTED, action: "RETRY" },
  CURRENCY_MISMATCH: { title: moneyHe.collection.attention.CURRENCY_MISMATCH, action: "RETRY" },
  DOCUMENT_NOT_ALLOCATABLE: { title: moneyHe.collection.attention.DOCUMENT_NOT_ALLOCATABLE, action: "RETRY" },
  CUSTOMER_MISMATCH: { title: moneyHe.collection.attention.CUSTOMER_MISMATCH, action: "RETRY" },
  TRANSACTION_NOT_ELIGIBLE: { title: moneyHe.collection.attention.TRANSACTION_NOT_ELIGIBLE, action: "RETRY" },
  // Core safety — paused ON PURPOSE. "Try again" would issue exactly the
  // document the pause withholds, so none of these offers a retry.
  PROVIDER_ISSUED_DOCUMENT: {
    title: moneyHe.collection.attention.PROVIDER_ISSUED_DOCUMENT,
    action: "REVIEW",
  },
  DOCUMENT_ISSUER_NOT_CONFIGURED: {
    title: moneyHe.collection.attention.DOCUMENT_ISSUER_NOT_CONFIGURED,
    action: "REVIEW",
  },
  PROVIDER_IS_DOCUMENT_ISSUER: {
    title: moneyHe.collection.attention.PROVIDER_IS_DOCUMENT_ISSUER,
    action: "REVIEW",
  },
  TEST_ENVIRONMENT_PAYMENT: {
    title: moneyHe.collection.attention.TEST_ENVIRONMENT_PAYMENT,
    action: "REVIEW",
  },
  REFUND_ACCOUNTING_DECISION_REQUIRED: {
    title: moneyHe.collection.attention.REFUND_ACCOUNTING_DECISION_REQUIRED,
    action: "REVIEW",
  },
  // The money is recorded; a receipt in a foreign currency waits for the
  // accounting rules. Retrying cannot change the currency, so no retry lead.
  FOREIGN_CURRENCY_DOCUMENT_HELD: {
    title: moneyHe.collection.attention.FOREIGN_CURRENCY_DOCUMENT_HELD,
    action: "REVIEW",
  },
  // A foreign-currency payment whose CardCom document is missing. The money is
  // recorded; retrying cannot make CardCom issue it, and Dubiz never issues one
  // in its place — so no retry lead.
  PROVIDER_DOCUMENT_MISSING: {
    title: moneyHe.collection.attention.PROVIDER_DOCUMENT_MISSING,
    action: "REVIEW",
  },
};

/** With a translator the title is localized; without one it is the Hebrew text (unchanged behaviour). */
export function attentionText(reason: string | null | undefined, t?: Translator) {
  const hit = ATTENTION_REASON_TEXT[reason ?? ""];
  if (!hit) {
    const title = t ? t("money.collection.attention.fallback") : moneyHe.collection.attention.fallback;
    return { title, action: "RETRY" as const };
  }
  return t ? { ...hit, title: t(`money.collection.attention.${reason}` as MessageKey) } : hit;
}

export type BlockerCode = "NO_PAYMENT_PROVIDER" | "PAYMENT_PROVIDER_AMBIGUOUS" | "BILLING_IDENTITY_INCOMPLETE";

export const BLOCKER_TEXT: Record<BlockerCode, { title: string; body: string; href: string; cta: string }> = {
  NO_PAYMENT_PROVIDER: {
    title: moneyHe.collection.blockers.NO_PAYMENT_PROVIDER.title,
    body: moneyHe.collection.blockers.NO_PAYMENT_PROVIDER.body,
    href: "/settings/connections",
    cta: moneyHe.collection.blockers.NO_PAYMENT_PROVIDER.cta,
  },
  PAYMENT_PROVIDER_AMBIGUOUS: {
    title: moneyHe.collection.blockers.PAYMENT_PROVIDER_AMBIGUOUS.title,
    body: moneyHe.collection.blockers.PAYMENT_PROVIDER_AMBIGUOUS.body,
    href: "/settings/connections",
    cta: moneyHe.collection.blockers.PAYMENT_PROVIDER_AMBIGUOUS.cta,
  },
  BILLING_IDENTITY_INCOMPLETE: {
    title: moneyHe.collection.blockers.BILLING_IDENTITY_INCOMPLETE.title,
    body: moneyHe.collection.blockers.BILLING_IDENTITY_INCOMPLETE.body,
    href: "/business",
    cta: moneyHe.collection.blockers.BILLING_IDENTITY_INCOMPLETE.cta,
  },
};

/** BLOCKER_TEXT, localized. */
export function blockerText(code: BlockerCode, t: Translator) {
  return {
    title: t(`money.collection.blockers.${code}.title`),
    body: t(`money.collection.blockers.${code}.body`),
    href: BLOCKER_TEXT[code].href,
    cta: t(`money.collection.blockers.${code}.cta`),
  };
}

/** The money/date helpers above, bound to the active interface language. */
export function useCollectionFormat() {
  const { locale } = useI18n();
  return useMemo(
    () => ({
      money: (amount: string | number, currency?: string) => money(amount, currency, locale),
      shortDate: (iso: string | null | undefined) => shortDate(iso, locale),
      dateTime: (iso: string | null | undefined) => dateTime(iso, locale),
    }),
    [locale],
  );
}

/** Share a link through the device, falling back to copy. Returns what actually happened. */
export async function shareOrCopy(text: string, url: string): Promise<"shared" | "copied" | "failed"> {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      await navigator.share({ text, url });
      return "shared";
    }
  } catch {
    // user dismissed the share sheet — fall through to copy
  }
  return (await copyText(url)) ? "copied" : "failed";
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function whatsAppHref(phoneE164Digits: string | null, text: string): string {
  const base = phoneE164Digits ? `https://wa.me/${phoneE164Digits}` : "https://wa.me/";
  return `${base}?text=${encodeURIComponent(text)}`;
}

/** Which subject a reminder was about. At least one is always supplied. */
export type CollectionActionSubject = {
  customerId?: number | null;
  paymentRequestId?: number | null;
  billingDocumentId?: number | null;
};

/**
 * Tell the server that the owner initiated a reminder.
 *
 * WHAT THIS IS FOR. Everything above hands off to the device — the share sheet, the clipboard,
 * WhatsApp — and hands back nothing. Until now that meant the act left no trace at all, so nobody
 * could later ask whether a customer had ever been chased, through what, or whether payment followed.
 * This is the line that makes the act observable, and it claims no more than the act itself: the
 * owner pressed the button. Not that a message was sent. Not that anyone read it.
 *
 * DELIBERATELY UNAWAITED AND SILENT AT EVERY CALL SITE. Recording a reminder must never be able to
 * delay or prevent one. If this fails, the owner still shared their link and the only loss is a row.
 */
export function recordCollectionAction(
  actionType: "SHARE_INITIATED" | "LINK_COPIED" | "MESSAGE_COPIED" | "WHATSAPP_OPENED",
  channel: "WHATSAPP" | "SYSTEM_SHARE" | "CLIPBOARD" | "UNKNOWN",
  subject: CollectionActionSubject,
): void {
  if (typeof window === "undefined") return;
  const token = authToken();
  if (!token) return;
  void fetch("/api/collection/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ actionType, channel, ...subject }),
    keepalive: true,
  }).catch(() => {
    // Intentionally swallowed. See above: the reminder already happened.
  });
}
