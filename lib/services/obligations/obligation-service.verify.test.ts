/**
 * WP3/WP7 verification for the Business Obligation application services.
 * Run with: npx tsx lib/services/obligations/obligation-service.verify.test.ts
 * (or: npm run verify:obligations-service)
 *
 * Uses the in-memory store — no database.
 */
import assert from "node:assert/strict";
import { createInMemoryObligationStore } from "./obligation-store.memory";
import {
  completeObligation,
  getBriefing,
  listObligations,
  markOriented,
  recognizeObligation,
  releaseObligation,
  snoozeObligation,
  updateObligation,
  type ObligationServiceDeps,
} from "./obligation.service";

const NOW = new Date(2026, 5, 30, 9, 0, 0);
let seriesSeq = 0;

function makeDeps(): ObligationServiceDeps {
  return {
    store: createInMemoryObligationStore(() => NOW),
    now: () => NOW,
    attentionWindowDays: 7,
    newSeriesId: () => `series-${++seriesSeq}`,
  };
}

function daysFromNow(n: number): Date {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + n);
}

async function main() {
// --- recognize + validation ------------------------------------------------

await (async () => {
  const deps = makeDeps();
  const o = await recognizeObligation(
    {
      businessId: 1,
      obligeeName: "  Landlord  ",
      amount: "9000",
      dueAt: daysFromNow(10),
      recurrence: "MONTHLY",
    },
    deps
  );
  assert.equal(o.obligeeName, "Landlord"); // trimmed
  assert.equal(o.amount, "9000.00"); // normalized
  assert.equal(o.currency, "ILS"); // default
  assert.equal(o.state, "OPEN");
  assert.equal(o.source, "MANUAL");
  assert.equal(o.recurrence, "MONTHLY");
  assert.ok(o.recurrenceSeriesId, "recurring obligation gets a series id");

  // one-off has no series id
  const oneOff = await recognizeObligation(
    { businessId: 1, obligeeName: "Accountant", amount: 1200, dueAt: daysFromNow(3) },
    deps
  );
  assert.equal(oneOff.recurrenceSeriesId, null);
  assert.equal(oneOff.recurrence, "NONE");

  // validation failures
  await assert.rejects(
    recognizeObligation(
      { businessId: 1, obligeeName: "", amount: 100, dueAt: daysFromNow(1) },
      deps
    ),
    /obligeeName is required/
  );
  await assert.rejects(
    recognizeObligation(
      { businessId: 1, obligeeName: "X", amount: -5, dueAt: daysFromNow(1) },
      deps
    ),
    /positive/
  );
  await assert.rejects(
    recognizeObligation(
      { businessId: 1, obligeeName: "X", amount: 5, dueAt: new Date("nope") },
      deps
    ),
    /valid date/
  );
})();

// --- businessId isolation --------------------------------------------------

await (async () => {
  const deps = makeDeps();
  const mine = await recognizeObligation(
    { businessId: 1, obligeeName: "Mine", amount: 100, dueAt: daysFromNow(2) },
    deps
  );
  // another tenant cannot see or mutate it
  assert.equal(await deps.store.findObligationById(2, mine.id), null);
  await assert.rejects(
    completeObligation(2, mine.id, deps),
    /not found/i
  );
  await assert.rejects(updateObligation(2, mine.id, { amount: 5 }, deps), /not found/i);
})();

// --- complete (owner-asserted) + recurrence regeneration -------------------

await (async () => {
  const deps = makeDeps();
  const rent = await recognizeObligation(
    {
      businessId: 1,
      obligeeName: "Landlord",
      amount: 9000,
      dueAt: new Date(2026, 5, 1), // June 1
      recurrence: "MONTHLY",
    },
    deps
  );
  const result = await completeObligation(1, rent.id, deps);
  assert.equal(result.obligation.state, "MET");
  assert.equal(result.obligation.settlementAssertedBy, "OWNER");
  assert.ok(result.obligation.metAt);
  // next instance recognized, same series, next month
  assert.ok(result.nextInstance, "recurring -> next instance recognized");
  assert.equal(result.nextInstance!.state, "OPEN");
  assert.equal(
    result.nextInstance!.recurrenceSeriesId,
    rent.recurrenceSeriesId
  );
  assert.deepEqual(result.nextInstance!.dueAt, new Date(2026, 6, 1)); // July 1

  // idempotent: completing again is a no-op, no second next instance
  const again = await completeObligation(1, rent.id, deps);
  assert.equal(again.obligation.state, "MET");
  assert.equal(again.nextInstance, null);
})();

// --- complete a one-off -> no next instance --------------------------------

await (async () => {
  const deps = makeDeps();
  const o = await recognizeObligation(
    { businessId: 1, obligeeName: "Accountant", amount: 1200, dueAt: daysFromNow(1) },
    deps
  );
  const result = await completeObligation(1, o.id, deps);
  assert.equal(result.obligation.state, "MET");
  assert.equal(result.nextInstance, null);
})();

// --- release stops the series; cannot then complete ------------------------

await (async () => {
  const deps = makeDeps();
  const o = await recognizeObligation(
    { businessId: 1, obligeeName: "Old supplier", amount: 500, dueAt: daysFromNow(5), recurrence: "MONTHLY" },
    deps
  );
  const released = await releaseObligation(1, o.id, deps);
  assert.equal(released.state, "RELEASED");
  assert.ok(released.releasedAt);
  // idempotent release
  const again = await releaseObligation(1, o.id, deps);
  assert.equal(again.state, "RELEASED");
  // cannot complete a released obligation
  await assert.rejects(completeObligation(1, o.id, deps), /already released/i);
  // releasing did NOT spawn a next instance
  const all = await listObligations(1, deps, { includeClosed: true });
  assert.equal(all.length, 1);
})();

// --- snooze suppresses from attention, future-only -------------------------

await (async () => {
  const deps = makeDeps();
  const o = await recognizeObligation(
    { businessId: 1, obligeeName: "Insurance", amount: 800, dueAt: daysFromNow(4) },
    deps
  );
  await assert.rejects(
    snoozeObligation(1, o.id, daysFromNow(-1), deps),
    /future/
  );
  const snoozed = await snoozeObligation(1, o.id, daysFromNow(3), deps);
  assert.deepEqual(snoozed.followUpAt, daysFromNow(3));

  // oriented business; with the only near item snoozed -> CALM
  await markOriented(1, deps);
  const briefing = await getBriefing(1, deps);
  assert.equal(briefing.state, "CALM");
  assert.equal(briefing.attention.length, 0);
  assert.equal(briefing.watching.length, 1);
})();

// --- briefing integration: not oriented -> STILL_SETTLING_IN ---------------

await (async () => {
  const deps = makeDeps();
  await recognizeObligation(
    { businessId: 7, obligeeName: "Far", amount: 100, dueAt: daysFromNow(40) },
    deps
  );
  const before = await getBriefing(7, deps);
  assert.equal(before.state, "STILL_SETTLING_IN");
  await markOriented(7, deps);
  const after = await getBriefing(7, deps);
  assert.equal(after.state, "CALM");
})();

// --- briefing: break-today -> CRITICAL -------------------------------------

await (async () => {
  const deps = makeDeps();
  await markOriented(3, deps);
  await recognizeObligation(
    { businessId: 3, obligeeName: "Salaries", amount: 38000, dueAt: daysFromNow(0) },
    deps
  );
  const b = await getBriefing(3, deps);
  assert.equal(b.state, "CRITICAL");
  assert.equal(b.attention[0]?.reason, "DUE_TODAY");
})();

  console.log("obligations application-service tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
