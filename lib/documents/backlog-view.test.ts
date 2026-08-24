/**
 * Documents inbox backlog-vs-month helpers (Wave 3 · F-21). Run:
 *   npx tsx lib/documents/backlog-view.test.ts
 *
 * Guards the pure logic behind the fix: when the all-time backlog exceeds the
 * selected month's queue, the UI must disclose it (banner), offer a real jump
 * target (CTA month), keep every backlog month reachable (selector options),
 * and never render a bare global empty-state. Also pins Jerusalem month
 * bucketing across a day/month boundary.
 */
import {
  buildMonthOptions,
  computeOlderBacklog,
  emptyMonthCopy,
  pickBacklogCtaMonth,
} from "./backlog-view";
import { distinctMonthsDescending } from "./pending-review";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

// --- computeOlderBacklog (banner condition) -------------------------------
{
  const a = computeOlderBacklog({ totalPending: 72, monthPending: 0 });
  ok("72/0 → banner shows, 72 older", a.show && a.olderCount === 72, a);

  const b = computeOlderBacklog({ totalPending: 72, monthPending: 72 });
  ok("72/72 → no banner (all in month)", !b.show && b.olderCount === 0, b);

  const c = computeOlderBacklog({ totalPending: 10, monthPending: 3 });
  ok("10/3 → banner shows, 7 older", c.show && c.olderCount === 7, c);

  const d = computeOlderBacklog({ totalPending: 0, monthPending: 0 });
  ok("0/0 → no banner", !d.show && d.olderCount === 0, d);

  // Defensive: month can never exceed total → clamp, never negative.
  const e = computeOlderBacklog({ totalPending: 3, monthPending: 5 });
  ok("3/5 → clamped, no banner", !e.show && e.olderCount === 0, e);
}

// --- pickBacklogCtaMonth (jump target) ------------------------------------
{
  ok(
    "cta: newest OTHER pending month, viewing current",
    pickBacklogCtaMonth(["2026-05", "2026-04"], "2026-08") === "2026-05",
    pickBacklogCtaMonth(["2026-05", "2026-04"], "2026-08")
  );
  ok(
    "cta: skips the selected month",
    pickBacklogCtaMonth(["2026-08", "2026-05"], "2026-08") === "2026-05",
    pickBacklogCtaMonth(["2026-08", "2026-05"], "2026-08")
  );
  ok(
    "cta: null when the only pending month is the selected one",
    pickBacklogCtaMonth(["2026-08"], "2026-08") === null,
    pickBacklogCtaMonth(["2026-08"], "2026-08")
  );
  ok("cta: null when no pending months", pickBacklogCtaMonth([], "2026-08") === null);
}

// --- buildMonthOptions (selector) -----------------------------------------
{
  const opts = buildMonthOptions("2026-08", ["2026-05", "2026-04"]);
  ok(
    "options: current + backlog, newest-first",
    JSON.stringify(opts) === JSON.stringify(["2026-08", "2026-05", "2026-04"]),
    opts
  );

  const dedup = buildMonthOptions("2026-08", ["2026-08", "2026-05"]);
  ok(
    "options: current month never duplicated",
    JSON.stringify(dedup) === JSON.stringify(["2026-08", "2026-05"]),
    dedup
  );

  const onlyCurrent = buildMonthOptions("2026-08", []);
  ok(
    "options: current alone when no backlog",
    JSON.stringify(onlyCurrent) === JSON.stringify(["2026-08"]),
    onlyCurrent
  );
}

// --- emptyMonthCopy (no bare global claim) --------------------------------
{
  ok(
    "empty copy names the month",
    emptyMonthCopy("אוגוסט 2026") === "אין מסמכים שממתינים לאימות באוגוסט 2026",
    emptyMonthCopy("אוגוסט 2026")
  );
  ok(
    "empty copy falls back to 'selected month', never global",
    emptyMonthCopy("") === "אין מסמכים שממתינים לאימות בחודש הנבחר",
    emptyMonthCopy("")
  );
}

// --- distinctMonthsDescending across a Jerusalem day/month boundary -------
{
  // Summer (IDT = UTC+3): 21:30Z on Jul 31 is 00:30 Aug 1 in Jerusalem.
  const crossesToAugust = new Date("2026-07-31T21:30:00Z");
  // 20:30Z on Jul 31 is 23:30 Jul 31 in Jerusalem — stays July.
  const staysJuly = new Date("2026-07-31T20:30:00Z");
  const alsoAugust = new Date("2026-08-15T09:00:00Z");

  const months = distinctMonthsDescending([
    staysJuly,
    crossesToAugust,
    alsoAugust,
  ]);
  ok(
    "jerusalem boundary bucketed + deduped + desc",
    JSON.stringify(months) === JSON.stringify(["2026-08", "2026-07"]),
    months
  );

  ok("empty input → empty months", distinctMonthsDescending([]).length === 0);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll backlog-view assertions passed");
