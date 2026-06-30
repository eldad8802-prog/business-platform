/**
 * WP1 verification for the Business Obligation operational core.
 * Run with:  npx tsx lib/services/obligations/obligation-core.verify.test.ts
 * (or: npm run verify:obligations-state)
 *
 * Pure logic only — no database, no UI, no HTTP.
 */
import assert from "node:assert/strict";
import {
  addMonthsClamped,
  assertTransitionAllowed,
  deriveBriefing,
  isBreakToday,
  isIdempotentNoop,
  isTerminalState,
  needsAttention,
  nextOccurrence,
  normalizeAmount,
  normalizeCurrency,
} from "./obligation-core";
import type {
  ObligationLifecycleState,
  ObligationRecord,
  RecurrenceCadence,
} from "./obligations.types";
import { isSourceWiredInMvp, reactionFor } from "./obligation-signals";

// --- fixtures --------------------------------------------------------------

const NOW = new Date(2026, 5, 30, 9, 0, 0); // 2026-06-30 09:00 local

let seq = 0;
function ob(overrides: Partial<ObligationRecord> = {}): ObligationRecord {
  seq += 1;
  const base: ObligationRecord = {
    id: seq,
    businessId: 1,
    obligeeName: "Test Obligee",
    amount: "100.00",
    currency: "ILS",
    dueAt: new Date(2026, 6, 15), // ~2 weeks out by default
    state: "OPEN",
    source: "MANUAL",
    recurrence: "NONE",
    recurrenceSeriesId: null,
    note: null,
    followUpAt: null,
    settlementAssertedBy: null,
    metAt: null,
    releasedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...base, ...overrides };
}

function daysFromNow(n: number): Date {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + n);
}

// --- amount / currency normalization --------------------------------------

assert.equal(normalizeAmount(100), "100.00");
assert.equal(normalizeAmount("4200.5"), "4200.50");
assert.equal(normalizeAmount("0.014"), "0.01");
assert.throws(() => normalizeAmount(0), /positive/);
assert.throws(() => normalizeAmount(-5), /positive/);
assert.throws(() => normalizeAmount("abc"), /positive/);
assert.equal(normalizeCurrency(undefined), "ILS");
assert.equal(normalizeCurrency("usd"), "USD");
assert.throws(() => normalizeCurrency("shekel"), /3-letter/);

// --- recurrence ------------------------------------------------------------

assert.equal(nextOccurrence(new Date(2026, 0, 10), "NONE"), null);
assert.deepEqual(
  nextOccurrence(new Date(2026, 0, 10), "WEEKLY"),
  new Date(2026, 0, 17)
);
assert.deepEqual(
  nextOccurrence(new Date(2026, 0, 10), "MONTHLY"),
  new Date(2026, 1, 10)
);
assert.deepEqual(
  nextOccurrence(new Date(2026, 0, 10), "YEARLY"),
  new Date(2027, 0, 10)
);
// month-end clamp: Jan 31 -> Feb 28 (2026 is not a leap year)
assert.deepEqual(addMonthsClamped(new Date(2026, 0, 31), 1), new Date(2026, 1, 28));
// leap year: Jan 31 2028 -> Feb 29
assert.deepEqual(addMonthsClamped(new Date(2028, 0, 31), 1), new Date(2028, 1, 29));

// --- lifecycle transitions -------------------------------------------------

assert.equal(isTerminalState("OPEN"), false);
assert.equal(isTerminalState("MET"), true);
assert.equal(isTerminalState("RELEASED"), true);

// allowed from OPEN
for (const a of ["UPDATE", "POSTPONE", "COMPLETE", "RELEASE"] as const) {
  assert.doesNotThrow(() => assertTransitionAllowed("OPEN", a));
}
// idempotent terminal repeats tolerated
assert.doesNotThrow(() => assertTransitionAllowed("MET", "COMPLETE"));
assert.doesNotThrow(() => assertTransitionAllowed("RELEASED", "RELEASE"));
assert.equal(isIdempotentNoop("MET", "COMPLETE"), true);
assert.equal(isIdempotentNoop("RELEASED", "RELEASE"), true);
assert.equal(isIdempotentNoop("OPEN", "COMPLETE"), false);
// blocked: mutating a terminal obligation
for (const [from, action] of [
  ["MET", "UPDATE"],
  ["MET", "RELEASE"],
  ["MET", "POSTPONE"],
  ["RELEASED", "COMPLETE"],
  ["RELEASED", "UPDATE"],
] as Array<[ObligationLifecycleState, "UPDATE" | "POSTPONE" | "COMPLETE" | "RELEASE"]>) {
  assert.throws(() => assertTransitionAllowed(from, action), /already/);
}

// --- attention predicates --------------------------------------------------

assert.equal(isBreakToday(ob({ dueAt: daysFromNow(0) }), NOW), true); // due today
assert.equal(isBreakToday(ob({ dueAt: daysFromNow(-3) }), NOW), true); // overdue
assert.equal(isBreakToday(ob({ dueAt: daysFromNow(1) }), NOW), false); // tomorrow
assert.equal(isBreakToday(ob({ dueAt: daysFromNow(0), state: "MET" }), NOW), false);

// due soon inside window needs attention
assert.equal(needsAttention(ob({ dueAt: daysFromNow(3) }), NOW, 7), true);
// outside window: silent
assert.equal(needsAttention(ob({ dueAt: daysFromNow(20) }), NOW, 7), false);
// postponed within window: suppressed
assert.equal(
  needsAttention(ob({ dueAt: daysFromNow(3), followUpAt: daysFromNow(2) }), NOW, 7),
  false
);
// but break-today overrides postponement
assert.equal(
  needsAttention(ob({ dueAt: daysFromNow(0), followUpAt: daysFromNow(5) }), NOW, 7),
  true
);

// --- deriveBriefing: the verdict -------------------------------------------

// CALM (oriented): nothing needs the owner
{
  const b = deriveBriefing(
    [ob({ dueAt: daysFromNow(20) }), ob({ dueAt: daysFromNow(40) })],
    NOW,
    { oriented: true }
  );
  assert.equal(b.state, "CALM");
  assert.equal(b.attention.length, 0);
  assert.equal(b.watching.length, 2);
  assert.equal(b.counts.open, 2);
}

// STILL_SETTLING_IN: same calm situation but NOT oriented -> never global calm
{
  const b = deriveBriefing([ob({ dueAt: daysFromNow(20) })], NOW, {
    oriented: false,
  });
  assert.equal(b.state, "STILL_SETTLING_IN");
}

// CALM allows exactly one minor attention item (oriented)
{
  const b = deriveBriefing([ob({ dueAt: daysFromNow(3) })], NOW, {
    oriented: true,
  });
  assert.equal(b.state, "CALM");
  assert.equal(b.attention.length, 1);
}

// BUSY: more than one needs attention, none break-today
{
  const b = deriveBriefing(
    [
      ob({ dueAt: daysFromNow(2) }),
      ob({ dueAt: daysFromNow(4) }),
      ob({ dueAt: daysFromNow(30) }),
    ],
    NOW,
    { oriented: true }
  );
  assert.equal(b.state, "BUSY");
  assert.equal(b.attention.length, 2);
  assert.equal(b.watching.length, 1);
}

// BUSY is honest even when NOT oriented (item-driven)
{
  const b = deriveBriefing(
    [ob({ dueAt: daysFromNow(2) }), ob({ dueAt: daysFromNow(4) })],
    NOW,
    { oriented: false }
  );
  assert.equal(b.state, "BUSY");
}

// CRITICAL: at least one break-today (overrides everything)
{
  const b = deriveBriefing(
    [ob({ dueAt: daysFromNow(0) }), ob({ dueAt: daysFromNow(4) })],
    NOW,
    { oriented: true }
  );
  assert.equal(b.state, "CRITICAL");
  assert.equal(b.counts.breakToday, 1);
  // most-consequential-first: the break-today (sooner due) leads
  assert.equal(b.attention[0]?.reason, "DUE_TODAY");
}

// CRITICAL even when not oriented
{
  const b = deriveBriefing([ob({ dueAt: daysFromNow(-1) })], NOW, {
    oriented: false,
  });
  assert.equal(b.state, "CRITICAL");
  assert.equal(b.attention[0]?.reason, "OVERDUE");
}

// ordering: overdue before due-today before due-soon; amount breaks ties
{
  const overdue = ob({ dueAt: daysFromNow(-2), amount: "50.00" });
  const today = ob({ dueAt: daysFromNow(0), amount: "50.00" });
  const soonSmall = ob({ dueAt: daysFromNow(3), amount: "10.00" });
  const soonBig = ob({ dueAt: daysFromNow(3), amount: "999.00" });
  const b = deriveBriefing([soonSmall, soonBig, today, overdue], NOW, {
    oriented: true,
  });
  const order = b.attention.map((i) => i.obligation.id);
  assert.deepEqual(order, [overdue.id, today.id, soonBig.id, soonSmall.id]);
}

// closed obligations never surface
{
  const b = deriveBriefing(
    [
      ob({ dueAt: daysFromNow(0), state: "MET" }),
      ob({ dueAt: daysFromNow(-5), state: "RELEASED" }),
    ],
    NOW,
    { oriented: true }
  );
  assert.equal(b.state, "CALM");
  assert.equal(b.counts.open, 0);
  assert.equal(b.attention.length, 0);
}

// empty + oriented = calm; empty + not oriented = still settling in
assert.equal(deriveBriefing([], NOW, { oriented: true }).state, "CALM");
assert.equal(deriveBriefing([], NOW, { oriented: false }).state, "STILL_SETTLING_IN");

// recurrence cadences referenced (type guard)
const cadences: RecurrenceCadence[] = ["NONE", "WEEKLY", "MONTHLY", "YEARLY"];
assert.equal(cadences.length, 4);

// --- integration seam: signal -> reaction contract (Integration §3/§4) -----

assert.equal(reactionFor("OBLIGATION_DISCOVERED"), "RECOGNIZE");
assert.equal(reactionFor("OWNER_CONFIRMED_HANDLED"), "CLOSE_MET");
assert.equal(reactionFor("SETTLEMENT_OBSERVED"), "CLOSE_MET");
assert.equal(reactionFor("OBLIGATION_CANCELLED_RELEASED"), "CLOSE_RELEASED");
assert.equal(reactionFor("DUE_MOMENT_CHANGED"), "UPDATE_TIMING");
assert.equal(reactionFor("CLOSURE_EVIDENCE_AVAILABLE"), "RAISE_CONFIDENCE");
assert.equal(reactionFor("CROSS_OBLIGATION_MEANING"), "ADJUST_FRAMING");
// MVP wires only the owner/manual source; everything else is deferred (§7).
assert.equal(isSourceWiredInMvp("OWNER"), true);
assert.equal(isSourceWiredInMvp("PAYMENTS"), false);
assert.equal(isSourceWiredInMvp("DOCUMENTS"), false);
assert.equal(isSourceWiredInMvp("SUPPLIERS"), false);

console.log("obligations operational-core tests: OK");
