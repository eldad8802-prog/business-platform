/**
 * jerusalemMonthUtcHalfOpen — run:
 *   npx tsx lib/utils/jerusalem-month-range.verify.test.ts
 *
 * Guards the #658 P2028 fix. The function's contract is unchanged: `from` is
 * the EARLIEST instant whose Israeli date is the 1st of the month, and
 * `toExclusive` is the same for the next month. It used to find those by a
 * minute-by-minute scan (2–6 s cold); it now resolves them in O(1). This file
 * proves the contract by its definition, pins known values across both DST
 * shifts, and keeps a cold call far inside the 5000 ms transaction budget.
 */
import { dateKeyJerusalem, jerusalemMonthUtcHalfOpen } from "./jerusalem-month-range";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

/* ---- speed: a cold call (nothing cached for this month) ---- */
{
  const t0 = performance.now();
  jerusalemMonthUtcHalfOpen("2031-07");
  jerusalemMonthUtcHalfOpen("2031-06");
  const ms = performance.now() - t0;
  // The old scan took 2–6 s per call. 250 ms leaves room for a slow CI box
  // while still failing loudly if a scan ever comes back.
  ok(`two cold month ranges resolve in under 250 ms (took ${ms.toFixed(1)} ms)`, ms < 250, ms);
}

/* ---- contract, by definition, for every month 2015–2035 ---- */
{
  let bad = 0;
  for (let y = 2015; y <= 2035; y++) {
    for (let m = 1; m <= 12; m++) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      const { from, toExclusive } = jerusalemMonthUtcHalfOpen(key);
      const fromOk =
        dateKeyJerusalem(from) === `${key}-01` && dateKeyJerusalem(new Date(from.getTime() - 1)) !== `${key}-01`;
      const toOk =
        dateKeyJerusalem(toExclusive) === `${next}-01` &&
        dateKeyJerusalem(new Date(toExclusive.getTime() - 1)) !== `${next}-01`;
      if (!fromOk || !toOk) {
        bad += 1;
        console.error("contract broken for", key, from.toISOString(), toExclusive.toISOString());
      }
    }
  }
  ok("every month 2015–2035: from/toExclusive are the earliest instants of the 1st", bad === 0, bad);
}

/* ---- pinned values (computed by the previous scan implementation) ---- */
const pinned: Array<[string, string, string]> = [
  // winter (UTC+2) → winter
  ["2026-01", "2025-12-31T22:00:00.000Z", "2026-01-31T22:00:00.000Z"],
  // month that contains the spring shift (starts UTC+2, ends UTC+3)
  ["2026-03", "2026-02-28T22:00:00.000Z", "2026-03-31T21:00:00.000Z"],
  // summer (UTC+3) → summer
  ["2026-09", "2026-08-31T21:00:00.000Z", "2026-09-30T21:00:00.000Z"],
  // month that contains the autumn shift (starts UTC+3, ends UTC+2)
  ["2026-10", "2026-09-30T21:00:00.000Z", "2026-10-31T22:00:00.000Z"],
  // year boundary
  ["2026-12", "2026-11-30T22:00:00.000Z", "2026-12-31T22:00:00.000Z"],
];
for (const [key, from, to] of pinned) {
  const r = jerusalemMonthUtcHalfOpen(key);
  ok(`${key} = [${from}, ${to})`, r.from.toISOString() === from && r.toExclusive.toISOString() === to, [r.from.toISOString(), r.toExclusive.toISOString()]);
}

/* ---- input validation unchanged ---- */
for (const badKey of ["2026-13", "2026-00", "26-01", "2026/01", ""]) {
  let threw = false;
  try {
    jerusalemMonthUtcHalfOpen(badKey);
  } catch {
    threw = true;
  }
  ok(`rejects "${badKey}"`, threw);
}

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll jerusalem-month-range tests passed.");
