/**
 * Home history — the pure half of GET /api/home/history.
 *
 * Every flag answers one question: "has this business EVER had a real business
 * event of this kind?" — not "is there an active row right now", and never
 * "is today's value 0". The Home uses it only to choose between a card's quiet
 * first-time state and its normal view; a card that already has rows to show
 * always shows them (see `showsFirstTime`), so a cached or failed flag can
 * never hide real data.
 *
 * The SQL that decides each flag lives in home-history.service.ts; the event
 * each one stands for is spelled out there, next to its predicate.
 */

export const HOME_HISTORY_FLAGS = [
  "income",
  "expenses",
  "obligations",
  "collection",
  "documents",
  "leads",
  "conversations",
  "inventory",
  "insights",
  "identityDescription",
] as const;

export type HomeHistoryFlag = (typeof HOME_HISTORY_FLAGS)[number];

/**
 * What the lead card may offer about WhatsApp, from the connection's real
 * semantics (lib/services/integrations/whatsapp/connection.service.ts):
 *   NEVER         — no connection row: never connected.
 *   CONNECTED     — inbound and outbound work; nothing to offer.
 *   DISCONNECTED  — DISCONNECTED / REVOKED: inbound is refused; reconnecting fixes it.
 *   ATTENTION     — REVOKED_BY_META / ERROR: inbound STILL arrives, sending does
 *                   not; it needs handling, and must never be described as
 *                   "disconnected".
 */
export type WhatsAppHomeState = "NEVER" | "CONNECTED" | "DISCONNECTED" | "ATTENTION";

export type HomeHistory = Record<HomeHistoryFlag, boolean> & { whatsapp: WhatsAppHomeState };

export function whatsAppHomeState(status: string | null | undefined): WhatsAppHomeState {
  switch (status) {
    case null:
    case undefined:
      return "NEVER";
    case "CONNECTED":
      return "CONNECTED";
    case "DISCONNECTED":
    case "REVOKED":
      return "DISCONNECTED";
    // REVOKED_BY_META, ERROR, and any status this code does not know yet: the
    // safe reading is "look at it", never a claim that messages stopped.
    default:
      return "ATTENTION";
  }
}

/** The lead card's connection action — null when there is nothing to offer. */
export function whatsAppAction(state: WhatsAppHomeState): { label: string; href: string } | null {
  switch (state) {
    case "NEVER":
      return { label: "חיבור וואטסאפ", href: "/settings/whatsapp" };
    case "DISCONNECTED":
      return { label: "חיבור מחדש", href: "/settings/whatsapp" };
    case "ATTENTION":
      return { label: "טיפול בחיבור", href: "/settings/whatsapp" };
    case "CONNECTED":
      return null;
  }
}

/**
 * The card shows its first-time state only when history is KNOWN to be absent
 * AND the card has nothing of its own to show. Loading / failed history falls
 * back to the card's ordinary empty line.
 */
export function showsFirstTime(history: HomeHistory | null, flag: HomeHistoryFlag, cardHasRows: boolean): boolean {
  if (cardHasRows) return false;
  if (!history) return false;
  return history[flag] === false;
}

/** Strict parse of the wire shape — anything malformed is treated as unknown (null). */
export function parseHomeHistory(raw: unknown): HomeHistory | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: Partial<HomeHistory> = {};
  for (const f of HOME_HISTORY_FLAGS) {
    if (typeof r[f] !== "boolean") return null;
    out[f] = r[f] as boolean;
  }
  const wa = r.whatsapp;
  if (wa !== "NEVER" && wa !== "CONNECTED" && wa !== "DISCONNECTED" && wa !== "ATTENTION") return null;
  out.whatsapp = wa;
  return out as HomeHistory;
}
