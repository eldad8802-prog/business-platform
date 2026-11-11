/**
 * The new-line VAT default: the standard rate in force on the day (18% from 1.1.2025, Israel time), never a
 * hard-coded 17%; 0 for an exempt dealer.
 *
 *   npx tsx lib/billing/document-view-model.vat-default.test.ts
 */
import { linesAreDirty, mapServerLinesToLocal, newEmptyLocalLine, standardVatRatePercent } from "@/lib/billing/document-view-model";

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

// Charge date around 1.1.2025: the default follows the day the line is ADDED (the draft is issued at or after it,
// so the charge event cannot precede it). Only a default; the user may edit it and the server validates.
ok("a line added on 31.12.2024 (Israel time) defaults to 17", newEmptyLocalLine({ today: new Date("2024-12-31T12:00:00Z") }).vatRatePercent === "17");
ok("a line added on 1.1.2025 (Israel time) defaults to 18", newEmptyLocalLine({ today: new Date("2025-01-01T08:00:00Z") }).vatRatePercent === "18");

// Reopening a draft: saved lines keep their saved rate — the default never touches them.
const saved = [
  { id: 11, description: "שירות מ־2024", quantity: "1", unitPrice: "100", vatRatePercent: "17" },
  { id: 12, description: "שירות ב־0%", quantity: "1", unitPrice: "50", vatRatePercent: "0" },
] as unknown as Parameters<typeof mapServerLinesToLocal>[0];
const reopened = mapServerLinesToLocal(saved);
ok("reopening keeps a saved 17% line at 17 (not overwritten by today's 18)", reopened[0].vatRatePercent === "17");
ok("reopening keeps a saved 0% line at 0", reopened[1].vatRatePercent === "0");
ok("an unchanged reopened draft is not dirty (nothing to save, nothing silently rewritten)", !linesAreDirty(reopened, saved));
const withNew = [...reopened, newEmptyLocalLine({ today: new Date("2026-11-11T10:00:00Z") })];
ok("adding a line to the reopened draft: only the NEW line takes 18, the saved ones stay",
  withNew[0].vatRatePercent === "17" && withNew[1].vatRatePercent === "0" && withNew[2].vatRatePercent === "18");
// An issued document is never mapped through the editable draft lines: its PDF and export read the frozen
// issuedSnapshot (billing-issue.service.ts), which this module does not touch.

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) process.exit(1);
