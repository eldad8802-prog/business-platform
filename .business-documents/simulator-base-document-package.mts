/**
 * S1 (spec 11.8) — LOCAL simulator test packages for the base-document reference in D110 fields 1256/1257, to be
 * uploaded to the ITA uniform-structure simulator BY THE OWNER (as in the 2026-07-02 certification) before the
 * delivery-note number format is fixed (spec 11.5). Nothing is uploaded from here; no DB, no network.
 *
 * Starts from the certified simulator fixture (lib/services/billing/uniform/__fixtures__/uniform-sim.fixture) through
 * the EXISTING builder, unchanged, then sets 1256/1257 on the first N tax-invoice lines (1253 = 305) — the builder
 * itself leaves them empty (uniform-file-builder.ts:192-193). The application code is not changed.
 *
 *   A  1256 = 200, 1257 = "000123"     plain delivery-note number
 *   B  1256 = 200, 1257 = "N-000123"   series prefix (goods not yet sold, ניהול פנקסים s.8)
 *
 * Nothing else changes (record counts, amounts, control sums), so a simulator verdict difference between the
 * certified package and A / B is about 1256/1257 only. Output (gitignored): artifacts/uniform-sim-base-doc/<A|B>/...
 *
 * Run: npx tsx .business-documents/simulator-base-document-package.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SIM_BUILD_OPTS, SIM_FIXTURE_INPUT } from "@/lib/services/billing/uniform/__fixtures__/uniform-sim.fixture";
import { SIMULATOR_SOFTWARE_CONFIG } from "@/lib/services/billing/uniform/uniform-config";
import { encodeIso8859_8i } from "@/lib/services/billing/uniform/uniform-encoding";
import { assembleUniformExportProjection } from "@/lib/services/billing/uniform/uniform-export-assembler";
import { formatAlpha, formatNumeric } from "@/lib/services/billing/uniform/uniform-field-format";
import { buildUniformExportFiles } from "@/lib/services/billing/uniform/uniform-file-builder";
import { CRLF } from "@/lib/services/billing/uniform/uniform-serializer";

const LINES_WITH_REFERENCE = 10;
const VARIANTS = { A: "000123", B: "N-000123" } as const;
// 1.31 D110, 1-based positions: 1253 at 23-25, 1256 at 50-52, 1257 at 53-72
const at = (rec: string, from: number, to: number) => [...rec].slice(from - 1, to).join("");
const put = (rec: string, from: number, value: string) => {
  const chars = [...rec];
  chars.splice(from - 1, [...value].length, ...value);
  return chars.join("");
};

const proj = assembleUniformExportProjection(SIM_FIXTURE_INPUT);
const built = buildUniformExportFiles(proj, SIMULATOR_SOFTWARE_CONFIG, { primaryId: SIM_BUILD_OPTS.primaryId, generatedAt: SIM_BUILD_OPTS.generatedAt });
const records = built.bkmvdataText.split(CRLF);

for (const [variant, number] of Object.entries(VARIANTS)) {
  let changed = 0;
  const out = records.map((rec) => {
    if (changed >= LINES_WITH_REFERENCE || !rec.startsWith("D110") || at(rec, 23, 25) !== "305") return rec;
    if (at(rec, 50, 52).trim().replace(/^0+$/, "") !== "" || at(rec, 53, 72).trim() !== "") throw new Error("1256/1257 not empty in the certified package");
    changed++;
    const next = put(put(rec, 50, formatNumeric("200", 3)), 53, formatAlpha(number, 20));
    if ([...next].length !== [...rec].length) throw new Error("record length changed");
    return next;
  });
  if (changed !== LINES_WITH_REFERENCE) throw new Error(`only ${changed} tax-invoice lines found`);
  const text = out.join(CRLF);
  const diff = out.filter((r, i) => r !== records[i]).length;
  const dir = join(process.cwd(), "artifacts", "uniform-sim-base-doc", variant, built.meta.dirPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "INI.TXT"), built.iniBuffer); // unchanged: counts and sums do not move
  writeFileSync(join(dir, "BKMVDATA.TXT"), encodeIso8859_8i(text));
  console.log(`${variant}: 1257 = ${JSON.stringify(number)} on ${changed} D110 lines (${diff} records differ from the certified package) → ${dir}`);
}
console.log("Not uploaded. The owner uploads INI.TXT + BKMVDATA.TXT of A and of B to the ITA simulator and records each verdict.");
