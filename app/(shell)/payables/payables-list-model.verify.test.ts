/**
 * Payables list model proof (`npm run verify:payables-list`).
 *
 * The audited Prod business (21.10.2026): the cost engine says 3,545 ₪ are
 * overdue across three recorded due dates (15 + 3,500 + 30). The list must put
 * exactly those three under "המועד עבר" — including the partly paid one whose
 * server state is PARTIALLY_PAID — and nothing else.
 */

import type { CommitmentListApi } from "@/lib/payables/payables-client";
import { filterCounts, groupOf, groupRows, matchesQuery, nextDuePassed } from "./payables-list-model";

let failures = 0;
let checks = 0;
function check(ok: boolean, label: string, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function row(id: number, title: string, kind: CommitmentListApi["scheduleKind"], next: CommitmentListApi["next"], attention: CommitmentListApi["attention"]): CommitmentListApi {
  return {
    id,
    title,
    payeeId: null,
    payeeNameSnapshot: title,
    currency: "ILS",
    scheduleKind: kind,
    status: "ACTIVE",
    total: kind === "RECURRING" ? null : next?.scheduled ?? null,
    paid: "0.00",
    remaining: kind === "RECURRING" ? null : next?.remaining ?? null,
    installmentCount: 1,
    next,
    attention,
    isLegacy: true,
  };
}

const now = new Date("2026-10-21T09:00:00+03:00");
const golanA = row(5, "גולן טלקום", "RECURRING", { id: 11, sequence: 1, dueAt: "2026-09-10T06:00:00.000Z", scheduled: "35.00", remaining: "15.00", state: "PARTIALLY_PAID" }, "PARTIALLY_PAID");
const dira = row(6, "דירה", "ONE_OFF", { id: 12, sequence: 1, dueAt: "2026-09-15T00:00:00.000Z", scheduled: "3500.00", remaining: "3500.00", state: "OVERDUE" }, "OVERDUE");
const golanB = row(7, "גולן טלקום", "RECURRING", { id: 13, sequence: 1, dueAt: "2026-09-15T00:00:00.000Z", scheduled: "30.00", remaining: "30.00", state: "OVERDUE" }, "OVERDUE");
const bituach = row(8, "ביטוח לאומי", "ONE_OFF", { id: 14, sequence: 1, dueAt: "2026-12-29T00:00:00.000Z", scheduled: "50.00", remaining: "50.00", state: "SCHEDULED" }, "SCHEDULED");
const rows = [golanA, dira, golanB, bituach];

check(nextDuePassed(golanA, now), "partly paid with a passed date is 'המועד עבר'");
check(groupOf(golanA, now) === "PASSED", "partly paid + passed date → PASSED group, not 'upcoming'");
check(groupOf(bituach, now) === "PLANNED", "future scheduled → PLANNED");
const groups = groupRows(rows, now);
check(groups.map((g) => `${g.key}:${g.rows.length}`).join(",") === "PASSED:3,PLANNED:1", "Prod groups", groups.map((g) => `${g.key}:${g.rows.length}`).join(","));
const passedRemaining = groups[0].rows.map((r) => r.next!.remaining).sort().join("+");
check(passedRemaining === "15.00+30.00+3500.00", "the three passed rows are exactly the cost engine's overdue items (15 + 3,500 + 30)", passedRemaining);
const counts = filterCounts(rows, now);
check(counts.open === 4 && counts.passed === 3 && counts.recurring === 2 && counts.oneoff === 2 && counts.plan === 0, "filter counts", JSON.stringify(counts));
check(matchesQuery(dira, "דיר") && !matchesQuery(dira, "גולן"), "search by title");
check(matchesQuery(golanB, "  גולן "), "search trims");

// Due today is not "passed" (Israel calendar day, whatever the stored hour).
const today = row(9, "ארנונה", "ONE_OFF", { id: 15, sequence: 1, dueAt: "2026-10-21T00:00:00.000Z", scheduled: "100.00", remaining: "100.00", state: "OVERDUE" }, "OVERDUE");
check(!nextDuePassed(today, now), "a due-today installment is not 'המועד עבר' even when the server already says OVERDUE (L2)");
check(groupOf(today, now) === "DUE", "due today → 'לתשלום בקרוב'");

// Paid / cancelled never counts as passed.
const paid = row(10, "חשמל", "ONE_OFF", { id: 16, sequence: 1, dueAt: "2026-09-01T00:00:00.000Z", scheduled: "80.00", remaining: "0.00", state: "PAID" }, "PAID");
check(!nextDuePassed(paid, now) && groupOf(paid, now) === "DONE", "paid → DONE");
const noNext = { ...paid, id: 11, next: null };
check(groupOf(noNext, now) === "DONE", "no next installment → DONE");

if (failures > 0) {
  console.error(`payables-list: ${failures}/${checks} checks failed`);
  process.exit(1);
}
console.log(`payables-list: ${checks} checks passed`);
