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

/**
 * CLOSED. Stage 1's credential destruction now runs inside runTenantJob +
 * withTenantTransaction, so the four FORCE-RLS'd tables are reachable and the
 * secrets are actually destroyed. The battery asserts all four as ordinary
 * requirements now; if any regresses, it fails outright rather than being
 * absorbed here.
 */
export const DEFECT_A_CREDENTIALS = [];

/**
 * CLOSED, and by a change of property rather than a change of privilege.
 *
 * The three entries here asserted that `Conversation` rows were DELETED. They
 * failed because the table has no DELETE policy, deliberately, and the owner's
 * decision was anonymise-in-place rather than granting one. So the assertions
 * were not removed — they were REPLACED by stronger ones that read every
 * surviving row back and require that no raw content, no derived content, no
 * provider linkage and no participant linkage is left anywhere in the graph,
 * plus a marker sweep that catches a field nobody remembered to clear.
 *
 * A delete-count could have passed while derived analysis or a generated reply
 * survived elsewhere. These cannot.
 */
export const DEFECT_B_CONVERSATION = [];

/**
 * CLOSED. Stage 3 writes its evidence under tenant context and BEFORE the
 * terminal transition, so `LearningEvent` is no longer refused and a deletion
 * can reach PURGED. The eight assertions here covered the whole downstream
 * wreckage of that one refusal — terminal state, reported success, idempotent
 * re-request, both concurrency cases and the resume — and all eight now hold.
 */
export const DEFECT_C_FINALIZATION = [];

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
