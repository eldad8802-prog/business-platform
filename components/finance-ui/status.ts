/**
 * One status vocabulary for the Secretary and Payables.
 *
 * No status here is new. Each key is a state the server already derives:
 *   - payables installment/commitment states (lib/payables/payables-client.ts
 *     DerivedState, labels = STATE_LABEL, verbatim), and
 *   - the Secretary's attention reasons and lifecycle (obligation-core.ts).
 * This module only decides how each one LOOKS, so the same state reads the
 * same on both screens.
 *
 * "טופל" (handled) and "שולם" (paid) deliberately never share a tone: marking
 * a reminder handled records no money (handled ≠ paid).
 */

import { STATE_LABEL, type DerivedState } from "@/lib/payables/payables-client";
import type { AttentionReason } from "@/lib/obligations/secretary-client";

export type StatusTone = "danger" | "warning" | "info" | "success" | "neutral" | "handled";

export type SecretaryStatus = AttentionReason | "WATCHING" | "MET" | "RELEASED";

export type StatusKey =
  | { domain: "payables"; state: DerivedState }
  | { domain: "secretary"; state: SecretaryStatus };

const PAYABLES_TONE: Record<DerivedState, StatusTone> = {
  OVERDUE: "danger",
  DUE: "warning",
  PARTIALLY_PAID: "info",
  SCHEDULED: "neutral",
  PAID: "success",
  CANCELLED: "neutral",
  SETTLED_LEGACY: "handled",
};

/** The Secretary's existing wording (secretary/page.tsx dueBadge + lifecycle). */
export const SECRETARY_STATUS_LABEL: Record<SecretaryStatus, string> = {
  OVERDUE: "באיחור",
  DUE_TODAY: "להיום",
  DUE_SOON: "מתקרב",
  WATCHING: "במעקב",
  MET: "טופל",
  RELEASED: "הוסר",
};

const SECRETARY_TONE: Record<SecretaryStatus, StatusTone> = {
  OVERDUE: "danger",
  DUE_TODAY: "warning",
  DUE_SOON: "warning",
  WATCHING: "neutral",
  MET: "handled",
  RELEASED: "neutral",
};

export function statusLabel(key: StatusKey): string {
  return key.domain === "payables" ? STATE_LABEL[key.state] : SECRETARY_STATUS_LABEL[key.state];
}

export function statusTone(key: StatusKey): StatusTone {
  return key.domain === "payables" ? PAYABLES_TONE[key.state] : SECRETARY_TONE[key.state];
}

/** Every payables state and every secretary status has a label and a tone. */
export const ALL_PAYABLES_STATES = Object.keys(PAYABLES_TONE) as DerivedState[];
export const ALL_SECRETARY_STATUSES = Object.keys(SECRETARY_TONE) as SecretaryStatus[];
