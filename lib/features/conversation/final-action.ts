/**
 * Canonical FinalAction — single Source of Truth.
 *
 * The four post-questions actions a Starter Bot can conclude with. These
 * values already live in multiple places (the bot-settings screen and the
 * starter-bot planner's switch); this module is the one definition the rest
 * of the system imports.
 *
 * Pure constants/types — no behavior, no persistence, no flow coupling.
 */

export type FinalAction =
  | "LEAVE_MESSAGE"
  | "COLLECT_DETAILS"
  | "SEND_LINK"
  | "ESCALATE";

/** Canonical order — matches what the settings screen renders today. */
export const FINAL_ACTIONS: readonly FinalAction[] = [
  "LEAVE_MESSAGE",
  "COLLECT_DETAILS",
  "SEND_LINK",
  "ESCALATE",
];

/** Hebrew display labels (unchanged from the prior local definition). */
export const FINAL_ACTION_LABELS: Record<FinalAction, string> = {
  LEAVE_MESSAGE: "השארת הודעה",
  COLLECT_DETAILS: "איסוף פרטים",
  SEND_LINK: "שליחת קישור",
  ESCALATE: "העברה לנציג",
};

/** `{ value, label }` list — convenience for selects (same shape/order as before). */
export const FINAL_ACTION_OPTIONS: readonly { value: FinalAction; label: string }[] =
  FINAL_ACTIONS.map((value) => ({ value, label: FINAL_ACTION_LABELS[value] }));

/** Type guard for an unknown value. */
export function isFinalAction(v: unknown): v is FinalAction {
  return typeof v === "string" && (FINAL_ACTIONS as readonly string[]).includes(v);
}
