/**
 * Which owner actions are open today — ONE registry for the screens that show them and, from milestone B, for
 * the daily-tasks source adapters that must not turn an item into a task while its action is closed
 * (Daily Tasks spec, section 4.5).
 *
 * Until now these decisions lived as bare `comingSoon` / `disabled` literals inside the components (#718,
 * 9ba926ec). The server could not know that a button was closed, so a task could have pointed the owner at a
 * screen whose action is marked "בקרוב". Moving the decisions here is a MOVE ONLY: every entry below keeps the
 * exact state its component hard-coded, so no button opens and every screen looks the same.
 *
 * Opening an action is a separate decision of the domain that owns it (WhatsApp, the Tax Authority, Meta,
 * the secretary's notification preferences) — never a side effect of the task engine. When an entry flips to
 * OPEN, the matching task appears by itself and its treatment cycle starts only then.
 *
 * Pure and dependency-free: safe in client components and on the server.
 */

export type ActionAvailabilityState = "OPEN" | "COMING_SOON";

export type OwnerActionId =
  /** WhatsApp Business: reconnect a broken connection (connected card + error retry). */
  | "whatsapp.reconnect"
  /** WhatsApp Business: move the connection to another number. */
  | "whatsapp.switch_number"
  /** WhatsApp Business: first connection (embedded signup). */
  | "whatsapp.connect"
  /** Tax Authority (allocation numbers): first connection. */
  | "tax_authority.connect"
  /** Tax Authority: reconnect after a revoke or an error. */
  | "tax_authority.reconnect"
  /** Meta lead ads: log in with Facebook / connect another page. */
  | "meta_lead_ads.connect"
  /** Meta lead ads: reconnect a page in error. */
  | "meta_lead_ads.reconnect"
  /** Secretary notification preferences (on/off, morning summary, quiet hours) — not persisted yet (R7). */
  | "secretary.notification_preferences";

export const OWNER_ACTION_AVAILABILITY: Readonly<Record<OwnerActionId, ActionAvailabilityState>> = Object.freeze({
  "whatsapp.reconnect": "COMING_SOON",
  "whatsapp.switch_number": "COMING_SOON",
  "whatsapp.connect": "COMING_SOON",
  "tax_authority.connect": "COMING_SOON",
  "tax_authority.reconnect": "COMING_SOON",
  "meta_lead_ads.connect": "COMING_SOON",
  "meta_lead_ads.reconnect": "COMING_SOON",
  "secretary.notification_preferences": "COMING_SOON",
});

/** True while the action is marked "בקרוב": the button stays, inactive, with the coming-soon pill. */
export function isComingSoon(action: OwnerActionId): boolean {
  return OWNER_ACTION_AVAILABILITY[action] === "COMING_SOON";
}

/** True when the owner can perform the action today. A task may point only at an open action. */
export function isActionOpen(action: OwnerActionId): boolean {
  return OWNER_ACTION_AVAILABILITY[action] === "OPEN";
}
