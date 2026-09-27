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

export function money(amount: string | number, currency = "ILS"): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  const formatted = Number.isFinite(n)
    ? n.toLocaleString("he-IL", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })
    : String(amount);
  return `${formatted} ${currencySymbol(currency)}`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Why a verified payment's receipt is paused — and what the owner can do. */
export const ATTENTION_REASON_TEXT: Record<string, { title: string; action: "NAME_CUSTOMER" | "FIX_BUSINESS" | "RETRY" | "REVIEW" }> = {
  // M1 — the provider charged a different sum or currency than was requested.
  // Retrying cannot change what the provider charged, so it is not the lead action.
  VERIFIED_AMOUNT_MISMATCH: { title: "התשלום התקבל בסכום שונה מהבקשה — הקבלה לא הופקה", action: "REVIEW" },
  VERIFIED_CURRENCY_MISMATCH: { title: "התשלום התקבל במטבע שונה מהבקשה — הקבלה לא הופקה", action: "REVIEW" },
  NO_CUSTOMER: { title: "התשלום התקבל, אבל לא ידוע מי שילם", action: "NAME_CUSTOMER" },
  BILLING_IDENTITY_INCOMPLETE: { title: "התשלום התקבל — חסרים פרטי העסק כדי להפיק קבלה", action: "FIX_BUSINESS" },
  RETRY_EXHAUSTED: { title: "התשלום התקבל — הפקת הקבלה נכשלה שוב ושוב", action: "RETRY" },
  CURRENCY_MISMATCH: { title: "התשלום התקבל במטבע שונה מהחשבונית", action: "RETRY" },
  DOCUMENT_NOT_ALLOCATABLE: { title: "התשלום התקבל — החשבונית שלו אינה זמינה לשיוך", action: "RETRY" },
  CUSTOMER_MISMATCH: { title: "התשלום התקבל — הלקוח שונה מלקוח החשבונית", action: "RETRY" },
  TRANSACTION_NOT_ELIGIBLE: { title: "התשלום אינו זמין להפקת קבלה", action: "RETRY" },
};

export function attentionText(reason: string | null | undefined) {
  return ATTENTION_REASON_TEXT[reason ?? ""] ?? { title: "התשלום התקבל — הקבלה ממתינה לטיפול", action: "RETRY" as const };
}

export type BlockerCode = "NO_PAYMENT_PROVIDER" | "PAYMENT_PROVIDER_AMBIGUOUS" | "BILLING_IDENTITY_INCOMPLETE";

export const BLOCKER_TEXT: Record<BlockerCode, { title: string; body: string; href: string; cta: string }> = {
  NO_PAYMENT_PROVIDER: {
    title: "צריך לחבר חברת סליקה",
    body: "כדי שלקוחות יוכלו לשלם בקישור, חברו פעם אחת את חשבון הסליקה של העסק.",
    href: "/settings/connections",
    cta: "לחיבור סליקה",
  },
  PAYMENT_PROVIDER_AMBIGUOUS: {
    title: "מחוברות כמה חברות סליקה",
    body: "השאירו חיבור פעיל אחד, כדי שכל גבייה תעבור בדרך אחת וקבועה.",
    href: "/settings/connections",
    cta: "לניהול החיבורים",
  },
  BILLING_IDENTITY_INCOMPLETE: {
    title: "חסרים פרטי העסק לקבלות",
    body: "כשלקוח משלם, Dubiz מפיק קבלה אוטומטית. לשם כך צריך את שם העסק, מספר עוסק וכתובת.",
    href: "/business",
    cta: "להשלמת פרטי העסק",
  },
};

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
