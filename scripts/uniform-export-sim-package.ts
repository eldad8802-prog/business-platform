/**
 * WP4 — LOCAL simulator test-package generator.
 *
 *   npx tsx scripts/uniform-export-sim-package.ts
 *
 * Orchestration ONLY over committed WP1/WP2/WP3 code — no new export logic.
 * NO DB / Prisma / env / network / upload. Output goes to a gitignored dir:
 *   artifacts/uniform-sim/OPENFRMT/<vat8>.<yy>/<mmddhhmm>/
 *     INI.TXT, BKMVDATA.zip, report-2.6.pdf, report-5.4.pdf, summary.pdf
 *
 * It also runs an in-memory sanity pass (record lengths + control sums) before
 * writing. This produces a package; it does NOT upload to the ITA simulator.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { assembleUniformExportProjection } from "@/lib/services/billing/uniform/uniform-export-assembler";
import { SIMULATOR_SOFTWARE_CONFIG } from "@/lib/services/billing/uniform/uniform-config";
import { buildUniformExportFiles } from "@/lib/services/billing/uniform/uniform-file-builder";
import {
  A000_LAYOUT,
  A100_LAYOUT,
  B110_LAYOUT,
  C100_LAYOUT,
  D110_LAYOUT,
  D120_LAYOUT,
  INI_SUMMARY_LAYOUT,
  Z900_LAYOUT,
} from "@/lib/services/billing/uniform/uniform-layout-1_31";
import { writeUniformExport } from "@/lib/services/billing/uniform/uniform-packaging";
import { renderUniformReports } from "@/lib/services/billing/uniform/uniform-report-render";
import { SIM_BUILD_OPTS, SIM_FIXTURE_INPUT } from "@/lib/services/billing/uniform/__fixtures__/uniform-sim.fixture";

const ROOT_DIR = join(process.cwd(), "artifacts", "uniform-sim");

/** Expected serialized length per BKMVDATA record type — sourced from the 1.31 layouts. */
const EXPECTED_LEN: Record<string, number> = Object.fromEntries(
  [A100_LAYOUT, B110_LAYOUT, C100_LAYOUT, D110_LAYOUT, D120_LAYOUT, Z900_LAYOUT].map((l) => [l.code, l.length])
);
const A000_LEN = A000_LAYOUT.length;
const INI_SUMMARY_LEN = INI_SUMMARY_LAYOUT.length;

function sanity(iniText: string, bkmvdataText: string, meta: { totalBkmvRecords: number; counts: { B110: number; C100: number; D110: number; D120: number } }): string[] {
  const problems: string[] = [];

  // Every BKMVDATA line: CRLF-terminated, code known, length exact.
  const lines = bkmvdataText.split("\r\n").filter((l) => l.length > 0);
  const seen: Record<string, number> = {};
  for (const line of lines) {
    const code = line.slice(0, 4);
    seen[code] = (seen[code] ?? 0) + 1;
    const exp = EXPECTED_LEN[code];
    if (exp === undefined) {
      problems.push(`unknown record code "${code}"`);
    } else if (line.length !== exp) {
      problems.push(`${code} length ${line.length} != expected ${exp}`);
    }
  }
  if (!bkmvdataText.endsWith("\r\n")) problems.push("BKMVDATA does not end with CRLF");

  // Record-count reconciliation: A100 + C100 + D110 + D120 + Z900 == totalBkmvRecords.
  const total = Object.values(seen).reduce((a, b) => a + b, 0);
  if (total !== meta.totalBkmvRecords) problems.push(`record total ${total} != meta.totalBkmvRecords ${meta.totalBkmvRecords}`);
  if ((seen.B110 ?? 0) !== meta.counts.B110) problems.push(`B110 ${seen.B110 ?? 0} != meta ${meta.counts.B110}`);
  if ((seen.C100 ?? 0) !== meta.counts.C100) problems.push(`C100 ${seen.C100 ?? 0} != meta ${meta.counts.C100}`);
  if ((seen.D110 ?? 0) !== meta.counts.D110) problems.push(`D110 ${seen.D110 ?? 0} != meta ${meta.counts.D110}`);
  if ((seen.D120 ?? 0) !== meta.counts.D120) problems.push(`D120 ${seen.D120 ?? 0} != meta ${meta.counts.D120}`);
  if ((seen.A100 ?? 0) !== 1) problems.push(`A100 count ${seen.A100 ?? 0} != 1`);
  if ((seen.Z900 ?? 0) !== 1) problems.push(`Z900 count ${seen.Z900 ?? 0} != 1`);

  // INI = A000 (466) + one 19-char summary per PRESENT data record-type (B110/C100/D110/D120).
  const iniLines = iniText.split("\r\n").filter((l) => l.length > 0);
  const expectedSummaries = [meta.counts.B110, meta.counts.C100, meta.counts.D110, meta.counts.D120].filter((c) => c > 0).length;
  const expectedIniLines = 1 + expectedSummaries;
  if (iniLines.length !== expectedIniLines) {
    problems.push(`INI.TXT has ${iniLines.length} lines (expected ${expectedIniLines}: A000 + ${expectedSummaries} summaries)`);
  } else {
    if (iniLines[0].length !== A000_LEN) problems.push(`A000 length ${iniLines[0].length} != ${A000_LEN}`);
    for (let i = 1; i < iniLines.length; i++) {
      if (iniLines[i].length !== INI_SUMMARY_LEN) problems.push(`INI summary line ${i} length ${iniLines[i].length} != ${INI_SUMMARY_LEN}`);
    }
  }
  if (!iniText.endsWith("\r\n")) problems.push("INI.TXT does not end with CRLF");

  return problems;
}

async function main() {
  console.log("WP4 — generating LOCAL simulator test package (no upload)\n");

  // WP1: pure assembly.
  const proj = assembleUniformExportProjection(SIM_FIXTURE_INPUT);
  console.log(`WP1 projection: ${proj.documentRecords.length} docs, ${proj.lineRecords.length} lines, ${proj.paymentRecords.length} payments`);
  console.log(`  byDocumentType: ${JSON.stringify(proj.totals.byDocumentType)}`);
  console.log(`  sumTotal=${proj.totals.sumTotal}  sumVat=${proj.totals.sumVat}`);
  if (proj.warnings.length) console.log(`  warnings: ${proj.warnings.map((w) => w.code).join(", ")}`);
  if (proj.excluded.length) console.log(`  excluded: ${proj.excluded.length}`);

  // WP2: build files (deterministic).
  const built = buildUniformExportFiles(proj, SIMULATOR_SOFTWARE_CONFIG, {
    primaryId: SIM_BUILD_OPTS.primaryId,
    generatedAt: SIM_BUILD_OPTS.generatedAt,
  });
  console.log(`\nWP2 build: ${built.meta.totalBkmvRecords} BKMVDATA records (B110=${built.meta.counts.B110} C100=${built.meta.counts.C100} D110=${built.meta.counts.D110} D120=${built.meta.counts.D120})`);
  console.log(`  path: ${built.meta.dirPath}`);

  // Sanity BEFORE writing.
  const problems = sanity(built.iniText, built.bkmvdataText, built.meta);
  if (problems.length) {
    console.error("\nSANITY FAILED:");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log("  sanity: OK (record codes/lengths/CRLF + control counts)");

  // WP2 packaging: writes INI.TXT + BKMVDATA.TXT + BKMVDATA.zip.
  const written = await writeUniformExport(ROOT_DIR, built);

  // WP3: render the three registration reports into the same dir.
  const pdfs = await renderUniformReports(proj, built, SIMULATOR_SOFTWARE_CONFIG);
  const p26 = join(written.outputDir, "report-2.6.pdf");
  const p54 = join(written.outputDir, "report-5.4.pdf");
  const psum = join(written.outputDir, "summary.pdf");
  writeFileSync(p26, pdfs.report26Pdf);
  writeFileSync(p54, pdfs.report54Pdf);
  writeFileSync(psum, pdfs.summaryPdf);

  console.log("\nPackage written:");
  console.log("  dir : " + written.outputDir);
  console.log("  " + written.iniPath);
  console.log("  " + written.bkmvdataTxtPath + ` (${built.bkmvdataBuffer.length} bytes)`);
  console.log("  " + written.bkmvdataZipPath);
  console.log(`  ${p26} (${pdfs.report26Pdf.length} bytes)`);
  console.log(`  ${p54} (${pdfs.report54Pdf.length} bytes)`);
  console.log(`  ${psum} (${pdfs.summaryPdf.length} bytes)`);
  console.log("\nDone. NOT uploaded to the simulator.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
