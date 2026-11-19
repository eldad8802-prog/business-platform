/**
 * "Who am I acting as?" (lib/legal-identity/signed-in-as.ts). Pure: no DB, no network.
 *   node_modules/.bin/tsx lib/legal-identity/signed-in-as.test.ts
 */
import assert from "node:assert/strict";

import { identityChanged, parseMe, sessionSwitched, signedInLine } from "./signed-in-as";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  [PASS] ${name}`);
}

const me = { userId: 7, email: "owner@example.test", businessId: 93, businessName: "עסק בדיקה" };

test("parseMe reads the /api/auth/me body", () => {
  assert.deepEqual(parseMe({ success: true, user: { id: 7, email: "owner@example.test", name: "x", businessId: 93, businessName: " עסק בדיקה " } }), me);
});
test("parseMe: a blank business name becomes null", () => {
  assert.equal(parseMe({ user: { id: 7, email: "a@example.test", businessId: 93, businessName: "  " } })?.businessName, null);
});
test("parseMe refuses malformed or unauthorized answers", () => {
  for (const body of [null, "x", {}, { error: "Unauthorized" }, { user: { id: "7", email: "a@example.test", businessId: 93 } },
    { user: { id: 7, email: "", businessId: 93 } }, { user: { id: 7, email: "a@example.test", businessId: 9.5 } }]) {
    assert.equal(parseMe(body), null);
  }
});
test("signedInLine names the account and the business", () => {
  assert.equal(signedInLine(me), "מחובר/ת כ־owner@example.test · עסק בדיקה (עסק #93)");
  assert.equal(signedInLine({ ...me, businessName: null }), "מחובר/ת כ־owner@example.test · עסק #93");
});
test("sessionSwitched: any change of the browser token stops the tab", () => {
  assert.equal(sessionSwitched("a", "a"), false);
  assert.equal(sessionSwitched("a", "b"), true);
  assert.equal(sessionSwitched("a", null), true);
  assert.equal(sessionSwitched(null, "b"), true);
  assert.equal(sessionSwitched(null, null), false);
});
test("identityChanged: another account or another business", () => {
  assert.equal(identityChanged(me, { ...me }), false);
  assert.equal(identityChanged(me, { ...me, userId: 8 }), true);
  assert.equal(identityChanged(me, { ...me, businessId: 94 }), true);
  assert.equal(identityChanged(me, null), true);
  assert.equal(identityChanged(null, null), false);
});

console.log(`signed-in-as: ${passed} passed`);
