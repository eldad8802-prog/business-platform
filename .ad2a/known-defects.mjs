/**
 * D2 / ACCOUNT DELETION — the assertions that are KNOWN to fail on current main.
 *
 * WHY A BASELINE EXISTS AT ALL
 *
 * The battery asserts the TRUE security properties: credentials destroyed,
 * conversations gone, evidence written, account reaching a terminal state. On
 * current `main` those are false — proven at runtime, three independent defects
 * in the product, none of them in this harness. So an honest battery is RED
 * today, and a RED required check on every unrelated PR would be turned off
 * within a week.
 *
 * This file is the alternative to turning it off, and to the far worse
 * alternative of writing one test for "before" and another for "after". There is
 * ONE harness. It measures the same properties in both states. This list only
 * records which of them the product currently fails.
 *
 * IT IS A RATCHET, NOT A MUTE.
 *
 *   an assertion here that FAILS        → expected, the known defect
 *   an assertion here that PASSES       → the defect is fixed. The build FAILS
 *                                         until this list is updated, so the fix
 *                                         is recorded deliberately and never
 *                                         drifts in unnoticed.
 *   an assertion NOT here that fails    → a NEW regression. The build FAILS.
 *
 * So the harness cannot go quietly green and cannot go quietly redder.
 *
 * THE TRANSITION, in one line: the product fix empties this array, and the same
 * battery that proved the defect then proves the repair.
 *
 * Each entry names the defect it belongs to so a reader can tell at a glance
 * whether a failure is one of the three we already understand.
 */

/** Stage 1 runs on the tenant client with no GUC; four FORCE-RLS'd tables match zero rows. */
export const DEFECT_A_CREDENTIALS = [
  "Gmail refresh token is DESTROYED",
  "Gmail connection is REVOKED",
  "SHAAM authority tokens are CLEARED and the connection revoked",
  "payment-provider credential is CLEARED and deactivated",
];

/** `Conversation` has no DELETE policy, so `deleteMany` matches zero rows and never raises. */
export const DEFECT_B_CONVERSATION = [
  "A's conversations are gone",
  "A's messages went with them (cascade)",
  "no message body survives the erasure",
];

/** Stage 3 inserts into FORCE-RLS'd `LearningEvent` with no GUC; WITH CHECK raises 42501. */
export const DEFECT_C_FINALIZATION = [
  "erasure evidence was written",
  "A reached the terminal PURGED state",
  "the deletion call reported success",
  "re-requesting deletion is an idempotent no-op",
  "two concurrent deletion requests do not corrupt each other",
  "D ends in exactly one terminal state",
  "D has exactly one erasure evidence row (finalize is conditional)",
  "the deletion resumes cleanly once the audit can be written",
];

export const KNOWN_DEFECTS = [
  ...DEFECT_A_CREDENTIALS,
  ...DEFECT_B_CONVERSATION,
  ...DEFECT_C_FINALIZATION,
];

export function defectOf(name) {
  if (DEFECT_A_CREDENTIALS.includes(name)) return "A/credentials";
  if (DEFECT_B_CONVERSATION.includes(name)) return "B/conversation";
  if (DEFECT_C_FINALIZATION.includes(name)) return "C/finalization";
  return null;
}
