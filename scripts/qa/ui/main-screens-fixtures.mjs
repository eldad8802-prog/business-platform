/**
 * Fixtures for main-screens-qa.mjs — the audited Prod business as of
 * 2026-10-21 (Secretary + Payables), plus synthetic variants: "empty", "calm",
 * "error" (the lists answer 500 in English), "summaryFail" (only the cost
 * summary fails), "legacy" (one Secretary item with no ledger link, for the
 * action-error path) and "loading" (prod data, answered late by the harness).
 * Every value is fabricated/neutral; nothing here is read from a database.
 * Shapes follow:
 *   lib/obligations/secretary-client.ts      (BriefingApi, ObligationApi)
 *   lib/payables/payables-client.ts          (CommitmentListApi, CommitmentDetailApi, ...)
 *   lib/business-cost/business-cost-client.ts (BusinessCostSummaryApi)
 *   lib/services/crm/lead-briefing.ts        (LeadBriefing)
 */

export const FROZEN_NOW = "2026-10-21T09:00:00+03:00";
const GEN = "2026-10-21T06:00:00.000Z";

/* ───────────── obligations (ledger-backed) ───────────── */

function obligation(o) {
  return {
    currency: "ILS",
    state: "OPEN",
    source: "MANUAL",
    recurrenceSeriesId: o.recurrence === "NONE" ? null : `series-${o.id}`,
    note: null,
    followUpAt: null,
    settlementAssertedBy: null,
    metAt: null,
    releasedAt: null,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-28T08:00:00.000Z",
    ...o,
  };
}

const OB11 = obligation({ id: 11, obligeeName: "גולן טלקום", recurrence: "MONTHLY", amount: "35.00", dueAt: "2026-09-10T06:00:00.000Z", ledger: { commitmentId: 5, installmentId: 11, paid: "20.00", remaining: "15.00" } });
const OB12 = obligation({ id: 12, obligeeName: "דירה", recurrence: "NONE", amount: "3500.00", dueAt: "2026-09-15T00:00:00.000Z", ledger: { commitmentId: 6, installmentId: 12, paid: "0.00", remaining: "3500.00" } });
const OB13 = obligation({ id: 13, obligeeName: "גולן טלקום", recurrence: "MONTHLY", amount: "30.00", dueAt: "2026-09-15T00:00:00.000Z", ledger: { commitmentId: 7, installmentId: 13, paid: "0.00", remaining: "30.00" } });
const OB14 = obligation({ id: 14, obligeeName: "ביטוח לאומי", recurrence: "NONE", amount: "50.00", dueAt: "2026-12-29T00:00:00.000Z", ledger: { commitmentId: 8, installmentId: 14, paid: "0.00", remaining: "50.00" } });

/* ───────────── payables: commitments ───────────── */

const LIST = {
  5: { id: 5, title: "גולן טלקום", scheduleKind: "RECURRING", total: null, paid: "20.00", remaining: null, next: { id: 11, sequence: 1, dueAt: "2026-09-10T06:00:00.000Z", scheduled: "35.00", remaining: "15.00", state: "PARTIALLY_PAID" }, attention: "PARTIALLY_PAID", isLegacy: true },
  6: { id: 6, title: "דירה", scheduleKind: "ONE_OFF", total: "3500.00", paid: "0.00", remaining: "3500.00", next: { id: 12, sequence: 1, dueAt: "2026-09-15T00:00:00.000Z", scheduled: "3500.00", remaining: "3500.00", state: "OVERDUE" }, attention: "OVERDUE", isLegacy: true },
  7: { id: 7, title: "גולן טלקום", scheduleKind: "RECURRING", total: null, paid: "0.00", remaining: null, next: { id: 13, sequence: 1, dueAt: "2026-09-15T00:00:00.000Z", scheduled: "30.00", remaining: "30.00", state: "OVERDUE" }, attention: "OVERDUE", isLegacy: true },
  8: { id: 8, title: "ביטוח לאומי", scheduleKind: "ONE_OFF", total: "50.00", paid: "0.00", remaining: "50.00", next: { id: 14, sequence: 1, dueAt: "2026-12-29T00:00:00.000Z", scheduled: "50.00", remaining: "50.00", state: "SCHEDULED" }, attention: "SCHEDULED", isLegacy: true },
};
for (const c of Object.values(LIST)) {
  Object.assign(c, { payeeId: null, payeeNameSnapshot: c.title, currency: "ILS", status: "ACTIVE", installmentCount: 1 });
}

const PAYMENT_31 = { id: 31, amount: "20.00", allocated: "20.00", unallocated: "0.00", status: "RECORDED", method: "BANK_TRANSFER", paidAt: "2026-09-12T00:00:00.000Z", externalReference: null };

function detail(id) {
  const c = LIST[id];
  const n = c.next;
  const paid = id === 5 ? "20.00" : "0.00";
  const allocations = id === 5
    ? [{ id: 41, paymentId: 31, amount: "20.00", active: true, reversedAt: null, reversalReason: null, paymentStatus: "RECORDED", paymentPaidAt: PAYMENT_31.paidAt, paymentMethod: "BANK_TRANSFER" }]
    : [];
  const recurring = c.scheduleKind === "RECURRING";
  const legacyObligationId = { 5: 5, 6: 7, 7: 6, 8: 8 }[id];
  const audit = [
    { id: id * 10 + 1, eventType: "COMMITMENT_CREATED", source: "SYSTEM", summary: `Migrated from BusinessObligation #${legacyObligationId}`, occurredAt: "2026-09-17T08:00:00.000Z" },
  ];
  if (recurring) {
    // eventType from lib/services/payables/secretary-ledger-cutover.service.ts (step C).
    audit.push({ id: id * 10 + 2, eventType: "COMMITMENT_UPDATED", source: "SYSTEM", summary: "Recurring commitment total cleared (ledger invariant; migrated value)", occurredAt: "2026-09-28T08:00:00.000Z" });
  }
  return {
    id: c.id,
    title: c.title,
    payeeId: null,
    payeeNameSnapshot: c.title,
    currency: "ILS",
    scheduleKind: c.scheduleKind,
    recurrence: recurring ? "MONTHLY" : "NONE",
    status: "ACTIVE",
    endAt: null,
    note: null,
    total: c.total,
    paid: c.paid,
    remaining: c.remaining,
    isLegacy: true,
    legacy: { assertedBy: null, metAt: null },
    installments: [
      { id: n.id, sequence: 1, dueAt: n.dueAt, scheduled: n.scheduled, paid, remaining: n.remaining, state: n.state, status: "SCHEDULED", legacyAssertedBy: null, legacyMetAt: null, allocations },
    ],
    payments: id === 5 ? [PAYMENT_31] : [],
    audit,
  };
}

/* ───────────── business cost ───────────── */

const period = (from, to, days, state = "PARTIAL") => ({ from, to, days, cashOut: "0.00", allocated: "0.00", completeness: { state, reasons: [] } });
const win = (from, to, total, recorded, projected, items) => ({ from, to, total, recorded, projected, items });

function costSummary(kind) {
  const periods = (state) => ({
    today: period("2026-10-21", "2026-10-21", 1, state),
    yesterday: period("2026-10-20", "2026-10-20", 1, state),
    thisWeek: period("2026-10-18", "2026-10-21", 4, state),
    thisMonth: period("2026-10-01", "2026-10-21", 21, state),
    last30Days: period("2026-09-22", "2026-10-21", 30, state),
  });
  if (kind === "empty") {
    return {
      asOf: "2026-10-21", currency: "ILS", periods: periods("EMPTY"),
      baseline: { daily: "0.00", weekly: "0.00", monthly: "0.00", annual: "0.00", calendarDay: { month: "2026-10", daysInMonth: 31, daily: "0.00" }, lines: [], uncertain: "0.00", uncertainItems: [], debtServiceMonthly: "0.00", debtServiceLines: [], affirmation: { affirmed: false, affirmedOn: null }, completeness: { state: "EMPTY", reasons: [] } },
      upcoming: { overdue: win("2026-01-01", "2026-10-20", "0.00", "0.00", "0.00", []), next7Days: win("2026-10-21", "2026-10-27", "0.00", "0.00", "0.00", []), next30Days: win("2026-10-21", "2026-11-19", "0.00", "0.00", "0.00", []), currentMonth: win("2026-10-01", "2026-10-31", "0.00", "0.00", "0.00", []) },
      insights: [],
    };
  }
  if (kind === "calm") {
    return {
      asOf: "2026-10-21", currency: "ILS", periods: periods("PARTIAL"),
      baseline: { daily: "0.00", weekly: "0.00", monthly: "0.00", annual: "0.00", calendarDay: { month: "2026-10", daysInMonth: 31, daily: "0.00" }, lines: [], uncertain: "50.00", uncertainItems: [{ commitmentId: 8, title: "ביטוח לאומי", reason: "ONE_OFF_COVERAGE_UNKNOWN", amount: "50.00", dueDate: "2026-12-29" }], debtServiceMonthly: "0.00", debtServiceLines: [], affirmation: { affirmed: true, affirmedOn: "2026-10-01" }, completeness: { state: "PARTIAL", reasons: [] } },
      upcoming: { overdue: win("2026-01-01", "2026-10-20", "0.00", "0.00", "0.00", []), next7Days: win("2026-10-21", "2026-10-27", "0.00", "0.00", "0.00", []), next30Days: win("2026-10-21", "2026-11-19", "0.00", "0.00", "0.00", []), currentMonth: win("2026-10-01", "2026-10-31", "0.00", "0.00", "0.00", []) },
      insights: [],
    };
  }
  return {
    asOf: "2026-10-21",
    currency: "ILS",
    periods: periods("PARTIAL"),
    baseline: {
      daily: "2.14",
      weekly: "14.95",
      monthly: "65.00",
      annual: "780.00",
      calendarDay: { month: "2026-10", daysInMonth: 31, daily: "2.10" },
      lines: [
        { commitmentId: 5, title: "גולן טלקום", recurrence: "MONTHLY", periodAmount: "35.00", basis: "RECORDED", monthly: "35.00" },
        { commitmentId: 7, title: "גולן טלקום", recurrence: "MONTHLY", periodAmount: "30.00", basis: "RECORDED", monthly: "30.00" },
      ],
      uncertain: "3550.00",
      uncertainItems: [
        { commitmentId: 6, title: "דירה", reason: "ONE_OFF_COVERAGE_UNKNOWN", amount: "3500.00", dueDate: "2026-09-15" },
        { commitmentId: 8, title: "ביטוח לאומי", reason: "ONE_OFF_COVERAGE_UNKNOWN", amount: "50.00", dueDate: "2026-12-29" },
      ],
      debtServiceMonthly: "0.00",
      debtServiceLines: [],
      affirmation: { affirmed: false, affirmedOn: null },
      completeness: { state: "PARTIAL", reasons: [] },
    },
    upcoming: {
      overdue: win("2026-01-01", "2026-10-20", "3545.00", "3545.00", "0.00", [
        { title: "גולן טלקום", dueDate: "2026-09-10", amount: "15.00", basis: "RECORDED" },
        { title: "דירה", dueDate: "2026-09-15", amount: "3500.00", basis: "RECORDED" },
        { title: "גולן טלקום", dueDate: "2026-09-15", amount: "30.00", basis: "RECORDED" },
      ]),
      next7Days: win("2026-10-21", "2026-10-27", "0.00", "0.00", "0.00", []),
      next30Days: win("2026-10-21", "2026-11-19", "65.00", "0.00", "65.00", [
        { title: "גולן טלקום", dueDate: "2026-11-10", amount: "35.00", basis: "PROJECTED" },
        { title: "גולן טלקום", dueDate: "2026-11-15", amount: "30.00", basis: "PROJECTED" },
      ]),
      currentMonth: win("2026-10-01", "2026-10-31", "0.00", "0.00", "0.00", []),
    },
    insights: [],
  };
}

/* ───────────── leads briefing ───────────── */

const zeroCounts = () => ({ open: 0, needsAttention: 0, withSuggestion: 0, FOLLOWUP_OVERDUE: 0, CUSTOMER_CALLED: 0, CUSTOMER_WROTE: 0, FOLLOWUP_DUE_TODAY: 0, AWAITING_OWNER_DECISION: 0, NEW_UNHANDLED: 0, QUOTE_NO_ACTIVITY: 0, STALLED: 0 });

function leadsBriefing(kind) {
  if (kind !== "prod") return { state: "CALM", counts: zeroCounts(), items: [], complete: true, generatedAt: GEN };
  return {
    state: "BUSY",
    counts: { ...zeroCounts(), open: 3, needsAttention: 3, FOLLOWUP_OVERDUE: 1, NEW_UNHANDLED: 2 },
    items: [
      { leadId: 101, name: "ליד לדוגמה ג", reason: "FOLLOWUP_OVERDUE", label: "מעקב באיחור", summary: "המעקב היה אמור להיות לפני יומיים", evidenceClass: "fact", priority: 1, suggestion: null, href: "/leads?lead=101" },
      { leadId: 102, name: "ליד לדוגמה א", reason: "NEW_UNHANDLED", label: "ליד חדש שלא טופל", summary: "נכנס לפני 3 ימים ועדיין לא טופל", evidenceClass: "inference", priority: 2, suggestion: null, href: "/leads?lead=102" },
      { leadId: 103, name: "ליד לדוגמה ב", reason: "NEW_UNHANDLED", label: "ליד חדש שלא טופל", summary: "נכנס לפני 4 ימים ועדיין לא טופל", evidenceClass: "inference", priority: 3, suggestion: null, href: "/leads?lead=103" },
    ],
    complete: true,
    generatedAt: GEN,
  };
}

/* ───────────── scenarios ───────────── */

function scenario(kind) {
  if (kind === "empty") {
    return {
      obligations: [],
      briefing: { state: "CALM", oriented: false, attention: [], watching: [], counts: { open: 0, attention: 0, breakToday: 0, watching: 0 }, generatedAt: GEN },
      commitments: [],
      costSummary: costSummary("empty"),
      leadsBriefing: leadsBriefing("empty"),
    };
  }
  if (kind === "calm") {
    return {
      obligations: [OB14],
      briefing: { state: "CALM", oriented: true, attention: [], watching: [OB14], counts: { open: 1, attention: 0, breakToday: 0, watching: 1 }, generatedAt: GEN },
      commitments: [LIST[8]],
      costSummary: costSummary("calm"),
      leadsBriefing: leadsBriefing("calm"),
    };
  }
  return {
    obligations: [OB11, OB12, OB13, OB14],
    briefing: {
      state: "CRITICAL",
      oriented: false,
      attention: [OB11, OB12, OB13].map((obligation) => ({ obligation, reason: "OVERDUE" })),
      watching: [OB14],
      counts: { open: 4, attention: 3, breakToday: 3, watching: 1 },
      generatedAt: GEN,
    },
    commitments: [LIST[5], LIST[6], LIST[7], LIST[8]],
    costSummary: costSummary("prod"),
    leadsBriefing: leadsBriefing("prod"),
  };
}

const OB15 = obligation({ id: 15, obligeeName: "ועד הבית", recurrence: "NONE", amount: "120.00", dueAt: "2026-10-21T00:00:00.000Z", ledger: null });

export const SCENARIOS = {
  prod: scenario("prod"),
  empty: scenario("empty"),
  calm: scenario("calm"),
  loading: scenario("prod"),
  error: { ...scenario("prod"), fail: new Set(["/api/obligations/briefing", "/api/payables/commitments"]) },
  summaryFail: { ...scenario("prod"), fail: new Set(["/api/business-cost/summary"]) },
  legacy: {
    ...scenario("calm"),
    obligations: [OB15, OB14],
    briefing: { state: "ATTENTION", oriented: true, attention: [{ obligation: OB15, reason: "DUE_TODAY" }], watching: [OB14], counts: { open: 2, attention: 1, breakToday: 1, watching: 1 }, generatedAt: GEN },
  },
};

/** Paths the harness answers late in the "loading" scenario. */
export const SLOW_PATHS = new Set(["/api/obligations/briefing", "/api/payables/commitments", "/api/business-cost/summary"]);

/**
 * Resolve a GET /api/** request to a fixture body. Returns `undefined` when the
 * path is not mocked (the harness then logs it and answers 404).
 */
export function resolveApi(kindName, method, pathname, searchParams) {
  const s = SCENARIOS[kindName];
  if (method !== "GET") return undefined;
  // An English server message on purpose: the screen must show Hebrew instead.
  if (s.fail && s.fail.has(pathname)) return { __status: 500, error: "Internal server error" };
  const ids = new Set(s.commitments.map((c) => c.id));
  const obIds = new Map(s.obligations.map((o) => [o.id, o]));

  // ── secretary
  if (pathname === "/api/obligations/briefing") return s.briefing;
  if (pathname === "/api/obligations") {
    const includeClosed = searchParams.get("includeClosed") === "1";
    const list = includeClosed ? s.obligations : s.obligations.filter((o) => o.state === "OPEN");
    const limit = Number(searchParams.get("limit"));
    return { obligations: Number.isFinite(limit) && limit > 0 ? list.slice(0, limit) : list };
  }
  let m = pathname.match(/^\/api\/obligations\/(\d+)$/);
  if (m) return obIds.has(Number(m[1])) ? obIds.get(Number(m[1])) : { __status: 404, error: "not found" };

  // ── payables
  if (pathname === "/api/payables/commitments") {
    const scope = searchParams.get("scope") ?? "open";
    return { commitments: scope === "all" ? s.commitments : s.commitments.filter((c) => c.status === "ACTIVE") };
  }
  m = pathname.match(/^\/api\/payables\/commitments\/(\d+)$/);
  if (m) return ids.has(Number(m[1])) ? { commitment: detail(Number(m[1])) } : { __status: 404, error: "לא נמצא" };
  if (pathname === "/api/payables/cheques") return { cheques: [] };
  if (pathname === "/api/payables/bank-accounts") return { accounts: [], configured: false };
  if (pathname === "/api/payables/preparations") return { preparations: [] };
  if (pathname === "/api/payables/outbound-providers") return { providers: [], live: false };
  if (pathname === "/api/payables/payees") return { payees: [] };
  if (pathname === "/api/payables/bank-lines") return { lines: [] };
  m = pathname.match(/^\/api\/payables\/destinations$/);
  if (m) return { destinations: [] };

  // ── cards on the secretary home
  if (pathname === "/api/business-cost/summary") return s.costSummary;
  if (pathname === "/api/insights") return { insights: [] };
  if (pathname === "/api/leads/briefing") return s.leadsBriefing;

  // ── shell chrome (nav badges, identity, banner, capabilities)
  if (pathname === "/api/business/capabilities") return { features: { daily_tasks: { allowed: false } } };
  if (pathname === "/api/auth/me") return { user: { id: 9, name: "בעלים לדוגמה", businessName: "עסק לדוגמה", email: "qa@example.invalid" } };
  if (pathname === "/api/auth/email/status") return { verificationEnabled: false, verified: true };
  if (pathname === "/api/notifications/unread-count") return { unreadCount: 0 };
  if (pathname === "/api/inbox/attention") return { waitingForReply: [] };
  if (pathname === "/api/collection/inbox") return { summary: { attention: { count: 0 } } };
  if (pathname === "/api/inventory/alerts") return { alerts: [] };
  // The full AgendaResponse shape (lib/services/tasks/agenda.service.ts), empty: /tasks renders its own page.
  if (pathname === "/api/tasks/agenda") return { dayKey: "2026-10-21", buckets: [], count: 0, countPartial: false, doneToday: 0, sources: [], integrity: ["COMPLETE"], emptyAllowed: true, generatedAt: GEN, lastSyncAt: null, lastSyncFailedAt: null, syncVersion: 1, series: [], disabledSources: [] };
  if (pathname === "/api/business-status") return { items: [] };

  return undefined;
}
