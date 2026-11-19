/** Service Desk UI 1.3 — activation and case-panel models. Pure: `npx tsx features/service-desk/case-extras-model.test.ts`. */
import { canSave, chooseProfile, initialSetup, toggleTrack, tracksOfProfile } from "./setup-model";
import { loanReminder, offerableQuoteDocs, pickupSummary, qaBody, qaProgress, quoteMode } from "./case-extras-model";

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
ok("Q1 a built-in checklist needs every check recorded; a FAIL still counts as recorded", qaProgress(items, { a: "PASS", b: "FAIL", c: "PASS" }, true).complete
  && !qaProgress(items, { a: "PASS", c: "PASS" }, true).complete && qaProgress(items, { a: "PASS", c: "PASS" }, true).missing === 1);
ok("Q2 a required check that fails keeps it open", !qaProgress(items, { a: "PASS", b: "PASS", c: "FAIL" }, false).complete && qaProgress(items, { c: "PASS" }, false).complete);
ok("Q3 only known keys with PASS/FAIL are sent", JSON.stringify(qaBody(items, { a: "PASS", z: "PASS", b: "x" as never })) === JSON.stringify({ a: "PASS" }));

ok("P1 pickup summary names the count and the last call", pickupSummary([{ calledAt: "2026-11-17T09:00:00Z", outcome: "NO_ANSWER" }, { calledAt: "2026-11-18T09:00:00Z", outcome: "LEFT_MESSAGE" }], NOW) === "2 תזכורות · אחרונה אתמול: השארנו הודעה"
  && pickupSummary([], NOW) === null);

ok("L1 an open loan is a reminder at handover only — never on other statuses", loanReminder([{ id: 1, itemName: "טלפון חלופי", returnedAt: null }], "READY") === "לפני המסירה: לקבל בחזרה את טלפון חלופי"
  && loanReminder([{ id: 1, itemName: "x", returnedAt: null }], "IN_REPAIR") === null && loanReminder([{ id: 1, itemName: "x", returnedAt: "2026-11-18T00:00:00Z" }], "READY") === null);

ok("Q4 quote docs: converted / cancelled / already sent are not offered", offerableQuoteDocs([{ id: 1, status: "ISSUED", converted: false }, { id: 2, status: "DRAFT", converted: true }, { id: 3, status: "CANCELLED", converted: false }, { id: 4, status: "DRAFT", converted: false }], [4]).map((d) => d.id).join(",") === "1");
ok("Q5 quote step: send while diagnosing / repairing, revise while waiting", quoteMode("DIAGNOSING") === "send" && quoteMode("IN_REPAIR") === "send" && quoteMode("QUOTE_PENDING") === "revise" && quoteMode("READY") === null);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
