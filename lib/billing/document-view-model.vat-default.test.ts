/**
 * The new-line VAT default: the standard rate in force on the day (18% from 1.1.2025, Israel time), never a
 * hard-coded 17%; 0 for an exempt dealer.
 *
 *   npx tsx lib/billing/document-view-model.vat-default.test.ts
 */
import { newEmptyLocalLine, standardVatRatePercent } from "@/lib/billing/document-view-model";

let failed = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) { console.error("FAIL:", name, got !== undefined ? `(got: ${JSON.stringify(got)})` : ""); failed += 1; return; }
  console.log("OK:", name);
}

ok("2026-11-11 → 18", standardVatRatePercent(new Date("2026-11-11T10:00:00Z")) === "18");
ok("2025-01-01 00:30 Israel time (31.12 22:30 UTC) → 18", standardVatRatePercent(new Date("2024-12-31T22:30:00Z")) === "18");
ok("2024-12-31 23:00 Israel time (21:00 UTC) → 17", standardVatRatePercent(new Date("2024-12-31T21:00:00Z")) === "17");
ok("a new line today defaults to the standard rate, not a hard-coded 17", newEmptyLocalLine({ today: new Date("2026-11-11T10:00:00Z") }).vatRatePercent === "18");
ok("the default call (no options) still works and returns today's rate", newEmptyLocalLine().vatRatePercent === standardVatRatePercent());
ok("an exempt dealer's new line defaults to 0", newEmptyLocalLine({ businessKind: "EXEMPT_DEALER" }).vatRatePercent === "0");
ok("an authorized dealer / company gets the standard rate", newEmptyLocalLine({ businessKind: "LTD_COMPANY", today: new Date("2026-11-11T10:00:00Z") }).vatRatePercent === "18");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) process.exit(1);
