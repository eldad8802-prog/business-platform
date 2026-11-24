/** Service Desk UI 1.3 — activation and case-panel models. Pure: `npx tsx features/service-desk/case-extras-model.test.ts`. */
import { canSave, chooseProfile as choose, initialSetup as init, toggleTrack, tracksOfProfile as tracksOf } from "./setup-model";
import { partialFailureReason } from "./service-desk-errors";
import { ServiceDeskApiError } from "./service-desk-client";
const CAT = { general: ["T1", "T3", "T5", "T6", "T7"], device_lab: ["T1", "T7", "T3", "T6"], garage: ["T2", "T7", "T3"] };
const initialSetup = (c: { key: string; offeredTracks: string[] | null }) => init({ ...c, catalog: CAT });
const chooseProfile = (d: Parameters<typeof choose>[1], k: Parameters<typeof choose>[2]) => choose(CAT, d, k);
const tracksOfProfile = (k: Parameters<typeof tracksOf>[1]) => tracksOf(CAT, k);
import { chargeSummary, loanReminder, offerableQuoteDocs, parseShekels, pickupSummary, qaBody, qaPassBlocker, qaProgress, quoteMode } from "./case-extras-model";

let passed = 0, failed = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) passed++; else { failed++; console.log(`  [FAIL] ${n}${d ? " — " + d : ""}`); } };
const NOW = new Date("2026-11-19T12:00:00.000Z");

ok("S1 the category's profile is pre-selected with its tracks (defaults first)", (() => {
  const d = initialSetup({ key: "device_lab", offeredTracks: null });
  return d.key === "device_lab" && d.tracks.join(",") === tracksOfProfile("device_lab").join(",") && d.tracks[0] === "T1" && !d.edited; })());
ok("S2 a stored list wins over the profile's", initialSetup({ key: "device_lab", offeredTracks: ["T5", "T1"] }).tracks.join(",") === "T5,T1");
ok("S3 an unknown key falls back to general", initialSetup({ key: "x", offeredTracks: null }).key === "general");
ok("S4 another profile replaces the list until the owner edits it", (() => {
  const a = chooseProfile(initialSetup({ key: "device_lab", offeredTracks: null }), "garage");
  const b = chooseProfile(toggleTrack(initialSetup({ key: "device_lab", offeredTracks: null }), "T5"), "garage");
  return a.tracks.join(",") === tracksOfProfile("garage").join(",") && b.tracks.includes("T5") && b.key === "garage"; })());
ok("S5 toggling keeps catalog order; an empty list cannot be saved", (() => {
  let d = initialSetup({ key: "general", offeredTracks: ["T1"] });
  d = toggleTrack(d, "T6"); d = toggleTrack(d, "T3");
  const order = d.tracks.join(",") === "T1,T3,T6";
  const empty = toggleTrack(initialSetup({ key: "general", offeredTracks: ["T1"] }), "T1");
  return order && !canSave(empty) && canSave(d); })());

const items = [{ key: "a", label: "A", required: false }, { key: "b", label: "B", required: false }, { key: "c", label: "C", required: true }];
ok("Q1 a built-in checklist needs every check recorded, and (owner 2026-11-21) none FAILED", !qaProgress(items, { a: "PASS", b: "FAIL", c: "PASS" }, true).complete
  && qaProgress(items, { a: "PASS", b: "PASS", c: "PASS" }, true).complete && qaProgress(items, { a: "PASS", b: "FAIL", c: "PASS" }, true).missing === 0
  &&!qaProgress(items, { a: "PASS", c: "PASS" }, true).complete && qaProgress(items, { a: "PASS", c: "PASS" }, true).missing === 1);
ok("Q2 a required check that fails keeps it open", !qaProgress(items, { a: "PASS", b: "PASS", c: "FAIL" }, false).complete && qaProgress(items, { c: "PASS" }, false).complete);
ok("Q3 only known keys with PASS/FAIL are sent", JSON.stringify(qaBody(items, { a: "PASS", z: "PASS", b: "x" as never })) === JSON.stringify({ a: "PASS" }));

ok("P1 pickup summary names the count and the last call", pickupSummary([{ calledAt: "2026-11-17T09:00:00Z", outcome: "NO_ANSWER" }, { calledAt: "2026-11-18T09:00:00Z", outcome: "LEFT_MESSAGE" }], NOW) === "2 תזכורות · אחרונה אתמול: השארנו הודעה"
  && pickupSummary([], NOW) === null);

ok("L1 an open loan is a reminder at handover only — never on other statuses", loanReminder([{ id: 1, itemName: "טלפון חלופי", returnedAt: null }], "READY") === "לפני המסירה: לקבל בחזרה את טלפון חלופי"
  && loanReminder([{ id: 1, itemName: "x", returnedAt: null }], "IN_REPAIR") === null && loanReminder([{ id: 1, itemName: "x", returnedAt: "2026-11-18T00:00:00Z" }], "READY") === null);

ok("Q4 quote docs: converted / cancelled / already sent are not offered", offerableQuoteDocs([{ id: 1, status: "ISSUED", converted: false }, { id: 2, status: "DRAFT", converted: true }, { id: 3, status: "CANCELLED", converted: false }, { id: 4, status: "DRAFT", converted: false }], [4]).map((d) => d.id).join(",") === "1");
ok("Q5 quote step: send while diagnosing / repairing, revise while waiting", quoteMode("DIAGNOSING") === "send" && quoteMode("IN_REPAIR") === "send" && quoteMode("QUOTE_PENDING") === "revise" && quoteMode("READY") === null);


// ── Pilot review 2026-11-21 ──
{
  const items = [{ key: "a", label: "נדלק", required: false }, { key: "b", label: "התקלה נפתרה", required: false }];
  const tpl = { items, everyCheckRecorded: true };
  ok("P1 a FAILED check blocks passed and names the check", (qaPassBlocker({ template: tpl, results: { a: "PASS", b: "FAIL" }, completed: false }) ?? "").includes("התקלה נפתרה"));
  ok("P2 a check not recorded (built-in: every check) blocks and is named", (qaPassBlocker({ template: tpl, results: { a: "PASS" }, completed: false }) ?? "").includes("התקלה נפתרה"));
  ok("P3 every check PASS and saved: nothing blocks", qaPassBlocker({ template: tpl, results: { a: "PASS", b: "PASS" }, completed: true }) === null);
  ok("P4 unsaved changes in the panel block (PASS_QA reads only what was saved)", qaPassBlocker({ template: tpl, results: { a: "PASS", b: "PASS" }, completed: true }, { a: "PASS", b: "FAIL" }) !== null);
  const opt = { items: [{ key: "r", label: "חובה", required: true }, { key: "o", label: "רשות", required: false }], everyCheckRecorded: false };
  ok("P5 a business list: an optional check left out does not block", qaPassBlocker({ template: opt, results: { r: "PASS" }, completed: true }) === null);
  ok("P6 but an optional check recorded as FAILED does", qaPassBlocker({ template: opt, results: { r: "PASS", o: "FAIL" }, completed: false }) !== null);
  ok("P7 qaProgress: complete only with no failed check", qaProgress(items, { a: "PASS", b: "FAIL" }, true).complete === false && qaProgress(items, { a: "PASS", b: "PASS" }, true).complete === true);
}
ok("P8 balance UNKNOWN blocks the handover (never bypassed); a failed read blocks too", chargeSummary({ state: "UNKNOWN", openBalanceAgorot: null, reason: "NO_CHARGE_DECISION" }).blocksHandover && chargeSummary(null).blocksHandover);
ok("P8b a service call speaks of closing, never of a handover (UX review 2026-11-23)",
  chargeSummary({ state: "UNKNOWN", openBalanceAgorot: null, reason: "NO_CHARGE_DECISION" }, { field: true }).text.includes("לפני הסגירה")
  && !chargeSummary({ state: "UNKNOWN", openBalanceAgorot: null, reason: "NO_CHARGE_DECISION" }, { field: true }).text.includes("מסירה")
  && chargeSummary({ state: "UNKNOWN", openBalanceAgorot: null, reason: "NO_CHARGE_DECISION" }).text.includes("לפני המסירה"));
ok("P9 NO_CHARGE / SETTLED hand over freely; OPEN / not documented ask for the owner's reason",
  !chargeSummary({ state: "NO_CHARGE", openBalanceAgorot: 0 }).blocksHandover && !chargeSummary({ state: "SETTLED", openBalanceAgorot: 0 }).needsDebtReason
  && chargeSummary({ state: "OPEN", openBalanceAgorot: 5000 }).needsDebtReason && chargeSummary({ state: "CHARGE_NOT_DOCUMENTED", openBalanceAgorot: 5000, detail: { chargeAgorot: 5000, overpaidAgorot: 0 } }).needsDebtReason
  && !chargeSummary({ state: "OPEN", openBalanceAgorot: 5000 }).blocksHandover);
ok("P10 shekels to agorot: positive, at most 2 decimals; anything else refused", parseShekels("350") === 35000 && parseShekels("12.5") === 1250 && parseShekels("₪1,200") === 120000
  && parseShekels("0") === null && parseShekels("-3") === null && parseShekels("1.234") === null && parseShekels("abc") === null);
ok("P11 a quote document already on another case is not offered again", offerableQuoteDocs([{ id: 1, status: "DRAFT", converted: false }, { id: 2, status: "DRAFT", converted: false }], [], [2]).map((d) => d.id).join(",") === "1");

// ── a partial save never says «nothing was saved» (UX review 2026-11-24) ──
{
  const e500 = new ServiceDeskApiError(500, null);
  ok("PF1 after a partial save the reason drops «לא נשמר דבר»", partialFailureReason(e500) === "שגיאה בשרת. נסה שוב." && !partialFailureReason(e500).includes("לא נשמר"));
}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
