import type { WarmPillTone } from "@/components/ui/warm/warm-primitives";

/**
 * Collection (payments) view types + pure formatting/tone helpers, shared by the
 * worklist (master) and the detail. Extracted verbatim from the original
 * payments pages — no behavior change. Business logic stays in the services;
 * these are presentation-only helpers over the existing API shapes.
 */

export type CollectionState =
  | "waiting"
  | "verified"
  | "failed"
  | "expired"
  | "cancelled";

export type CollectionFigure = { amount: string; count: number };

export type CollectionItem = {
  id: number;
  description: string | null;
  amount: string;
  currency: string;
  state: CollectionState;
  stateLabel: string;
};

export type CollectionWorkspaceApi = {
  summary: {
    pending: CollectionFigure;
    collectedThisMonth: CollectionFigure;
    expired: CollectionFigure;
  };
  attention: CollectionItem[];
  active: CollectionItem[];
  history: CollectionItem[];
};

export type CollectionDetailApi = {
  request: {
    id: number;
    status: string;
    amount: string;
    currency: string;
    description: string | null;
    paymentUrl: string | null;
    createdAt: string;
    paidAt: string | null;
  };
  transactions: { id: number; createdAt: string }[];
  audit: { id: number; eventType: string; occurredAt: string }[];
};

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

export function money(amount: string, currency = "ILS"): string {
  const n = Number(amount);
  const sym =
    currency === "ILS" ? "₪" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  if (!Number.isFinite(n)) return `${sym}${amount}`;
  return `${sym}${n.toLocaleString("he-IL")}`;
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "בוקר טוב";
  if (h < 18) return "צהריים טובים";
  return "ערב טוב";
}

export function dailySentence(ws: CollectionWorkspaceApi): { lead: string; soft: string } {
  const open = ws.active.length + ws.attention.length;
  if (open === 0) return { lead: "אין כרגע גביות פתוחות.", soft: "" };
  const openPhrase =
    open === 1 ? "יש לך גבייה אחת פתוחה." : `יש לך ${open} גביות פתוחות.`;
  if (ws.attention.length > 0) {
    const soft =
      ws.attention.length === 1
        ? "אחת דורשת טיפול, השאר מתקדמות כרגיל."
        : `${ws.attention.length} דורשות טיפול, השאר מתקדמות כרגיל.`;
    return { lead: openPhrase, soft };
  }
  return { lead: openPhrase, soft: "כולן מתקדמות כרגיל." };
}

export function toneFor(state: CollectionState): WarmPillTone {
  if (state === "verified") return "verified";
  if (state === "failed" || state === "expired") return "late";
  return "waiting"; // waiting, cancelled
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("he-IL", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Two truth states + honest lifecycle labels (never a faked settlement truth). */
export function statusView(status: string): { label: string; verified: boolean; late: boolean } {
  switch (status) {
    case "PAID":
      return { label: "נגבה ואומת", verified: true, late: false };
    case "FAILED":
      return { label: "התשלום לא הושלם", verified: false, late: true };
    case "EXPIRED":
      return { label: "פג תוקף", verified: false, late: true };
    case "CANCELLED":
      return { label: "הגבייה בוטלה", verified: false, late: false };
    default:
      return { label: "ממתין לתשלום", verified: false, late: false };
  }
}
