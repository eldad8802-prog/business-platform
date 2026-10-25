/**
 * Verify — commitment detail screen model (owner-approved redesign, 25.10.2026).
 * Run: npm run verify:commitment-detail
 *
 * Pure: no database, no network, no clock. Checks the status box never claims
 * a payment is due when none is, picks the SAME installment the server's list
 * calls `next`, orders the schedule, counts cheques exactly, labels every
 * audit event the server can write in Hebrew without losing the original —
 * and that the screen still reaches every action the old screen had.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import type {
  ChequeApi,
  CommitmentDetailApi,
  DerivedState,
  InstallmentApi,
  PaymentApi,
  PreparationApi,
} from "@/lib/payables/payables-client";
import {
  AUDIT_FALLBACK_LABEL,
  AUDIT_LABEL,
  HERO_TITLE,
  SCHEDULE_PREVIEW,
  auditLabel,
  chequeCountLabel,
  chequeCounts,
  heroOf,
  isPartlyPaid,
  openPreparations,
  openPreparationsLabel,
  orderSchedule,
  payableInstallments,
  pickCurrentInstallment,
} from "./commitment-detail-model";

let checks = 0;
function ok(label: string, condition: boolean) {
  assert.ok(condition, label);
  checks += 1;
}
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, `${label} (got ${JSON.stringify(actual)})`);
  checks += 1;
}

const ROOT = path.resolve(__dirname, "../../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* ───────────── fixtures ───────────── */

let nextId = 1;
function inst(p: Partial<InstallmentApi> & { dueAt: string; state: DerivedState }): InstallmentApi {
  const id = p.id ?? nextId++;
  const scheduled = p.scheduled ?? "100.00";
  const paid = p.paid ?? (p.state === "PAID" ? scheduled : "0.00");
  const remaining =
    p.remaining ?? (p.state === "PAID" || p.state === "CANCELLED" || p.state === "SETTLED_LEGACY" ? "0.00" : scheduled);
  return {
    id,
    sequence: p.sequence ?? id,
    dueAt: p.dueAt,
    scheduled,
    paid,
    remaining,
    state: p.state,
    status: p.status ?? (p.state === "CANCELLED" ? "CANCELLED" : p.state === "SETTLED_LEGACY" ? "SETTLED_LEGACY" : "SCHEDULED"),
    legacyAssertedBy: null,
    legacyMetAt: null,
    allocations: [],
  };
}
function payment(paidAt: string, status = "RECORDED"): PaymentApi {
  return { id: nextId++, amount: "100.00", allocated: "100.00", unallocated: "0.00", status, method: "CASH", paidAt, externalReference: null };
}
function detail(p: Partial<CommitmentDetailApi> & { installments: InstallmentApi[] }): CommitmentDetailApi {
  return {
    id: 1,
    title: "גולן טלקום",
    payeeId: null,
    payeeNameSnapshot: "גולן טלקום",
    currency: "ILS",
    scheduleKind: "RECURRING",
    recurrence: "MONTHLY",
    status: "ACTIVE",
    endAt: null,
    note: null,
    total: null,
    paid: "0.00",
    remaining: null,
    isLegacy: false,
    legacy: null,
    payments: [],
    audit: [],
    ...p,
  };
}

/* ───────────── 1. the current installment = the server's `next` ───────────── */

{
  const a = inst({ dueAt: "2026-10-25T09:00:00Z", state: "DUE" });
  const b = inst({ dueAt: "2026-09-25T09:00:00Z", state: "PAID" });
  const c = inst({ dueAt: "2026-11-25T09:00:00Z", state: "SCHEDULED" });
  eq("earliest open installment is current", pickCurrentInstallment([c, b, a])?.id, a.id);

  const cancelledEarly = inst({ dueAt: "2026-08-01T09:00:00Z", state: "CANCELLED", remaining: "100.00" });
  eq("a cancelled installment is never current even with a remaining figure", pickCurrentInstallment([cancelledEarly, c])?.id, c.id);
  eq("nothing open → no current installment", pickCurrentInstallment([b]), null);

  // Drift guard: the server rule this mirrors must still read the same.
  const serverRead = read("lib/services/payables/payables-read.ts");
  ok(
    "server list `next` still = remaining > 0 and not CANCELLED, earliest dueAt",
    /\.filter\(\(d\) => d\.balance\.remainingMinor > 0 && d\.balance\.state !== "CANCELLED"\)\s*\.sort\(\(a, b\) => a\.row\.dueAt\.getTime\(\) - b\.row\.dueAt\.getTime\(\)\)/.test(serverRead),
  );
}

/* ───────────── 2. payable installments = the forms' own filter ───────────── */

{
  const open = inst({ dueAt: "2026-10-01T09:00:00Z", state: "OVERDUE" });
  const legacy = inst({ dueAt: "2026-09-01T09:00:00Z", state: "SETTLED_LEGACY" });
  const paid = inst({ dueAt: "2026-08-01T09:00:00Z", state: "PAID" });
  eq("only SCHEDULED with a remaining figure is payable", payableInstallments([open, legacy, paid]).map((i) => i.id), [open.id]);
  for (const file of ["app/(shell)/payables/prepare-parts.tsx", "app/(shell)/payables/cheque-parts.tsx", "app/(shell)/payables/[id]/payment-form.tsx"]) {
    ok(`${file} still filters status SCHEDULED + remaining > 0`, /status === "SCHEDULED"/.test(read(file)) && /Number\(i\.remaining\) > 0/.test(read(file)));
  }
}

/* ───────────── 3. the status box tells the truth ───────────── */

{
  const due = inst({ dueAt: "2026-10-25T09:00:00Z", state: "DUE", scheduled: "120.00" });
  const past = inst({ dueAt: "2026-09-25T09:00:00Z", state: "PAID", scheduled: "120.00" });
  let h = heroOf(detail({ installments: [past, due] }));
  eq("open recurring → OPEN on the due installment", [h.kind, h.installment?.id], ["OPEN", due.id]);

  const late = inst({ dueAt: "2026-10-15T09:00:00Z", state: "OVERDUE", scheduled: "1500.00", paid: "500.00", remaining: "1000.00" });
  h = heroOf(detail({ scheduleKind: "INSTALLMENT_PLAN", installments: [late, inst({ dueAt: "2026-11-15T09:00:00Z", state: "SCHEDULED" })] }));
  eq("overdue current → OVERDUE", h.kind, "OVERDUE");
  ok("overdue partly-paid installment reads as partly paid", isPartlyPaid(late));
  ok("a fully open installment is not partly paid", !isPartlyPaid(due));

  const p1 = payment("2026-10-12T09:00:00Z");
  const p0 = payment("2026-10-01T09:00:00Z");
  const voided = payment("2026-10-20T09:00:00Z", "VOID");
  h = heroOf(detail({ scheduleKind: "ONE_OFF", total: "850.00", installments: [inst({ dueAt: "2026-10-12T09:00:00Z", state: "PAID" })], payments: [p0, voided, p1] }));
  eq("fully paid → PAID", h.kind, "PAID");
  eq("“שולם ב־” is the latest RECORDED payment, never a voided one", h.lastPayment?.id, p1.id);

  h = heroOf(detail({ endAt: "2026-09-30T09:00:00Z", installments: [inst({ dueAt: "2026-09-01T09:00:00Z", state: "PAID" }), inst({ dueAt: "2026-10-01T09:00:00Z", state: "CANCELLED" })] }));
  eq("ended series with nothing open → ENDED (not “paid”, not pending)", h.kind, "ENDED");

  h = heroOf(detail({ isLegacy: true, status: "CLOSED", installments: [inst({ dueAt: "2026-09-01T09:00:00Z", state: "SETTLED_LEGACY" })] }));
  eq("legacy-handled only → LEGACY, never PAID", h.kind, "LEGACY");
  ok("LEGACY title is “סומן כטופל”, not “שולם”", HERO_TITLE.LEGACY === "סומן כטופל" && !HERO_TITLE.LEGACY.includes("שולם"));

  h = heroOf(detail({ status: "RELEASED", installments: [inst({ dueAt: "2026-09-01T09:00:00Z", state: "CANCELLED" })] }));
  eq("released → RELEASED", h.kind, "RELEASED");
  h = heroOf(detail({ installments: [inst({ dueAt: "2026-09-01T09:00:00Z", state: "CANCELLED" })] }));
  eq("every installment cancelled → CANCELLED", h.kind, "CANCELLED");
  h = heroOf(detail({ installments: [] }));
  eq("no installments → NONE", h.kind, "NONE");

  h = heroOf(detail({ endAt: "2026-12-31T09:00:00Z", installments: [due] }));
  eq("an end date in the future does not hide an open payment", h.kind, "OPEN");

  for (const kind of ["PAID", "ENDED", "LEGACY", "RELEASED", "CANCELLED", "NONE"] as const) {
    ok(`${kind} title never claims something is waiting`, !/ממתין|לתשלום|הקרוב|באיחור/.test(HERO_TITLE[kind]));
  }
}

/* ───────────── 4. schedule order ───────────── */

{
  const paid1 = inst({ dueAt: "2026-07-25T09:00:00Z", state: "PAID" });
  const paid2 = inst({ dueAt: "2026-09-25T09:00:00Z", state: "PAID" });
  const due = inst({ dueAt: "2026-10-25T09:00:00Z", state: "DUE" });
  const later = inst({ dueAt: "2026-11-25T09:00:00Z", state: "SCHEDULED" });
  const cancelled = inst({ dueAt: "2026-12-25T09:00:00Z", state: "CANCELLED" });
  eq(
    "open first (earliest first), then the rest most recent first",
    orderSchedule([paid1, later, cancelled, paid2, due]).map((i) => i.id),
    [due.id, later.id, cancelled.id, paid2.id, paid1.id],
  );
  eq("ordering keeps every installment", orderSchedule([paid1, due]).length, 2);
  ok("preview grows with the layout", SCHEDULE_PREVIEW.mobile < SCHEDULE_PREVIEW.tablet && SCHEDULE_PREVIEW.tablet < SCHEDULE_PREVIEW.desktop);
}

/* ───────────── 5. cheques and preparations are counted exactly ───────────── */

{
  const c = (status: ChequeApi["status"]) => ({ status });
  eq("no cheques → empty label", chequeCountLabel([]), "");
  eq("open vs total", chequeCounts([c("ISSUED"), c("DELIVERED"), c("CLEARED")]), { open: 2, total: 3 });
  eq("mixed label", chequeCountLabel([c("ISSUED"), c("DELIVERED"), c("CLEARED")]), "2 צ׳קים פתוחים · 3 בסך הכל");
  eq("one open cheque", chequeCountLabel([c("PLANNED")]), "צ׳ק פתוח אחד");
  eq("all open", chequeCountLabel([c("PLANNED"), c("PRESENTED")]), "2 צ׳קים פתוחים");
  eq("none open", chequeCountLabel([c("CLEARED"), c("BOUNCED"), c("REPLACED")]), "3 צ׳קים");
  eq("one closed cheque", chequeCountLabel([c("CANCELLED")]), "צ׳ק אחד");

  const prep = (status: PreparationApi["status"]) => ({ status }) as PreparationApi;
  eq(
    "open preparations = PREPARED / APPROVED / SUBMITTED",
    openPreparations([prep("PREPARED"), prep("APPROVED"), prep("SUBMITTED"), prep("COMPLETED"), prep("FAILED"), prep("CANCELLED")]).length,
    3,
  );
  eq("no open preparation → no strip text", openPreparationsLabel(0), "");
  eq("one open preparation", openPreparationsLabel(1), "תשלום מוכן אחד ממתין לטיפול שלך");
}

/* ───────────── 6. history: Hebrew label, original kept ───────────── */

{
  eq(
    "the cutover sentence the owner saw",
    auditLabel({ eventType: "COMMITMENT_UPDATED", source: "MIGRATION", summary: "Recurring commitment total cleared (ledger invariant; migrated value)" }),
    "העברה מהמזכירה: התאמה למבנה של התחייבות מתחדשת: הוסר סכום כולל שהועבר מהמערכת הקודמת",
  );
  eq(
    "migration events read as such",
    auditLabel({ eventType: "COMMITMENT_SYNCED_FROM_OBLIGATION", source: "MIGRATION", summary: "Synced from BusinessObligation #212 (secretary cutover)" }),
    "עודכנו פרטים מהרשומה המקורית במזכירה",
  );
  eq("ordinary event", auditLabel({ eventType: "PAYMENT_RECORDED", source: "USER", summary: "Manual payment of 120.00 ILS recorded" }), "נרשם תשלום");
  eq(
    "end-of-series cancellation",
    auditLabel({ eventType: "INSTALLMENT_CANCELLED", source: "USER", summary: "Installment cancelled — the commitment ends 2026-09-30" }),
    "תשלום בוטל בעקבות סיום ההתחייבות",
  );
  eq("unknown type falls back, never shows raw English", auditLabel({ eventType: "SOMETHING_NEW", source: "USER", summary: "x" }), AUDIT_FALLBACK_LABEL);
  for (const label of Object.values(AUDIT_LABEL)) ok(`label is Hebrew: ${label}`, /[֐-׿]/.test(label) && !/[A-Za-z]{3,}/.test(label));

  // Every eventType the payables services can write has a label.
  const dir = path.join(ROOT, "lib/services/payables");
  const written = new Set<string>();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.includes(".test.")) continue;
    for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/eventType: "([A-Z_]+)"/g)) written.add(m[1]);
  }
  ok("found the audit event types", written.size > 30);
  for (const type of written) ok(`audit type ${type} has a Hebrew label`, type in AUDIT_LABEL);
}

/* ───────────── 7. every existing capability is still reachable ───────────── */

{
  const page = read("app/(shell)/payables/[id]/page.tsx");
  const parts = read("app/(shell)/payables/[id]/detail-parts.tsx");
  const form = read("app/(shell)/payables/[id]/payment-form.tsx");
  const all = page + parts + form;
  const must: Array<[string, RegExp]> = [
    ["back button", /<BackButton \/>/],
    ["record payment form", /<PaymentForm[\s\S]*preselect=/],
    ["record payment call with idempotency key", /recordPayment\(\{[\s\S]*idempotencyKey,/],
    ["?pay deep link opens the form preselected", /get\("pay"\)[\s\S]*kind: "record", preselect: pay/],
    ["prepare payment form", /<PreparePaymentForm/],
    ["no-provider notice", /money\.payables\.detail\.noProvider/],
    ["prepared payment cards", /<PreparationCard/],
    ["cheque form", /<ChequeForm/],
    ["cheque cards", /<ChequeCard/],
    ["recurring amount change / end", /<RecurringChanges/],
    ["reverse allocation (same reason)", /reverseAllocation\(allocationId, "תוקן על ידי בעל העסק"\)/],
    ["cancel installment (same reason)", /cancelInstallment\(installmentId, "בוטל על ידי בעל העסק"\)/],
    ["void payment (same reason)", /voidPayment\(p\.id, "בוטל על ידי בעל העסק"\)/],
    ["void is confirmed first", /money\.payables\.detail\.voidConfirm/],
    ["surplus notice", /money\.payables\.detail\.surplusBefore/],
    ["legacy assertion text", /money\.payables\.detail\.legacyExplain/],
    ["recurring notice", /money\.payables\.detail\.recurringNotice/],
    ["history with Hebrew labels", /auditLabel\(a\)/],
    ["history keeps the original summary", /פרטים טכניים[\s\S]*\{a\.summary\}/],
    ["note shown read-only", /detail\.note \?/],
    ["total / paid / remaining figures", /money\.payables\.detail\.totalAmount[\s\S]*money\.payables\.list\.paid[\s\S]*money\.payables\.list\.remaining/],
    ["cannot-cancel explanation", /money\.payables\.detail\.cannotCancel/],
    ["legacy badge", /money\.payables\.list\.legacyBadge/],
  ];
  for (const [label, re] of must) ok(`screen keeps: ${label}`, re.test(all));
  ok("cheque recording still only for ACTIVE commitments", /detail\.status === "ACTIVE" && \(\s*<button[\s\S]*recordCheque/.test(parts));
  ok("prepare still only for ACTIVE commitments", /canPrepare = detail\.status === "ACTIVE"/.test(page));
  ok("recurring changes still only for RECURRING + ACTIVE", /scheduleKind === "RECURRING" && detail\.status === "ACTIVE"/.test(parts));
  ok("no money arithmetic in the screen files", !/(remaining|scheduled|paid|total|amount)\)?\s*[-+*/]\s*Number/.test(all));
  ok("no new API endpoint called from the screen", !/fetch\(/.test(all));
}

console.log(`commitment detail model: ${checks} checks passed`);
