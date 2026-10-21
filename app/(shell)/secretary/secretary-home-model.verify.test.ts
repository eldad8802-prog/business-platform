/**
 * Secretary main-screen model proof (`npm run verify:secretary-home`).
 *
 * The audited Prod case (21.10.2026): three overdue ledger items and one in
 * quiet tracking. Before: "יש דבר אחד שצריך לסגור היום" beside three overdue
 * rows, a client-side gross sum "3,615 ₪ להוצאה", and 35 ₪ shown for an item
 * with 15 ₪ left. Here: the headline follows the server counts, every row
 * leads with the server's remaining amount, and nothing is summed or rounded.
 */

import type { BriefingApi, ObligationApi } from "@/lib/obligations/secretary-client";
import { buildSecretaryHome, dueDays, ownerErrorText, relativeDays } from "./secretary-home-model";

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
check(home.subtitle === "ועוד אחד במעקב שקט. כל השאר שמור אצלי.", "subtitle names the quiet item", home.subtitle);
check(!/אזכיר|תזכורת|התראה/.test(home.title + home.subtitle), "no reminder promise on the main screen");
check(home.counts.overdue === 3 && home.counts.watching === 1 && home.counts.today === 0 && home.counts.soon === 0, "counts are the server's");
check(home.needs.map((g) => g.key).join(",") === "OVERDUE", "only non-empty attention groups");
check(home.needs[0].rows.map((r) => r.obligation.id).join(",") === "11,12,13", "the server's order is kept");
check(home.watching.length === 1 && home.watching[0].status === "WATCHING", "quiet tracking kept apart from what needs action");
const rowA = home.needs[0].rows[0];
check(rowA.amount === "15.00", "partly paid row leads with the server's remaining (15), not the gross 35", rowA.amount);
check(rowA.amountCaption === "נותר", "remaining is labelled as remaining");
check(rowA.progress?.paid === "20.00" && rowA.progress?.total === "35.00", "progress = server paid of scheduled");
check(home.needs[0].rows[1].progress === null, "nothing paid → no progress line");
check(!JSON.stringify(home).match(/3,?615/), "the gross 3,615 total is gone");

// Singular / today / soon headlines.
const one = buildSecretaryHome({ ...prod, attention: [prod.attention[1]], watching: [], counts: { open: 1, attention: 1, breakToday: 1, watching: 0 } });
check(one.title === "תשלום אחד עבר את המועד." && one.subtitle === "כל השאר שמור אצלי.", "singular overdue", one.title + " | " + one.subtitle);
const todayOnly = buildSecretaryHome({ ...prod, attention: [{ obligation: dira, reason: "DUE_TODAY" }], watching: [], counts: { open: 1, attention: 1, breakToday: 1, watching: 0 } });
check(todayOnly.title === "תשלום אחד מחכה להיום.", "today headline", todayOnly.title);
const soon = buildSecretaryHome({ ...prod, attention: [{ obligation: dira, reason: "DUE_SOON" }, { obligation: golanB, reason: "DUE_SOON" }], counts: { open: 3, attention: 2, breakToday: 0, watching: 1 } });
check(soon.title === "2 תשלומים מתקרבים השבוע.", "soon headline", soon.title);

// Calm: global calm only once oriented.
const calm = buildSecretaryHome({ ...prod, state: "STILL_SETTLING_IN", attention: [], watching: [bituach], counts: { open: 1, attention: 0, breakToday: 0, watching: 1 } });
check(calm.state === "calm" && !calm.title.includes("רגוע"), "not oriented → calm is scoped, not global", calm.title);
const calmOriented = buildSecretaryHome({ ...prod, state: "CALM", oriented: true, attention: [], watching: [bituach], counts: { open: 1, attention: 0, breakToday: 0, watching: 1 } });
check(calmOriented.title === "הכול רגוע השבוע." && calmOriented.subtitle.includes("יופיע כאן"), "oriented calm makes no timing promise", calmOriented.subtitle);

// New business.
const empty = buildSecretaryHome({ ...prod, attention: [], watching: [], counts: { open: 0, attention: 0, breakToday: 0, watching: 0 } });
check(empty.state === "new" && empty.needs.length === 0 && empty.watching.length === 0, "empty → new state");

// Legacy (no ledger): the scheduled amount, no remaining caption.
const legacy = buildSecretaryHome({ ...prod, attention: [{ obligation: { ...dira, ledger: null }, reason: "OVERDUE" }], watching: [], counts: { open: 1, attention: 1, breakToday: 1, watching: 0 } });
check(legacy.needs[0].rows[0].amount === "3500.00" && legacy.needs[0].rows[0].amountCaption === null, "legacy row shows the scheduled amount");

// Agorot are never rounded away by the model.
const agorot = buildSecretaryHome({ ...prod, attention: [{ obligation: { ...golanB, amount: "15.50", ledger: { commitmentId: 7, installmentId: 13, paid: "0.00", remaining: "15.50" } }, reason: "OVERDUE" }], watching: [], counts: { open: 1, attention: 1, breakToday: 1, watching: 0 } });
check(agorot.needs[0].rows[0].amount === "15.50", "15.50 stays 15.50");

// Israel calendar days, around Israel midnight.
check(dueDays("2026-09-15T00:00:00.000Z", new Date("2026-10-21T09:00:00+03:00")) === -36, "15.09 is 36 days before 21.10");
check(dueDays("2026-09-10T06:00:00.000Z", new Date("2026-10-21T09:00:00+03:00")) === -41, "10.09 is 41 days before 21.10");
check(dueDays("2026-09-15T00:00:00.000Z", new Date("2026-09-14T21:30:00.000Z")) === 0, "00:30 Israel time on the due day is day 0");
check(dueDays("not a date", new Date()) === null, "invalid date → null");
check(relativeDays(-36) === "לפני 36 ימים" && relativeDays(0) === "היום" && relativeDays(69) === "בעוד 69 ימים", "relative wording");

// Errors: Hebrew passes, English never reaches the owner.
check(ownerErrorText(new Error("שגיאת שרת (500)"), "x") === "שגיאת שרת (500)", "Hebrew server text passes");
check(ownerErrorText(new Error("Validation failed"), "נכשל.") === "נכשל.", "English falls back to Hebrew");

if (failures > 0) {
  console.error(`secretary-home: ${failures}/${checks} checks failed`);
  process.exit(1);
}
console.log(`secretary-home: ${checks} checks passed`);
