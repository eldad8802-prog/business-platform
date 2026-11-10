/**
 * Proof that the "same copy" checks cannot pass when the saves failed (run 42725350210: every save answered 500 and
 * the old E4 comparison `rv1?.id === v1?.id` still printed PASS). No database, no storage.
 */
import assert from "node:assert/strict";

import { idsMatch, sameCopy, validId } from "./po-sheet-checks.mts";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`PASS  ${name}`); };

const saved = (id: unknown, status = 201) => ({ status, id, ok: [201] as const });
const replay = (id: unknown, status = 200) => ({ status, id, ok: [200] as const });

t("the old E4 comparison passes when both requests answer 500 (the bug)", () => {
  const bodyOf500 = (): { id: number } | null => null; // the e2e parses a body only on 201 / 200
  const v1 = bodyOf500();
  const rv1 = bodyOf500();
  assert.equal(v1?.id === rv1?.id, true);
});

t("E4: both requests answer 500 → fails", () => assert.equal(sameCopy([saved(undefined, 500), replay(undefined, 500)]), false));
t("E4: the save succeeds, the retry answers 500 → fails", () => assert.equal(sameCopy([saved(7), replay(undefined, 500)]), false));
t("E4: the save answers 500, the retry succeeds → fails", () => assert.equal(sameCopy([saved(undefined, 500), replay(7)]), false));
t("E4: a success status without an id → fails", () => assert.equal(sameCopy([saved(7), replay(undefined)]), false));
t("E4: an id under a failure status → fails", () => assert.equal(sameCopy([saved(7), replay(7, 500)]), false));
t("E4: two different copies → fails", () => assert.equal(sameCopy([saved(7), replay(8)]), false));
t("E4: 201 then 200 with the same id → passes", () => assert.equal(sameCopy([saved(7), replay(7)]), true));

t("E3: both clicks fail (500, 409) and the retry answers 200 → fails (no saved copy to compare)", () =>
  assert.equal(sameCopy([replay(7)]), false));
t("E3: one click saved, the retry answers 500 → fails", () =>
  assert.equal(sameCopy([saved(7), replay(undefined, 500)]), false));
t("E3: one click saved, the other replayed, the retry replays the same copy → passes", () =>
  assert.equal(sameCopy([{ status: 201, id: 7, ok: [200, 201] }, { status: 200, id: 7, ok: [200, 201] }, replay(7)]), true));

t("a single answer is never 'the same copy'", () => assert.equal(sameCopy([saved(7)]), false));
t("no answers → fails", () => assert.equal(sameCopy([]), false));

t("ids: undefined, null, 0, NaN, negative, fraction, string are not real ids", () => {
  for (const v of [undefined, null, 0, Number.NaN, -1, 1.5, "7", {}]) assert.equal(validId(v), false, String(v));
  assert.equal(validId(7), true);
});
t("idsMatch: [undefined, undefined] → fails", () => assert.equal(idsMatch([undefined, undefined]), false));
t("idsMatch: an empty winner list plus the retry → fails", () => assert.equal(idsMatch([...[], 7]), false));
t("idsMatch: [7, 7] → passes; [7, 8] → fails", () => {
  assert.equal(idsMatch([7, 7]), true);
  assert.equal(idsMatch([7, 8]), false);
});

console.log(`${n} passed, 0 failed`);
