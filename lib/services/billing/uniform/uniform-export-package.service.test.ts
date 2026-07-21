/**
 * Tests for the live uniform-export packaging (run manually):
 *   npx tsx lib/services/billing/uniform/uniform-export-package.service.test.ts
 *
 * Pure — uses the SIM fixture projection; no DB/network. Does NOT touch the
 * existing simulator script or its config.
 */
import {
  buildUniformExportZip,
  makePrimaryId,
  parseUniformExportRange,
  UNIFORM_ZIP_ENTRIES,
} from "@/lib/services/billing/uniform/uniform-export-package.service";
import { assembleUniformExportProjection } from "@/lib/services/billing/uniform/uniform-export-assembler";
import { buildUniformExportFiles } from "@/lib/services/billing/uniform/uniform-file-builder";
import {
  buildReport26Data,
  buildReport54Data,
} from "@/lib/services/billing/uniform/uniform-report-data";
import { SIMULATOR_SOFTWARE_CONFIG } from "@/lib/services/billing/uniform/uniform-config";
import {
  SIM_BUILD_OPTS,
  SIM_FIXTURE_INPUT,
} from "@/lib/services/billing/uniform/__fixtures__/uniform-sim.fixture";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}

async function main() {
  // ---- parseUniformExportRange ----
  {
    const r = parseUniformExportRange("2026-07-01", "2026-07-31");
    ok("valid range parses", r.ok === true);
    ok("start is inclusive midnight", r.ok && r.range.periodStart === "2026-07-01T00:00:00.000Z");
    ok("end is inclusive end-of-day", r.ok && r.range.periodEnd === "2026-07-31T23:59:59.999Z");
  }
  ok("missing from → error", parseUniformExportRange(null, "2026-07-31").ok === false);
  ok("bad format → INVALID_DATE_FORMAT", (() => { const r = parseUniformExportRange("2026/07/01", "2026-07-31"); return !r.ok && r.error === "INVALID_DATE_FORMAT"; })());
  ok("inverted range → RANGE_INVERTED", (() => { const r = parseUniformExportRange("2026-08-01", "2026-07-31"); return !r.ok && r.error === "RANGE_INVERTED"; })());
  ok("primaryId is 15 digits", /^[0-9]{15}$/.test(makePrimaryId(1_753_000_000_000)));

  // ---- projection + build ----
  const proj = assembleUniformExportProjection(SIM_FIXTURE_INPUT);
  const built = buildUniformExportFiles(proj, SIMULATOR_SOFTWARE_CONFIG, {
    primaryId: SIM_BUILD_OPTS.primaryId,
    generatedAt: SIM_BUILD_OPTS.generatedAt,
  });

  // ---- §2.6: all official document types incl. zeros; sums; C100 reconciliation ----
  const r26 = buildReport26Data(proj, built.meta);
  const codes = new Set(r26.rows.map((row) => row.code));
  ok("§2.6 includes 305", codes.has("305"));
  ok("§2.6 includes 320", codes.has("320"));
  ok("§2.6 includes 330 (credit) as its own type", codes.has("330"));
  ok("§2.6 includes 400", codes.has("400"));
  ok("§2.6 lists ALL appendix types (>4 rows, zeros for unmanaged)", r26.rows.length > 4);
  ok("§2.6 has zero-count rows for unmanaged types", r26.rows.some((row) => row.count === 0));
  ok("§2.6 every row has a money sum string", r26.rows.every((row) => typeof row.sumInclVat === "string"));
  // C100 reconciliation: Σ row counts == totalCount == C100 records written
  const sumCounts = r26.rows.reduce((a, row) => a + row.count, 0);
  ok("§2.6 Σ counts == totalCount", sumCounts === r26.totalCount);
  ok("§2.6 totalCount == C100 record count", r26.totalCount === built.meta.counts.C100);

  // ---- §5.4: only record types actually produced; NO artificial M100/B100 ----
  const r54 = buildReport54Data(proj, built.meta, SIMULATOR_SOFTWARE_CONFIG);
  const recCodes = new Set(r54.recordRows.map((row) => row.code));
  ok("§5.4 success message present", r54.constMessage.length > 0);
  ok("§5.4 business + vat present", r54.businessName.length > 0 && r54.vatNumber.length > 0);
  ok("§5.4 includes A100 + Z900", recCodes.has("A100") && recCodes.has("Z900"));
  ok("§5.4 includes C100 (documents produced)", recCodes.has("C100"));
  ok("§5.4 every shown record type has count > 0", r54.recordRows.every((row) => row.count > 0));
  ok("§5.4 software name + version present", r54.softwareName.length > 0);
  ok("§5.4 date + time present", r54.generatedDate.length > 0 && r54.generatedTime.length > 0);

  // ---- dedicated M100: Dubiz's export produces NO inventory (M100) records ----
  ok("§5.4 shows NO M100 row (no inventory records produced)", !recCodes.has("M100"));
  ok("§5.4 shows NO B100 row (no journal records produced)", !recCodes.has("B100"));
  ok("build meta has no M100 count key", !("M100" in (built.meta.counts as Record<string, unknown>)));

  // ---- ZIP contains exactly the six expected entries ----
  const zipResult = await buildUniformExportZip(proj, SIMULATOR_SOFTWARE_CONFIG, {
    primaryId: SIM_BUILD_OPTS.primaryId,
    generatedAt: SIM_BUILD_OPTS.generatedAt,
  });
  ok("zip buffer is non-empty", zipResult.zip.length > 0);
  const zipText = zipResult.zip.toString("latin1");
  for (const entry of UNIFORM_ZIP_ENTRIES) {
    ok(`zip contains ${entry}`, zipText.includes(entry));
  }
  ok("entries list matches the six expected", zipResult.entries.length === 6);

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
