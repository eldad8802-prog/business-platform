/**
 * Live ITA software-registration identity tests (run manually):
 *   npx tsx lib/services/billing/uniform/uniform-live-registration.test.ts
 *
 * Proves that the LIVE export path carries the official registration number
 * (270901) end-to-end (config → INI field 1006 → §5.4 → summary), that the
 * frozen simulator identity is untouched (00000001), and that swapping the
 * config changes NO file format, record layout, or record count.
 *
 * Pure — uses the SIM fixture projection; no DB, no network, no writes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assembleUniformExportProjection } from "@/lib/services/billing/uniform/uniform-export-assembler";
import { buildUniformExportFiles } from "@/lib/services/billing/uniform/uniform-file-builder";
import {
  buildReport54Data,
  buildSummaryData,
} from "@/lib/services/billing/uniform/uniform-report-data";
import { buildUniformReportDocDefinitions } from "@/lib/services/billing/uniform/uniform-report-render";
import {
  DUBIZ_SOFTWARE_CONFIG,
  SIMULATOR_SOFTWARE_CONFIG,
} from "@/lib/services/billing/uniform/uniform-config";
import { A000_LAYOUT } from "@/lib/services/billing/uniform/uniform-layout-1_31";
import {
  SIM_BUILD_OPTS,
  SIM_FIXTURE_INPUT,
} from "@/lib/services/billing/uniform/__fixtures__/uniform-sim.fixture";

/** Official certificate no. 270901 — "דוביז dubiz" 1.0, valid 22/07/2026–31/07/2028. */
const OFFICIAL_REGISTRATION_NUMBER = "270901";
/** Frozen simulator value from the historical 2026-07-02 "תקינה" run. */
const HISTORICAL_SIMULATOR_REGISTRATION_NUMBER = "00000001";

let failed = 0;
function ok(name: string, cond: boolean, got?: unknown): void {
  if (cond) {
    console.log(`OK: ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL: ${name}`, got !== undefined ? `(got: ${JSON.stringify(got)})` : "");
}

/** 1-based column offset of an A000 field, derived from the layout (not hardcoded). */
function a000Field(record: string, fieldId: number): string {
  let start = 1;
  for (const f of A000_LAYOUT.fields) {
    if (f.id === fieldId) return record.slice(start - 1, start - 1 + f.len);
    start += f.len;
  }
  throw new Error(`A000 field ${fieldId} not found in layout`);
}

// ---- 1. config identity ----
{
  const c = DUBIZ_SOFTWARE_CONFIG;
  ok("live 1006 = 270901", c.softwareRegistrationNumber === OFFICIAL_REGISTRATION_NUMBER, c.softwareRegistrationNumber);
  ok("live config is not the simulator", c.isSimulator === false);
  ok("live 1007 = דוביז Dubiz", c.softwareName === "דוביז Dubiz", c.softwareName);
  ok("live 1008 = 1.0", c.softwareVersion === "1.0", c.softwareVersion);
  ok("live 1009 = 312260110", c.vendorVatNumber === "312260110", c.vendorVatNumber);
  ok("live 1010 = אלדד נהרי", c.vendorName === "אלדד נהרי", c.vendorName);
}

// ---- 2. historical simulator identity stays frozen ----
{
  const s = SIMULATOR_SOFTWARE_CONFIG;
  ok(
    "simulator 1006 still 00000001 (historical run reproducible)",
    s.softwareRegistrationNumber === HISTORICAL_SIMULATOR_REGISTRATION_NUMBER,
    s.softwareRegistrationNumber
  );
  ok("simulator config still flagged isSimulator", s.isSimulator === true);
  ok("simulator 1009 unchanged (515000123)", s.vendorVatNumber === "515000123", s.vendorVatNumber);
  ok("simulator 1010 unchanged (נהרי אלדד)", s.vendorName === "נהרי אלדד", s.vendorName);
}

// ---- 3. INI.TXT field 1006 produced by the LIVE config ----
const proj = assembleUniformExportProjection(SIM_FIXTURE_INPUT);
const live = buildUniformExportFiles(proj, DUBIZ_SOFTWARE_CONFIG, {
  primaryId: SIM_BUILD_OPTS.primaryId,
  generatedAt: SIM_BUILD_OPTS.generatedAt,
});
const sim = buildUniformExportFiles(proj, SIMULATOR_SOFTWARE_CONFIG, {
  primaryId: SIM_BUILD_OPTS.primaryId,
  generatedAt: SIM_BUILD_OPTS.generatedAt,
});
const liveA000 = live.iniText.split("\r\n")[0];
const simA000 = sim.iniText.split("\r\n")[0];
{
  // NUM field, length 8 → zero-padded right-justified per spec §2.3.ה.
  ok("live INI 1006 = 00270901", a000Field(liveA000, 1006) === "00270901", a000Field(liveA000, 1006));
  ok("live INI 1007 = דוביז Dubiz", a000Field(liveA000, 1007).trim() === "דוביז Dubiz", a000Field(liveA000, 1007));
  ok("live INI 1008 = 1.0", a000Field(liveA000, 1008).trim() === "1.0", a000Field(liveA000, 1008));
  ok("live INI 1009 = 312260110", a000Field(liveA000, 1009) === "312260110", a000Field(liveA000, 1009));
  ok("live INI 1010 = אלדד נהרי", a000Field(liveA000, 1010).trim() === "אלדד נהרי", a000Field(liveA000, 1010));
  ok("historical INI 1006 still 00000001", a000Field(simA000, 1006) === "00000001", a000Field(simA000, 1006));
}

// ---- 4. §5.4 + summary render the official number ----
{
  const r54 = buildReport54Data(proj, live.meta, DUBIZ_SOFTWARE_CONFIG);
  ok("§5.4 live registration number = 270901", r54.softwareRegistrationNumber === OFFICIAL_REGISTRATION_NUMBER, r54.softwareRegistrationNumber);
  const summary = buildSummaryData(proj, live.meta, DUBIZ_SOFTWARE_CONFIG);
  ok("summary live registration number = 270901", summary.softwareRegistrationNumber === OFFICIAL_REGISTRATION_NUMBER, summary.softwareRegistrationNumber);

  const docs = JSON.stringify(buildUniformReportDocDefinitions(proj, live, DUBIZ_SOFTWARE_CONFIG));
  ok("rendered §5.4 line shows the certificate number", docs.includes(`מספר תעודת הרישום: ${OFFICIAL_REGISTRATION_NUMBER}`));
  ok("rendered summary line shows the certificate number", docs.includes(`מספר רישום: ${OFFICIAL_REGISTRATION_NUMBER}`));
  ok("no placeholder number leaks into the live reports", !docs.includes(HISTORICAL_SIMULATOR_REGISTRATION_NUMBER));

  // Historical reports keep the simulator number.
  const simDocs = JSON.stringify(buildUniformReportDocDefinitions(proj, sim, SIMULATOR_SOFTWARE_CONFIG));
  ok(
    "historical §5.4 still shows 00000001",
    simDocs.includes(`מספר תעודת הרישום: ${HISTORICAL_SIMULATOR_REGISTRATION_NUMBER}`)
  );
}

// ---- 5. no PENDING_REGISTRATION / TEMPORARY markers left on the live path ----
{
  const root = process.cwd();
  const livePathFiles = [
    join(root, "lib", "services", "billing", "uniform", "uniform-config.ts"),
    join(root, "app", "api", "reports", "uniform", "route.ts"),
  ];
  for (const file of livePathFiles) {
    const src = readFileSync(file, "utf8");
    ok(`no PENDING_REGISTRATION in ${file.slice(root.length + 1)}`, !src.includes("PENDING_REGIS" + "TRATION"));
    ok(`no TEMPORARY marker in ${file.slice(root.length + 1)}`, !/TEMPORARY/.test(src));
  }
  const configSrc = readFileSync(livePathFiles[0], "utf8");
  const liveBlock = configSrc.slice(configSrc.indexOf("export const DUBIZ_SOFTWARE_CONFIG"));
  ok("live config block no longer contains 00000001", !liveBlock.includes(HISTORICAL_SIMULATOR_REGISTRATION_NUMBER));
}

// ---- 6. format / layout / record-count regression: identity swap changes nothing else ----
{
  ok("BKMVDATA byte-identical across configs", live.bkmvdataBuffer.equals(sim.bkmvdataBuffer));
  ok("record counts unchanged", JSON.stringify(live.meta.counts) === JSON.stringify(sim.meta.counts));
  ok("total BKMVDATA records unchanged", live.meta.totalBkmvRecords === sim.meta.totalBkmvRecords);
  ok("INI byte length unchanged", live.iniBuffer.length === sim.iniBuffer.length);
  ok("INI record count unchanged", live.iniText.split("\r\n").length === sim.iniText.split("\r\n").length);
  ok("A000 record length still 466", liveA000.length === A000_LAYOUT.length, liveA000.length);

  // The ONLY differing columns are the software-identity fields 1006–1010.
  const identityIds = new Set([1006, 1007, 1008, 1009, 1010]);
  let col = 1;
  let outsideDiff = 0;
  for (const f of A000_LAYOUT.fields) {
    const a = liveA000.slice(col - 1, col - 1 + f.len);
    const b = simA000.slice(col - 1, col - 1 + f.len);
    if (a !== b && !identityIds.has(f.id)) {
      outsideDiff += 1;
      console.error(`  unexpected diff at field ${f.id}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
    col += f.len;
  }
  ok("no A000 field outside 1006–1010 changed", outsideDiff === 0, outsideDiff);
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
