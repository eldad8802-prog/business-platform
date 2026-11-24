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
  confirmableCount, creditStateHe, displayAmount, DOCUMENT_TYPE_HE, interimChangedMessage, interimNone, interimQuery, interimSentence, mergePages,
  type InterimItem,
} from "@/lib/legal-identity/kind-transition-interim-client";

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


// ── 4a T4: the interim documents ──────────────────────────────────────────────────────────────────
check("T1 confirmOutcome: 409 INTERIM_DOCUMENTS_CHANGED with a count → interimChanged; without a valid count → a plain error", () => {
  assert.deepEqual(confirmOutcome(409, "INTERIM_DOCUMENTS_CHANGED", "INTERIM_DOCUMENTS_CHANGED", { count: 4 }), { kind: "interimChanged", count: 4 });
  assert.deepEqual(confirmOutcome(409, "INTERIM_DOCUMENTS_CHANGED", "x", { count: 0 }), { kind: "interimChanged", count: 0 });
  for (const bad of [undefined, -1, 1.5, "4"]) assert.equal(confirmOutcome(409, "INTERIM_DOCUMENTS_CHANGED", "x", { count: bad }).kind, "error");
  assert.equal(confirmOutcome(200, undefined, undefined, { count: 4 }).kind, "success");
});
check("T2 the owner-approved sentence (N ≥ 2 word for word), the singular for N = 1, nothing to check for N = 0", () => {
  assert.equal(interimSentence(3, "15.01.2026"), "מאז 15.01.2026 הופקו 3 מסמכים כעוסק פטור. המסמכים יישארו ללא שינוי. מומלץ לבדוק אותם עם רואה החשבון שלך.");
  assert.equal(interimSentence(1, "15.01.2026"), "מאז 15.01.2026 הופק מסמך אחד כעוסק פטור. המסמך יישאר ללא שינוי. מומלץ לבדוק אותו עם רואה החשבון שלך.");
  assert.equal(interimNone("15.01.2026"), "מאז 15.01.2026 לא הופקו מסמכים כעוסק פטור.");
  assert.ok(interimChangedMessage(5, "15.01.2026").includes("הופקו 5 מסמכים") && interimChangedMessage(5, "15.01.2026").includes("שום דבר לא השתנה"));
  assert.ok(interimChangedMessage(1, "15.01.2026").includes("הופק מסמך אחד"));
});
check("T3 the query: from only when given (the success screen asks without it), list=1, the cursor encoded", () => {
  assert.equal(interimQuery({ from: "2026-01-15" }), "?from=2026-01-15");
  assert.equal(interimQuery({ from: null }), "");
  assert.equal(interimQuery({ from: null, list: true, cursor: "2026-01-20T08:00:00.000Z_31" }), "?list=1&cursor=2026-01-20T08%3A00%3A00.000Z_31");
});
check("T4 the count sent with the confirmation: whole and not negative only", () => {
  assert.equal(confirmableCount(0), 0);
  assert.equal(confirmableCount(12), 12);
  for (const bad of [-1, 1.5, "3", null, undefined, Number.NaN, 10_000_001]) assert.equal(confirmableCount(bad), null);
});
check("T5 list rows: type names, credit state, amounts, pages merged without duplicates", () => {
  assert.equal(DOCUMENT_TYPE_HE.CREDIT_NOTE, "חשבונית זיכוי");
  assert.equal(creditStateHe("NONE"), null);
  assert.equal(creditStateHe("FULL"), "זוכתה במלואה");
  assert.equal(displayAmount("1234.5", "ILS"), `${new Intl.NumberFormat("he-IL", { minimumFractionDigits: 2 }).format(1234.5)} ₪`);
  assert.ok(displayAmount("10", "USD").endsWith(" USD"));
  const it = (id: number) => ({ id } as InterimItem);
  assert.deepEqual(mergePages([it(1), it(2)], [it(2), it(3)]).map((x) => x.id), [1, 2, 3]);
});

console.log(`kind-transition-client: ${checks} checks passed`);
