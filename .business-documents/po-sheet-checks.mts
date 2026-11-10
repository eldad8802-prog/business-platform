/**
 * "The same copy" checks for the purchase-order sheet runs (R2 battery, production-mode e2e). A comparison of two ids
 * must never pass because both are missing: `undefined === undefined` is true, so a run in which every save failed
 * would report "the same copy". Each id must be a real one (positive integer) and each answer a success.
 * Proven by po-sheet-checks.test.mts.
 */

/** A real row id: a positive safe integer. Never undefined, null, 0, NaN or a string. */
export const validId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** At least two ids, every one real, all equal. */
export const idsMatch = (ids: readonly unknown[]): boolean =>
  ids.length >= 2 && ids.every(validId) && ids.every((id) => id === ids[0]);

export type Answer = { status: number; id: unknown; ok: readonly number[] };

/** At least two HTTP answers, each with a status from its own `ok` list and a real id, all the same id. */
export const sameCopy = (answers: readonly Answer[]): boolean =>
  answers.length >= 2 && answers.every((a) => a.ok.includes(a.status)) && idsMatch(answers.map((a) => a.id));
