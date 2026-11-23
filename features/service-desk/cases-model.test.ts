/**
 * Service Desk UI 1.3 — cases list / case screen view model. Pure: run with `npx tsx features/service-desk/cases-model.test.ts`.
 */
import {
  attentionReason, buildListSections, nextStepHint, caseNoun, caseSections, eventLabel, historyItems, isClosed, matchesQuery,
  actorText, journaledLoanIds, telHref, mergedHistory, nextActionLabel, rowDescription, statusLabel, statusTone, type CaseRowData,
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
ok("L2 tones: ready / done / attention / active / new / danger", statusTone("READY") === "ready" && statusTone("WORK_DONE") === "ready" && statusTone("CLOSED") === "done"
  && statusTone("DELIVERED") === "done" && statusTone("QUOTE_PENDING") === "attention" && statusTone("IN_REPAIR", "PARTS") === "attention"
  && statusTone("DIAGNOSING") === "active" && statusTone("QA") === "active" && statusTone("OPEN") === "new" && statusTone("CHECKED_IN") === "new"
  && statusTone("CANCELLED") === "danger" && statusTone("ABANDONED") === "danger");
ok("L3 a service call is a קריאה, a repair at the business a תיק", caseNoun("FIELD") === "קריאה" && caseNoun("REMOTE") === "קריאה" && caseNoun("IN_SHOP") === "תיק");
ok("L4 closed statuses", isClosed("DELIVERED") && isClosed("CANCELLED") && !isClosed("READY") && !isClosed("WORK_DONE"));

// ── attention: explained, never a score ──
// «ממתינים לך» (owner decision 2026-11-24): the next step is ours and overdue, or a finished call to close.
ok("A1 ready and not picked up for 3 days says so, with what to do", attentionReason(row({ status: "READY", updatedAt: daysAgo(3) }), NOW) === "מוכן ולא נאסף · 3 ימים — להתקשר ללקוח");
ok("A2 READY waits from 2 days on; a fresh one does not", attentionReason(row({ status: "READY", updatedAt: daysAgo(0) }), NOW) === null
  && attentionReason(row({ status: "READY", updatedAt: daysAgo(1) }), NOW) === null && attentionReason(row({ status: "READY", updatedAt: daysAgo(2) }), NOW) !== null);
ok("A3 a pending quote waits from 3 days on", attentionReason(row({ status: "QUOTE_PENDING", updatedAt: daysAgo(2) }), NOW) === null
  && (attentionReason(row({ status: "QUOTE_PENDING", updatedAt: daysAgo(3) }), NOW) ?? "").includes("3 ימים"));
ok("A4 OPEN waits from a day on: a field call is not coordinated, a repair not taken in",
  attentionReason(row({ status: "OPEN", kind: "FIELD", updatedAt: daysAgo(0) }), NOW) === null && attentionReason(row({ status: "OPEN", updatedAt: daysAgo(0) }), NOW) === null
  && attentionReason(row({ status: "OPEN", kind: "FIELD", updatedAt: daysAgo(1) }), NOW) === "לא תואם · מאתמול" && attentionReason(row({ status: "OPEN", updatedAt: daysAgo(1) }), NOW) === "לא נקלט · מאתמול");
ok("A7 the days count from entering the state (statusSince), not from the last update",
  attentionReason(row({ status: "READY", updatedAt: daysAgo(0), statusSince: daysAgo(3) }), NOW) !== null
  && attentionReason(row({ status: "READY", updatedAt: daysAgo(5), statusSince: daysAgo(0) }), NOW) === null);
ok("A8 thresholds: WORK_DONE at once, EXTERNAL from 7, QA from 1, a hold from 3",
  attentionReason(row({ status: "WORK_DONE", kind: "FIELD", updatedAt: daysAgo(0) }), NOW) !== null
  && attentionReason(row({ status: "EXTERNAL", updatedAt: daysAgo(6) }), NOW) === null && attentionReason(row({ status: "EXTERNAL", updatedAt: daysAgo(7) }), NOW) !== null
  && attentionReason(row({ status: "QA", updatedAt: daysAgo(0) }), NOW) === null && attentionReason(row({ status: "QA", updatedAt: daysAgo(1) }), NOW) !== null
  && attentionReason(row({ holdReason: "PARTS", updatedAt: daysAgo(2) }), NOW) === null && attentionReason(row({ holdReason: "PARTS", updatedAt: daysAgo(3) }), NOW) !== null);
ok("A9 every active case not waiting has a next-step line; closed ones have none",
  nextStepHint(row({ status: "OPEN" })) === "הבא: לקלוט את הפריט" && nextStepHint(row({ status: "OPEN", kind: "REMOTE" })) === "הבא: לתאם ולהתחיל"
  && nextStepHint(row({ status: "IN_REPAIR", holdReason: "PARTS" })) === "הבא: להחזיר לעבודה" && nextStepHint(row({ status: "DELIVERED" })) === null);
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
ok("S3 'all': «ממתינים לך» first (only the overdue READY), the rest by update, closed hidden", all.attention.map((a) => a.row.id).join(",") === "1"
  && all.rest.map((r) => r.id).join(",") === "5,2,3" && all.shown === 4 && all.total === 5, JSON.stringify([all.attention.map((a) => a.row.id), all.rest.map((r) => r.id)]));
{
  const w = buildListSections([
    row({ id: 7, caseNumber: 7, status: "READY", statusSince: daysAgo(3) }),
    row({ id: 8, caseNumber: 8, status: "QUOTE_PENDING", statusSince: daysAgo(4) }),
    row({ id: 9, caseNumber: 9, status: "WORK_DONE", kind: "FIELD", statusSince: daysAgo(0) }),
    row({ id: 6, caseNumber: 6, status: "READY", statusSince: daysAgo(3) }),
  ], { filter: "all", query: "", now: NOW });
  ok("S9 «ממתינים לך» order: longest wait first, a tie by case number", w.attention.map((a) => a.row.id).join(",") === "8,6,7,9", JSON.stringify(w.attention.map((a) => a.row.id)));
}
ok("S4 'closed' shows only closed", buildListSections(rows, { filter: "closed", query: "", now: NOW }).rest.map((r) => r.id).join(",") === "4");
ok("S5 a search also finds closed cases", buildListSections(rows, { filter: "all", query: "רון", now: NOW }).rest.map((r) => r.id).join(",") === "4");
ok("S6 'ready' and 'active'", buildListSections(rows, { filter: "ready", query: "", now: NOW }).rest.map((r) => r.id).join(",") === "1"
  && buildListSections(rows, { filter: "active", query: "", now: NOW }).rest.map((r) => r.id).sort().join(",") === "2,3,5");
ok("S7 'attention' shows only cases with a reason", buildListSections(rows, { filter: "attention", query: "", now: NOW }).rest.length === 0
  && buildListSections(rows, { filter: "attention", query: "", now: NOW }).attention.length === 1);
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

// ── Pilot review 2026-11-21 ──
{
  const N = new Date("2026-11-21T12:00:00.000Z");
  const row = (p: Partial<CaseRowData>): CaseRowData => ({ id: 1, caseNumber: 1, kind: "IN_SHOP", status: "OPEN", holdReason: null, customerName: "x", openedAt: N.toISOString(), updatedAt: N.toISOString(), ...p });
  const dayAgo = new Date(N.getTime() - 24 * 60 * 60 * 1000).toISOString();
  ok("H1 a case waiting a day for diagnosis (CHECKED_IN) is in «ממתינים לך» with its reason", (attentionReason(row({ status: "CHECKED_IN", statusSince: dayAgo }), N) ?? "").startsWith("ממתין לאבחון")
    && buildListSections([row({ status: "CHECKED_IN", statusSince: dayAgo })], { filter: "attention", query: "", now: N }).attention.length === 1);
  ok("H2 a REMOTE call waiting at OPEN is coordinated, never take-the-item-in", attentionReason(row({ kind: "REMOTE", statusSince: dayAgo }), N) === "לא תואם · מאתמול");
  ok("H3 a recorded intake: the next step is its confirmation, not the intake again", nextActionLabel("OPEN", "IN_SHOP", null, { intakeReady: true }) === "לאשר את הקליטה"
    && nextActionLabel("OPEN", "IN_SHOP") === "לקלוט את הפריט");
  ok("H4 READY with no charge: the next step names the charge first", (nextActionLabel("READY", "IN_SHOP", null, { chargeMissing: true }) ?? "").includes("חיוב"));
  ok("H5 QA with a failed check: the next step is back to work", (nextActionLabel("QA", "IN_SHOP", null, { qaFailed: true }) ?? "").includes("להחזיר לעבודה"));
  ok("H6 history details only from the stored payload: QA counts, open balance, charge, quote answer",
    eventLabel({ eventType: "qa.recorded", toStatus: "QA", payload: { passed: 4, failed: 1 } }).includes("1 לא עברו")
    && eventLabel({ eventType: "case.delivered", toStatus: "DELIVERED", payload: { debtOverride: true } }).includes("יתרה פתוחה")
    && eventLabel({ eventType: "case.delivered", toStatus: "DELIVERED", payload: {} }) === "נמסר ללקוח"
    && eventLabel({ eventType: "charge.recorded", toStatus: "READY", payload: { mode: "NO_CHARGE" } }).includes("ללא חיוב")
    && eventLabel({ eventType: "quote.approved", toStatus: "IN_REPAIR", payload: { method: "PHONE" } }).includes("בטלפון"));
  ok("H7 side records (loans, pickup calls) merge into the history by their stored time, newest first",
    mergedHistory([{ seq: 1, eventType: "case.opened", toStatus: "OPEN", occurredAt: "2026-11-20T10:00:00.000Z", actor: "OWNER_USER" }],
      [{ key: "l", text: "ניתן ציוד חלופי: מטען", occurredAt: "2026-11-21T09:00:00.000Z" }]).map((x) => x.key).join(",") === "l,e1");
}

// ── Migration 20261222090000 (once applied): the light case work in the history ──
ok("J1 work details read from flags and the date token only", eventLabel({ eventType: "case.work_details_recorded", toStatus: "IN_REPAIR", payload: { locationChanged: true, locationSet: true, estimatedChanged: true, estimatedReadyOn: "2026-12-01" } }) === "מיקום הפריט עודכן · סיום משוער: 1.12"
  && eventLabel({ eventType: "case.work_details_recorded", toStatus: "IN_REPAIR", payload: { locationChanged: true, locationSet: false, estimatedChanged: false } }) === "מיקום הפריט נמחק"
  && eventLabel({ eventType: "case.work_details_recorded", toStatus: "IN_REPAIR", payload: { locationChanged: false, estimatedChanged: true, estimatedReadyOn: null } }) === "תאריך הסיום המשוער הוסר");
ok("J2 a loan / task line takes its name from what the screen holds; without it, the plain label", eventLabel({ eventType: "loan.lent", toStatus: "READY", payload: { loanId: 7 } }, { loans: { 7: "מטען" } }) === "ניתן ציוד חלופי: מטען"
  && eventLabel({ eventType: "task.unlinked", toStatus: "READY", payload: { taskId: 3 } }) === "הוסר קישור למשימה");
ok("J3 journaled loans are known, so their side lines are not repeated", [...journaledLoanIds([{ seq: 4, eventType: "loan.lent", toStatus: "READY", occurredAt: "2026-11-22T10:00:00.000Z", actor: "OWNER_USER", payload: { loanId: 7 } }])].join(",") === "7");

// ── who acted (owner decision 2026-11-24) ──
ok("W1 the history names who acted; clear words when the name is not available; system / customer keep their words",
  actorText({ actor: "OWNER_USER", actorUserId: 7, actorName: "שירה כהן", actorKnown: true }) === "שירה כהן"
  && actorText({ actor: "OWNER_USER", actorUserId: 7, actorName: null, actorKnown: true }) === "משתמש ללא שם"
  && actorText({ actor: "OWNER_USER", actorUserId: null, actorName: null, actorKnown: false }) === "משתמש לא מזוהה"
  && actorText({ actor: "SYSTEM", actorUserId: null, actorName: null, actorKnown: false }) === "המערכת"
  && actorText({ actor: "CUSTOMER_LINK" }) === "הלקוח" && actorText({ actor: "OWNER_USER" }) === "בעל העסק");
ok("W2 the merged history carries the name", mergedHistory([{ seq: 1, eventType: "case.opened", toStatus: "OPEN", occurredAt: "2026-11-19T10:00:00.000Z", actor: "OWNER_USER", actorUserId: 3, actorName: "רון לוי", actorKnown: true }], [])[0].actor === "רון לוי");
ok("T1 a call link only for a plausible phone, digits only", telHref("050-123 4567") === "tel:0501234567" && telHref("+972 50 1234567") === "tel:+972501234567" && telHref("12") === null && telHref(null) === null);
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
