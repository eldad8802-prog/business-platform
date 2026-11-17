import assert from "node:assert/strict";
import { completionOutcome, shouldOfferCompletion } from "./completion-prompt";

let n = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };

ok(shouldOfferCompletion({ enabled: true, locked: false, dismissed: false }), "offered: enabled, unconfirmed, not dismissed");
ok(!shouldOfferCompletion({ enabled: false, locked: false, dismissed: false }), "flag off: never offered");
ok(!shouldOfferCompletion({ enabled: true, locked: true, dismissed: false }), "already confirmed: not offered");
ok(!shouldOfferCompletion({ enabled: true, locked: false, dismissed: true }), "dismissed: not offered");

ok(completionOutcome("CONFIRMED").done && completionOutcome("ALREADY_CONFIRMED").done, "confirmed results are done");
for (const r of ["INCOMPLETE", "INVALID_TAX_ID", "LEGAL_NAME_TOO_LONG", "NOT_ALLOWED", undefined, "X", 42]) {
  const o = completionOutcome(r);
  ok(!o.done && o.message.length > 0, `not done + a message for ${String(r)}`);
}
ok(completionOutcome("INVALID_TAX_ID").message.includes("לתקן"), "invalid number tells how to fix");
ok(!/\d{5,}/.test(Object.values(["CONFIRMED","INCOMPLETE","INVALID_TAX_ID","LEGAL_NAME_TOO_LONG","NOT_ALLOWED"]).map((r) => completionOutcome(r).message).join(" ")), "messages never carry a number");

console.log(`ok - completion prompt (${n} checks)`);
