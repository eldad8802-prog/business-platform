/**
 * Verify — the browser-side helpers of "מעבר לעוסק מורשה" (lib/legal-identity/kind-transition-client.ts): the date
 * state (today / early / future / invalid in Israel time), display dates, the id number hint, the Google return
 * reason, the draft kept across the Google round-trip (no secret, expires), and the confirm outcome mapping.
 * Run: npx tsx lib/legal-identity/kind-transition-client.test.ts
 *
 * Pure: no DOM, no network.
 */
import assert from "node:assert/strict";

import {
  confirmOutcome, dateState, decodeDraft, displayDate, displayInstant, encodeDraft, GOOGLE_RETURN_MESSAGES, googleReturnOf,
  israelTodayClient, kindLabelHe, sameTaxId, startedBeforeConfirmation,
} from "@/lib/legal-identity/kind-transition-client";

let checks = 0;
function check(label: string, fn: () => void) {
  try { fn(); checks += 1; } catch (e) { console.error(`FAIL ${label}`); throw e; }
}

const TODAY = "2026-11-21";

check("C1 date state: empty / today / early / future / invalid (malformed, impossible, pre-2000)", () => {
  assert.equal(dateState("", TODAY), "empty");
  assert.equal(dateState(TODAY, TODAY), "today");
  assert.equal(dateState("2026-11-01", TODAY), "early");
  assert.equal(dateState("2026-11-22", TODAY), "future");
  for (const d of ["2026-02-30", "21/11/2026", "1999-12-31", "abc", "2026-13-01"]) assert.equal(dateState(d, TODAY), "invalid", d);
});

check("C2 Israel today: 22:30 UTC is already the next day in Israel", () => {
  assert.equal(israelTodayClient(new Date("2026-11-20T22:30:00Z")), "2026-11-21");
  assert.equal(israelTodayClient(new Date("2026-11-20T10:00:00Z")), "2026-11-20");
});

check("C3 display dates (dd.mm.yyyy); an instant shows its Israel day", () => {
  assert.equal(displayDate("2026-11-01"), "01.11.2026");
  assert.equal(displayDate(""), "");
  assert.equal(displayInstant("2026-11-20T22:30:00.000Z"), "21.11.2026");
  assert.equal(displayInstant("not a date"), "");
});

check("C4 started before the confirmation day (Israel time)", () => {
  assert.equal(startedBeforeConfirmation("2026-11-01", "2026-11-21T08:00:00Z"), true);
  assert.equal(startedBeforeConfirmation("2026-11-21", "2026-11-20T22:30:00Z"), false);
});

check("C5 id number hint: separators and a dropped leading zero match; another number does not", () => {
  assert.equal(sameTaxId("12345678-2", "123456782"), true);
  assert.equal(sameTaxId("31415926", "031415926"), true);
  assert.equal(sameTaxId("123456789", "123456782"), false);
  assert.equal(sameTaxId("", "123456782"), false);
  assert.equal(sameTaxId("1234", "000001234"), false, "too short to be an id number");
});

check("C6 Google return reason from the query; anything else is a normal visit", () => {
  for (const r of ["ok", "cancelled", "error", "stale", "other_account"] as const) assert.equal(googleReturnOf(`?reauth=${r}`), r);
  assert.equal(googleReturnOf(""), null);
  assert.equal(googleReturnOf("?reauth=granted"), null);
  for (const k of ["cancelled", "error", "stale", "other_account"] as const) assert.match(GOOGLE_RETURN_MESSAGES[k], /[א-ת]/);
});

check("C7 the draft keeps only the date and the id digits, expires after 15 minutes, rejects garbage", () => {
  const now = Date.parse("2026-11-21T10:00:00Z");
  const raw = encodeDraft({ date: "2026-11-01", taxInput: "12345678-2" }, now);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["date", "savedAt", "taxInput"]);
  assert.deepEqual(decodeDraft(raw, now + 60_000), { date: "2026-11-01", taxInput: "123456782", savedAt: now });
  assert.equal(decodeDraft(raw, now + 16 * 60_000), null);
  for (const bad of [null, "", "{", "[]", JSON.stringify({ date: 1, taxInput: "x", savedAt: now })]) assert.equal(decodeDraft(bad as string | null, now), null);
});

check("C8 confirm outcome: 200 success; 401 re-verify; stale restart; 429 / 5xx / network → nothing changed", () => {
  assert.deepEqual(confirmOutcome(200, "TRANSITIONED", undefined), { kind: "success" });
  assert.equal(confirmOutcome(401, "REAUTH_REQUIRED", undefined).kind, "reverify");
  assert.equal(confirmOutcome(409, "STATEMENT_STALE", "x").kind, "restart");
  for (const [st, code] of [[429, "RATE_LIMITED"], [500, "SERVER_ERROR"], [0, undefined]] as const) {
    const o = confirmOutcome(st, code, undefined);
    assert.equal(o.kind, "error");
    if (o.kind === "error") assert.match(o.message, /לא|יותר מדי/);
  }
  const blocked = confirmOutcome(409, "ISSUER_DECLARATION_ACTIVE", "server message");
  assert.ok(blocked.kind === "error" && blocked.message === "server message");
});

check("C9 kind labels", () => {
  assert.equal(kindLabelHe("EXEMPT_DEALER"), "עוסק פטור");
  assert.equal(kindLabelHe("AUTHORIZED_DEALER"), "עוסק מורשה");
  assert.equal(kindLabelHe(null), "");
});

console.log(`kind-transition-client: ${checks} checks passed`);
