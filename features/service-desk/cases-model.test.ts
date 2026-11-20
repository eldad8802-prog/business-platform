/**
 * Service Desk UI 1.3 — cases list / case screen view model. Pure: run with `npx tsx features/service-desk/cases-model.test.ts`.
 */
import {
  attentionReason, buildListSections, caseNoun, caseSections, eventLabel, historyItems, isClosed, matchesQuery,
  nextActionLabel, rowDescription, statusLabel, statusTone, type CaseRowData,
} from "./cases-model";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else { failed++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-11-19T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
const row = (over: Partial<CaseRowData>): CaseRowData => ({
  id: 1, caseNumber: 1001, kind: "IN_SHOP", status: "IN_REPAIR", holdReason: null, customerName: "דנה כהן",
  problemExcerpt: "מסך סדוק", subjectName: "iPhone 13", workType: "REPAIR", openedAt: daysAgo(5), updatedAt: daysAgo(1), ...over,
});

// ── labels and tones ──
ok("L1 every status has a Hebrew label", (["OPEN", "SCHEDULED", "CHECKED_IN", "DIAGNOSING", "QUOTE_PENDING", "IN_REPAIR", "EXTERNAL", "QA", "READY", "DELIVERED", "CLOSED", "CANCELLED", "ABANDONED", "WORK_DONE"] as const)
  .every((s) => /[֐-׿]/.test(statusLabel(s))));
ok("L2 tones: ready / done / attention / active", statusTone("READY") === "ready" && statusTone("WORK_DONE") === "ready" && statusTone("CLOSED") === "done"
  && statusTone("QUOTE_PENDING") === "attention" && statusTone("IN_REPAIR", "PARTS") === "attention" && statusTone("DIAGNOSING") === "active");
ok("L3 a service call is a קריאה, a repair at the business a תיק", caseNoun("FIELD") === "קריאה" && caseNoun("REMOTE") === "קריאה" && caseNoun("IN_SHOP") === "תיק");
ok("L4 closed statuses", isClosed("DELIVERED") && isClosed("CANCELLED") && !isClosed("READY") && !isClosed("WORK_DONE"));

// ── attention: explained, never a score ──
ok("A1 ready and not picked up for 3 days says so", attentionReason(row({ status: "READY", updatedAt: daysAgo(3) }), NOW) === "מוכן ולא נאסף · 3 ימים");
ok("A2 a fresh READY asks to tell the customer", attentionReason(row({ status: "READY", updatedAt: daysAgo(0) }), NOW) === "מוכן — לעדכן את הלקוח");
ok("A3 a pending quote names the wait", (attentionReason(row({ status: "QUOTE_PENDING", updatedAt: daysAgo(2) }), NOW) ?? "").includes("יומיים"));
ok("A4 an OPEN field call asks for a visit; an OPEN repair for the intake",
  attentionReason(row({ status: "OPEN", kind: "FIELD" }), NOW) === "צריך לתאם ביקור" && attentionReason(row({ status: "OPEN" }), NOW) === "צריך לקלוט את הפריט");
ok("A5 a hold names its reason", (attentionReason(row({ holdReason: "PARTS", updatedAt: daysAgo(4) }), NOW) ?? "").startsWith("ממתין לחלקים"));
ok("A6 ordinary work needs nothing", attentionReason(row({ status: "IN_REPAIR" }), NOW) === null && attentionReason(row({ status: "DIAGNOSING" }), NOW) === null);

// ── next action ──
ok("N1 next action follows the activity", nextActionLabel("OPEN", "FIELD") === "לתאם ביקור" && nextActionLabel("OPEN", "IN_SHOP") === "לקלוט את הפריט"
  && nextActionLabel("READY", "IN_SHOP") === "למסור ללקוח" && nextActionLabel("WORK_DONE", "FIELD") === "לסגור את הקריאה");
ok("N3 on hold, the next action is back to work", nextActionLabel("IN_REPAIR", "IN_SHOP", "PARTS") === "כשהחלקים מגיעים — להחזיר לעבודה" && nextActionLabel("IN_REPAIR", "IN_SHOP", null) === "לסיים את התיקון");
ok("N2 a closed case has no next action", nextActionLabel("CLOSED", "IN_SHOP") === null && nextActionLabel("DELIVERED", "IN_SHOP") === null);

// ── search and list sections ──
const rows: CaseRowData[] = [
  row({ id: 1, caseNumber: 1001, status: "READY", updatedAt: daysAgo(3) }),
  row({ id: 2, caseNumber: 1002, status: "IN_REPAIR", customerName: "יוסי לוי", subjectName: "MacBook Air", problemExcerpt: "לא נטען" }),
  row({ id: 3, caseNumber: 1003, status: "QUOTE_PENDING", customerName: "מיכל אברהם", updatedAt: daysAgo(2) }),
  row({ id: 4, caseNumber: 1004, status: "CLOSED", customerName: "רון דוד" }),
  row({ id: 5, caseNumber: 1005, status: "DIAGNOSING", kind: "FIELD", customerName: "משרד גל", subjectName: null, problemExcerpt: "מזגן מטפטף" }),
];
ok("S1 search by number, with or without #", matchesQuery(rows[1], "1002") && matchesQuery(rows[1], "#1002") && !matchesQuery(rows[0], "1002"));
ok("S2 search by customer / subject / problem", matchesQuery(rows[1], "יוסי") && matchesQuery(rows[1], "macbook") && matchesQuery(rows[4], "מזגן"));
const all = buildListSections(rows, { filter: "all", query: "", now: NOW });
ok("S3 'all': attention first with reasons, closed hidden", all.attention.map((a) => a.row.id).join(",") === "3,1"
  && all.rest.map((r) => r.id).join(",") === "5,2" && all.shown === 4 && all.total === 5, JSON.stringify(all.attention.map((a) => a.row.id)));
ok("S4 'closed' shows only closed", buildListSections(rows, { filter: "closed", query: "", now: NOW }).rest.map((r) => r.id).join(",") === "4");
ok("S5 a search also finds closed cases", buildListSections(rows, { filter: "all", query: "רון", now: NOW }).rest.map((r) => r.id).join(",") === "4");
ok("S6 'ready' and 'active'", buildListSections(rows, { filter: "ready", query: "", now: NOW }).rest.map((r) => r.id).join(",") === "1"
  && buildListSections(rows, { filter: "active", query: "", now: NOW }).rest.map((r) => r.id).sort().join(",") === "2,3,5");
ok("S7 'attention' shows only cases with a reason", buildListSections(rows, { filter: "attention", query: "", now: NOW }).rest.length === 0
  && buildListSections(rows, { filter: "attention", query: "", now: NOW }).attention.length === 2);
ok("S8 row description: subject · problem, or a fallback", rowDescription(rows[1]) === "MacBook Air · לא נטען" && rowDescription(rows[4]) === "מזגן מטפטף"
  && rowDescription({ subjectName: null, problemExcerpt: null }) === "ללא תיאור");

// ── case screen ──
const heldSections = caseSections({ kind: "IN_SHOP", status: "READY", intake: { conditionNote: null, accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true } });
ok("C1 a held item shows intake and handover; READY opens the handover", heldSections.map((s) => s.key).join(",") === "details,intake,quote,checks,handover,history"
  && heldSections.find((s) => s.key === "handover")?.open === true && heldSections.find((s) => s.key === "intake")?.open === false);
const fieldSections = caseSections({ kind: "FIELD", status: "QA", intake: null });
ok("C2 a field call has no intake / handover; QA opens the checks", fieldSections.map((s) => s.key).join(",") === "details,quote,checks,history"
  && fieldSections.find((s) => s.key === "checks")?.open === true && fieldSections[0].title === "פרטי העבודה");
ok("C3 history newest first, with Hebrew labels", historyItems([{ seq: 1, eventType: "case.opened", toStatus: "OPEN", occurredAt: daysAgo(3), actor: "OWNER" },
  { seq: 2, eventType: "case.checked_in", toStatus: "CHECKED_IN", occurredAt: daysAgo(2), actor: "OWNER" }]).map((e) => e.seq).join(",") === "2,1"
  && eventLabel({ eventType: "case.checked_in", toStatus: "CHECKED_IN" }) === "הפריט נקלט" && eventLabel({ eventType: "x.unknown", toStatus: "READY" }) === "עדכון בתיק");

ok("E9 a record names what was recorded; an unknown event is a plain update", eventLabel({ eventType: "intake.recorded", toStatus: "OPEN" }) === "פרטי הקליטה נרשמו" && eventLabel({ eventType: "x.y", toStatus: "OPEN" }) === "עדכון בתיק");
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
