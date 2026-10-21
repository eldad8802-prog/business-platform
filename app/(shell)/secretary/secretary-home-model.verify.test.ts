/**
 * Secretary home model proof (`npm run verify:secretary-home`).
 *
 * The audit's Prod case (21.10.2026): three overdue ledger items and one in
 * quiet tracking. The old home said "יש דבר אחד שצריך לסגור היום", summed gross
 * amounts to "3,615 ₪ להוצאה", and showed 35 ₪ for an item with 15 ₪ left.
 * Here the headline follows the server counts, every row leads with the
 * server's remaining amount, and nothing is summed.
 */

import type { BriefingApi, ObligationApi } from "@/lib/obligations/secretary-client";
import { buildSecretaryHome } from "./secretary-home-model";

let failures = 0;
let checks = 0;
function check(ok: boolean, label: string, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function ob(id: number, name: string, amount: string, dueAt: string, recurrence: ObligationApi["recurrence"], ledger: ObligationApi["ledger"]): ObligationApi {
  return {
    id,
    obligeeName: name,
    amount,
    currency: "ILS",
    dueAt,
    state: "OPEN",
    source: "MANUAL",
    recurrence,
    recurrenceSeriesId: null,
    note: null,
    followUpAt: null,
    settlementAssertedBy: null,
    metAt: null,
    releasedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ledger,
  };
}

const golanA = ob(11, "גולן טלקום", "35.00", "2026-09-10T06:00:00.000Z", "MONTHLY", { commitmentId: 5, installmentId: 11, paid: "20.00", remaining: "15.00" });
const dira = ob(12, "דירה", "3500.00", "2026-09-15T00:00:00.000Z", "NONE", { commitmentId: 6, installmentId: 12, paid: "0.00", remaining: "3500.00" });
const golanB = ob(13, "גולן טלקום", "30.00", "2026-09-15T00:00:00.000Z", "MONTHLY", { commitmentId: 7, installmentId: 13, paid: "0.00", remaining: "30.00" });
const bituach = ob(14, "ביטוח לאומי", "50.00", "2026-12-29T00:00:00.000Z", "NONE", { commitmentId: 8, installmentId: 14, paid: "0.00", remaining: "50.00" });

const prod: BriefingApi = {
  state: "CRITICAL",
  oriented: false,
  attention: [
    { obligation: golanA, reason: "OVERDUE" },
    { obligation: dira, reason: "OVERDUE" },
    { obligation: golanB, reason: "OVERDUE" },
  ],
  watching: [bituach],
  counts: { open: 4, attention: 3, breakToday: 3, watching: 1 },
  generatedAt: "2026-10-21T09:00:00.000Z",
};

const home = buildSecretaryHome(prod);
check(home.title === "3 תשלומים עברו את המועד.", "headline counts all three overdue", home.title);
check(!home.title.includes("דבר אחד"), "never 'one thing' beside three overdue rows");
check(home.subtitle.includes("במעקב שקט"), "subtitle mentions the quiet item", home.subtitle);
check(home.counts.overdue === 3 && home.counts.watching === 1 && home.counts.today === 0 && home.counts.soon === 0, "counts are the server's");
check(home.groups.map((g) => g.key).join(",") === "OVERDUE,WATCHING", "groups in order, empty ones dropped", home.groups.map((g) => g.key).join(","));
const rowA = home.groups[0].rows.find((r) => r.obligation.id === 11)!;
check(rowA.amount === "15.00", "partly paid row leads with the server's remaining (15), not the gross 35", rowA.amount);
check(rowA.amountCaption === "נותר", "remaining is labelled as remaining");
check(rowA.progress?.paid === "20.00" && rowA.progress?.total === "35.00", "progress = server paid of scheduled");
check(rowA.canRecordPayment, "ledger row with something left can record a payment");
check(rowA.commitmentId === 5, "row knows its commitment (deep link to payables)");
const rowDira = home.groups[0].rows.find((r) => r.obligation.id === 12)!;
check(rowDira.progress === null, "nothing paid → no progress line");
check(home.ledgerBacked, "ledger-backed items are recognised");
check(!Object.values(home).some((v) => typeof v === "string" && /3,?615/.test(v)), "the gross 3,615 total is gone");

// One overdue → singular.
const one = buildSecretaryHome({ ...prod, attention: [prod.attention[1]], counts: { ...prod.counts, attention: 1, breakToday: 1, open: 2 } });
check(one.title === "תשלום אחד עבר את המועד.", "singular overdue headline", one.title);

// Due today only.
const todayOnly = buildSecretaryHome({ ...prod, attention: [{ obligation: dira, reason: "DUE_TODAY" }], watching: [], counts: { open: 1, attention: 1, breakToday: 1, watching: 0 } });
check(todayOnly.title === "תשלום אחד מחכה להיום.", "today headline", todayOnly.title);

// Calm, not oriented → no global "everything is calm".
const calm = buildSecretaryHome({ ...prod, state: "STILL_SETTLING_IN", attention: [], watching: [bituach], counts: { open: 1, attention: 0, breakToday: 0, watching: 1 } });
check(calm.state === "calm" && !calm.title.includes("רגוע"), "not oriented → calm is scoped, not global", calm.title);
const calmOriented = buildSecretaryHome({ ...prod, state: "CALM", oriented: true, attention: [], watching: [bituach], counts: { open: 1, attention: 0, breakToday: 0, watching: 1 } });
check(calmOriented.title.includes("רגוע"), "oriented → calm may be stated", calmOriented.title);
check(calmOriented.subtitle.includes("שבוע לפני"), "calm subtitle states the real 7-day window, not a notification", calmOriented.subtitle);

// Empty.
const empty = buildSecretaryHome({ ...prod, attention: [], watching: [], counts: { open: 0, attention: 0, breakToday: 0, watching: 0 } });
check(empty.state === "new" && empty.groups.length === 0, "empty → new state");

// Legacy (no ledger): leads with the scheduled amount, no payment path offered.
const legacy = buildSecretaryHome({ ...prod, attention: [{ obligation: { ...dira, ledger: null }, reason: "OVERDUE" }], watching: [], counts: { open: 1, attention: 1, breakToday: 1, watching: 0 } });
const legacyRow = legacy.groups[0].rows[0];
check(legacyRow.amount === "3500.00" && legacyRow.amountCaption === null && !legacyRow.canRecordPayment && !legacy.ledgerBacked, "legacy row: scheduled amount, no payment path");

if (failures > 0) {
  console.error(`secretary-home: ${failures}/${checks} checks failed`);
  process.exit(1);
}
console.log(`secretary-home: ${checks} checks passed`);
