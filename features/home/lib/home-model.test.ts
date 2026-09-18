/**
 * Home view-model proof (`npm run verify:home-model`).
 *
 * The home screen's whole claim is that it does not invent anything. That
 * claim lives in these derivations, so it is locked here:
 *
 *   - a CALM verdict is never offered to a business the engine has not
 *     oriented (`STILL_SETTLING_IN` must not read as "you are covered");
 *   - the verdict quotes the owner's own counts, so a business with two
 *     breaks today cannot be told it has one;
 *   - "היום שלך" carries a badge only for late / today / tomorrow — never a
 *     countdown, and never a row whose date is further out;
 *   - the "תשלומים למועד" counter counts obligations at or past their date,
 *     and nothing else;
 *   - a group's status is a LABEL, and is "הכול מטופל" only when that group's
 *     domains genuinely have no open item.
 */

import {
  buildTodayRows,
  buildVerdict,
  countObligationsDue,
  counterFrom,
  dueBadgeFor,
  formatAmount,
  greetingForHour,
  groupStatus,
} from "./home-model";
import type {
  BriefingApi,
  BriefingItemApi,
  ObligationApi,
} from "@/lib/obligations/secretary-client";
import type { BusinessStatusItem, Severity } from "@/lib/business-status/types";
import { TOOL_GROUPS } from "@/lib/navigation/home-routes";

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(actual: T, expected: T, label: string) {
  check(
    actual === expected,
    label,
    actual === expected ? "" : `got ${String(actual)}, want ${String(expected)}`
  );
}

/* ------------------------------------------------------------ fixtures -- */

const NOW = new Date("2026-09-17T09:00:00+03:00");

function isoDaysFromNow(days: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() + days);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

function obligation(id: number, dueAt: string, name = "ספק החשמל"): ObligationApi {
  return {
    id,
    obligeeName: name,
    amount: "1250.00",
    currency: "ILS",
    dueAt,
    state: "OPEN",
    source: "MANUAL",
    recurrence: "NONE",
    recurrenceSeriesId: null,
    note: null,
    followUpAt: null,
    settlementAssertedBy: null,
    metAt: null,
    releasedAt: null,
    createdAt: isoDaysFromNow(-30),
    updatedAt: isoDaysFromNow(-30),
  };
}

function briefing(
  overrides: Partial<BriefingApi> & { attention?: BriefingItemApi[] } = {}
): BriefingApi {
  const attention = overrides.attention ?? [];
  return {
    state: "CALM",
    oriented: true,
    attention,
    watching: [],
    counts: {
      open: attention.length,
      attention: attention.length,
      breakToday: 0,
      watching: 0,
    },
    generatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function statusItem(
  domain: BusinessStatusItem["domain"],
  severity: Severity
): BusinessStatusItem {
  return {
    itemId: `${domain}-${severity}`,
    domain,
    semanticCategory: "ACTION_REQUIRED",
    title: "פריט",
    summary: null,
    severity,
    priorityScore: 1,
    entityRef: { type: domain, id: 1 },
    state: "open",
    createdAt: NOW.toISOString(),
    primaryAction: { kind: "navigate", label: "פתח", href: "/attention" },
    sourceEngine: "test",
  };
}

console.log("Home view-model — honesty rules");

/* ------------------------------------------------------------ greeting -- */

eq(greetingForHour(7), "בוקר טוב", "07:00 is morning");
eq(greetingForHour(13), "צהריים טובים", "13:00 is midday");
eq(greetingForHour(19), "ערב טוב", "19:00 is evening");
eq(greetingForHour(2), "לילה טוב", "02:00 is night");

/* ------------------------------------------------------------- verdict -- */

// A business the engine has not oriented is NEVER told it is covered.
{
  const v = buildVerdict(
    briefing({ state: "STILL_SETTLING_IN", oriented: false })
  );
  eq(v.tone, "settling", "unoriented business gets the settling tone");
  check(!v.sentence.includes("מכוסה"), "settling never claims the owner is covered");
  check(!v.badge.includes("רגוע"), "settling is not badged as calm");
}

// CALM only when the engine said CALM.
{
  const v = buildVerdict(briefing({ state: "CALM", oriented: true }));
  eq(v.tone, "calm", "CALM maps to the calm tone");
  eq(v.ctaLabel, "מה בהשגחה", "CALM offers the watching action");
}

// Counts are read out as Hebrew, not as "1 התחייבויות".
{
  const one = buildVerdict(
    briefing({
      state: "CALM",
      counts: { open: 1, attention: 0, breakToday: 0, watching: 1 },
    })
  );
  check(
    !/\b1 התחייבויות/.test(one.sentence),
    "a single watched obligation is not read as a plural",
    one.sentence
  );

  const oneSettling = buildVerdict(
    briefing({
      state: "STILL_SETTLING_IN",
      oriented: false,
      counts: { open: 1, attention: 0, breakToday: 0, watching: 1 },
    })
  );
  check(
    !/\b1 התחייבויות/.test(oneSettling.sentence),
    "settling reads one watched obligation as singular too",
    oneSettling.sentence
  );
}

// The verdict quotes the owner's own figures.
{
  const v = buildVerdict(
    briefing({
      state: "CRITICAL",
      counts: { open: 9, attention: 4, breakToday: 2, watching: 5 },
    })
  );
  eq(v.tone, "critical", "CRITICAL maps to the critical tone");
  check(v.sentence.includes("2"), "critical sentence carries breakToday", v.sentence);
  eq(v.ctaLabel, "לטפל עכשיו", "CRITICAL offers the act-now action");
}

{
  const v = buildVerdict(
    briefing({
      state: "BUSY",
      counts: { open: 6, attention: 3, breakToday: 0, watching: 3 },
    })
  );
  eq(v.tone, "busy", "BUSY maps to the busy tone");
  check(v.sentence.includes("3"), "busy sentence carries the attention count", v.sentence);
  eq(v.ctaLabel, "בוא נתחיל", "BUSY offers the start action");
}

// Singular/plural is real copy, not a template with a stray number.
{
  const v = buildVerdict(
    briefing({
      state: "CRITICAL",
      counts: { open: 1, attention: 1, breakToday: 1, watching: 0 },
    })
  );
  check(v.sentence.includes("אחת"), "one break today reads as one", v.sentence);
}

/* ----------------------------------------------------------- due dates -- */

eq(dueBadgeFor(isoDaysFromNow(-1), NOW), "late", "yesterday is late");
eq(dueBadgeFor(isoDaysFromNow(0), NOW), "today", "today is today");
eq(dueBadgeFor(isoDaysFromNow(1), NOW), "tomorrow", "tomorrow is tomorrow");
eq(dueBadgeFor(isoDaysFromNow(2), NOW), null, "the day after tomorrow has no badge");
eq(dueBadgeFor(isoDaysFromNow(30), NOW), null, "a distant date has no badge");
eq(dueBadgeFor("not-a-date", NOW), null, "an unparseable date has no badge");

/* ---------------------------------------------------------- היום שלך --- */

{
  const items: BriefingItemApi[] = [
    { obligation: obligation(1, isoDaysFromNow(1)), reason: "DUE_SOON" },
    { obligation: obligation(2, isoDaysFromNow(-3)), reason: "OVERDUE" },
    { obligation: obligation(3, isoDaysFromNow(0)), reason: "DUE_TODAY" },
    { obligation: obligation(4, isoDaysFromNow(9)), reason: "DUE_SOON" },
  ];
  const rows = buildTodayRows(briefing({ attention: items }), NOW);

  eq(rows.length, 3, "rows past tomorrow are dropped");
  eq(rows[0].obligationId, 2, "the overdue row comes first");
  eq(rows[0].badge, "late", "the overdue row is badged late");
  eq(rows[1].badge, "today", "today's row comes second");
  eq(rows[2].badge, "tomorrow", "tomorrow's row comes last");
  check(
    !rows.some((r) => r.obligationId === 4),
    "an obligation nine days out is not in היום שלך"
  );
}

// An empty or junk obligee name never reaches the screen as a blank row.
{
  const rows = buildTodayRows(
    briefing({
      attention: [
        { obligation: obligation(7, isoDaysFromNow(0), " "), reason: "DUE_TODAY" },
      ],
    }),
    NOW
  );
  eq(rows[0].title, "התחייבות ללא שם", "a junk obligee name gets the honest placeholder");
}

{
  const rows = buildTodayRows(briefing({ attention: [] }), NOW);
  eq(rows.length, 0, "no obligations means no rows (and the empty state)");
}

/* ---------------------------------------------------------- counter --- */

{
  const items: BriefingItemApi[] = [
    { obligation: obligation(1, isoDaysFromNow(-2)), reason: "OVERDUE" },
    { obligation: obligation(2, isoDaysFromNow(0)), reason: "DUE_TODAY" },
    { obligation: obligation(3, isoDaysFromNow(1)), reason: "DUE_SOON" },
    { obligation: obligation(4, isoDaysFromNow(4)), reason: "DUE_SOON" },
  ];
  eq(
    countObligationsDue(briefing({ attention: items }), NOW),
    2,
    "only obligations at or past their date are counted as due"
  );
}

eq(countObligationsDue(briefing({ attention: [] }), NOW), 0, "no obligations counts zero");

/* --------------------------------------------- counter state semantics --- */

/**
 * LOADING ≠ FAILED ≠ SUCCESS(0).
 *
 * These three used to collapse into `number | null`, so a request still in
 * flight rendered the failure wording. The union exists to keep them apart,
 * and this locks that they never merge again.
 */
{
  const loading = counterFrom<{ n: number }>({ state: "loading" }, (v) => v.n);
  eq(loading.state, "loading", "a source still loading yields the loading state");
  check(!("value" in loading), "a loading counter carries no figure to render");

  const failed = counterFrom<{ n: number }>({ state: "failed" }, (v) => v.n);
  eq(failed.state, "failed", "a failed source yields the failed state");
  check(!("value" in failed), "a failed counter carries no figure to render");

  const zero = counterFrom({ state: "ready", value: { n: 0 } }, (v) => v.n);
  eq(zero.state, "ready", "a real zero is READY, not failed and not loading");
  check(zero.state === "ready" && zero.value === 0, "a real zero renders as 0");

  const some = counterFrom({ state: "ready", value: { n: 37 } }, (v) => v.n);
  check(some.state === "ready" && some.value === 37, "a real figure passes through");

  // The three states are mutually exclusive — no two ever share a shape.
  const states = [loading.state, failed.state, zero.state];
  eq(new Set(states).size, 3, "loading, failed and ready are three distinct states");

  // The figure is only read when there is one: a throwing reader must never be
  // invoked for loading or failed.
  let called = 0;
  const reader = (v: { n: number }) => {
    called += 1;
    return v.n;
  };
  counterFrom<{ n: number }>({ state: "loading" }, reader);
  counterFrom<{ n: number }>({ state: "failed" }, reader);
  eq(called, 0, "the figure is not read unless the source is ready");
}

/* ------------------------------------------------------ group status --- */

{
  eq(groupStatus([], ["billing", "documents"]).tone, "clear", "no items is clear");
  eq(
    groupStatus([], ["billing", "documents"]).label,
    "הכול מטופל",
    "clear reads as handled"
  );

  const other = [statusItem("inventory", "CRITICAL")];
  eq(
    groupStatus(other, ["billing", "documents"]).tone,
    "clear",
    "another group's item does not colour this group"
  );

  const low = [statusItem("documents", "MEDIUM")];
  eq(groupStatus(low, ["billing", "documents"]).tone, "review", "MEDIUM is review");

  const high = [statusItem("documents", "MEDIUM"), statusItem("billing", "HIGH")];
  eq(groupStatus(high, ["billing", "documents"]).tone, "urgent", "HIGH is urgent");

  const critical = [statusItem("inbox", "CRITICAL")];
  eq(groupStatus(critical, ["inbox", "leads"]).tone, "urgent", "CRITICAL is urgent");

  // The label never contains a figure: the snapshot is capped per domain, so a
  // count taken from it could only ever under-report.
  for (const tone of ["clear", "review", "urgent"] as const) {
    const source =
      tone === "clear" ? [] : tone === "review" ? low : critical;
    const domains = tone === "urgent" ? (["inbox", "leads"] as const) : (["billing", "documents"] as const);
    const { label } = groupStatus(source, [...domains]);
    check(!/\d/.test(label), `group label carries no number (${tone})`, label);
  }
}

// Every declared group speaks for at least one domain, and no domain is orphaned.
{
  const covered = new Set(TOOL_GROUPS.flatMap((g) => g.domains));
  const ALL: BusinessStatusItem["domain"][] = [
    "inbox",
    "documents",
    "inventory",
    "billing",
    "supplier",
    "leads",
  ];
  for (const domain of ALL) {
    check(covered.has(domain), `domain has a group that speaks for it: ${domain}`);
  }
}

/* ------------------------------------------------------------ amounts -- */

eq(formatAmount("1250.00", "ILS"), "₪1,250", "shekels are grouped and symbolised");
eq(formatAmount("0.00", "ILS"), "₪0", "zero is zero, not blank");
eq(formatAmount("abc", "ILS"), "abc", "an unparseable amount is passed through, not zeroed");

/* --------------------------------------------------------------- done -- */

console.log(`  checks ${checks}, failures ${failures}`);
if (failures > 0) {
  console.error("Home view-model — FAILED");
  process.exit(1);
}
console.log("Home view-model — OK");
