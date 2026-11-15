/**
 * The new-line VAT default: the standard rate in force on the day (18% from 1.1.2025, Israel time), never a
 * hard-coded 17%; 0 for an exempt dealer.
 *
 *   npx tsx lib/billing/document-view-model.vat-default.test.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { linesAreDirty, mapServerLinesToLocal, newEmptyLocalLine, standardVatRatePercent } from "@/lib/billing/document-view-model";

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

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

// Exact boundary: midnight Israel time (IST = UTC+2 in winter) on 1.1.2025.
ok("31.12.2024 23:59:59 Israel time (21:59:59 UTC) → 17", standardVatRatePercent(new Date("2024-12-31T21:59:59Z")) === "17");
ok("1.1.2025 00:00:00 Israel time (22:00:00 UTC on 31.12) → 18", standardVatRatePercent(new Date("2024-12-31T22:00:00Z")) === "18");
ok("a date before every listed rate falls back to the oldest (17), never undefined", standardVatRatePercent(new Date("2010-01-01T12:00:00Z")) === "17");
// The exempt default is 0 on any date; an unknown kind is NOT treated as exempt (no inference from a missing value).
ok("an exempt dealer's new line is 0 before 2025 too", newEmptyLocalLine({ businessKind: "EXEMPT_DEALER", today: new Date("2024-06-01T12:00:00Z") }).vatRatePercent === "0");
ok("an unknown kind (null) gets the standard rate, not 0", newEmptyLocalLine({ businessKind: null, today: new Date("2026-11-11T10:00:00Z") }).vatRatePercent === "18");
ok("an authorized dealer gets the standard rate", newEmptyLocalLine({ businessKind: "AUTHORIZED_DEALER", today: new Date("2026-11-11T10:00:00Z") }).vatRatePercent === "18");

// Structural: no issuance / PDF / export / server billing module imports this client view model, so the default can
// never reach an issued document's frozen snapshot or a stored line except through an explicit user save.
{
  const offenders = ["lib/services/billing", "app/api/billing"].flatMap(walk)
    .filter((f) => /\.tsx?$/.test(f) && readFileSync(f, "utf8").includes("billing/document-view-model"));
  ok("no server billing module (lib/services/billing, app/api/billing) imports the draft view model", offenders.length === 0, offenders);
}

// #1111 owner-approved screen wiring (focused A0 exception): all three kinds, and where the kind comes from.
ok("a company (LTD_COMPANY) gets the standard rate", newEmptyLocalLine({ businessKind: "LTD_COMPANY", today: new Date("2026-11-11T10:00:00Z") }).vatRatePercent === "18");
ok("an authorized dealer on 31.12.2024 gets 17 (the rate follows the date, not the kind)", newEmptyLocalLine({ businessKind: "AUTHORIZED_DEALER", today: new Date("2024-12-31T12:00:00Z") }).vatRatePercent === "17");
{
  const page = readFileSync("app/billing/[id]/page.tsx", "utf8");
  ok("the screen never builds a new line without the kind (no bare newEmptyLocalLine())", !page.includes("newEmptyLocalLine()"));
  ok("the screen passes the kind to the new line", page.includes("newEmptyLocalLine({ businessKind })"));
  ok("the kind comes from the server (GET /api/billing/invoice-profile → profile.billingBusinessKind)",
    page.includes('newLineKindRef.current ??= fetch("/api/billing/invoice-profile"') && page.includes("j?.profile?.billingBusinessKind"));
  ok("a failed read gives null (standard rate), never an inferred exempt kind", page.slice(page.indexOf("newLineKindRef.current ??="), page.indexOf("return newLineKindRef.current")).includes(".catch(() => null)"));
  ok("the kind is not read from the URL, query or form", !page.split(/\r?\n/).some((l) => l.includes("businessKind") && l.includes("searchParams")));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) process.exit(1);
