/**
 * Unit test — previous-calendar-month string computation.
 * Run: npx tsx lib/documents/previous-year-month.test.ts
 */
import assert from "node:assert/strict";
import { previousYearMonth } from "@/lib/documents/previous-year-month";

function main() {
  // January rolls back to December of the previous year.
  assert.equal(previousYearMonth("2026-01"), "2025-12", "Jan → prev-year Dec");

  // Ordinary within-year months.
  assert.equal(previousYearMonth("2026-07"), "2026-06", "Jul → Jun");
  assert.equal(previousYearMonth("2026-12"), "2026-11", "Dec → Nov");
  assert.equal(previousYearMonth("2026-03"), "2026-02", "Mar → Feb (zero-padded)");

  console.log("previous-year-month.test.ts: ok");
}

main();
