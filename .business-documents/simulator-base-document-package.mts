/**
 * S1 (spec 11.8) — LOCAL simulator test packages for the base-document reference (D110 fields 1256/1257), to be
 * uploaded to the ITA uniform-structure simulator BY THE OWNER, as in the 2026-07-02 certification, before the
 * delivery-note number format is fixed (spec 11.5). Nothing is uploaded from here; no DB, no network.
 *
 * Spec 1.31 (quoted in the spec doc, chapter 11.8): 1256/1257 are "ח/ר — חובה כאשר המסמך מבוסס על מסמך אחר"
 * (clarification 6: an invoice that "closed" a delivery note names it as its base document). The spec does not say
 * the base document must also be in the file; delivery notes Dubiz produces would be (they are chapter-ב documents),
 * so packages D/A/B carry them.
 *
 * All four start from the certified simulator fixture through the EXISTING builder, unchanged:
 *   C  the certified package itself, byte for byte (control; passed the simulator on 2026-07-02 — hashes pinned)
 *   D  C + 5 of its tax invoices turned into delivery notes (C100 1203 / D110 1253 = 200), NO references
 *   A  D + one later tax invoice of the same customer per delivery note names it: 1256 = 200, 1257 = its number
 *   B  as A, but every delivery-note number carries the series prefix "N-" — on the note itself (C100 1204,
 *      D110 1254) and in the references (1257)
 * Record counts, amounts and control sums are identical in all four. A and B are checked to differ ONLY in the
 * number fields of the delivery notes and of the referencing lines.
 *
 * Output (gitignored): artifacts/uniform-sim-base-doc/<C|D|A|B>/OPENFRMT/... + SHA256SUMS + README-he.md.
 * Run: npx tsx .business-documents/simulator-base-document-package.mts
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SIM_BUILD_OPTS, SIM_FIXTURE_INPUT } from "@/lib/services/billing/uniform/__fixtures__/uniform-sim.fixture";
import { SIMULATOR_SOFTWARE_CONFIG } from "@/lib/services/billing/uniform/uniform-config";
import { encodeIso8859_8i } from "@/lib/services/billing/uniform/uniform-encoding";
import { assembleUniformExportProjection } from "@/lib/services/billing/uniform/uniform-export-assembler";
import { formatAlpha, formatNumeric } from "@/lib/services/billing/uniform/uniform-field-format";
import { buildUniformExportFiles } from "@/lib/services/billing/uniform/uniform-file-builder";
import { C100_LAYOUT, D110_LAYOUT, type RecordLayout } from "@/lib/services/billing/uniform/uniform-layout-1_31";
import { CRLF } from "@/lib/services/billing/uniform/uniform-serializer";

const NOTES = 5;
const PREFIX = "N-";

/** 1-based [from, to] of a field, computed from the layout (record code first). */
function span(layout: RecordLayout, id: number): [number, number] {
  let pos = 1;
  for (const f of layout.fields) {
    if (f.id === id) return [pos, pos + f.len - 1];
    pos += f.len;
  }
  throw new Error(`field ${id} not in ${layout.code}`);
}
const C = { type: span(C100_LAYOUT, 1203), number: span(C100_LAYOUT, 1204), date: span(C100_LAYOUT, 1205), customerKey: span(C100_LAYOUT, 1225) };
const D = { type: span(D110_LAYOUT, 1253), number: span(D110_LAYOUT, 1254), line: span(D110_LAYOUT, 1255), baseType: span(D110_LAYOUT, 1256), baseNumber: span(D110_LAYOUT, 1257) };
const get = (rec: string, [a, b]: [number, number]) => [...rec].slice(a - 1, b).join("");
function set(rec: string, [a, b]: [number, number], value: string): string {
  const v = [...value];
  if (v.length !== b - a + 1) throw new Error(`width ${v.length} ≠ ${b - a + 1}`);
  const chars = [...rec];
  chars.splice(a - 1, v.length, ...v);
  return chars.join("");
}

/**
 * The identity of the run that passed on 2026-07-02, as printed in its official report
 * (docs/compliance/tax-authority/simulator-report-2026-07-02.pdf: "DUBIZ , 1.0", registration 00000001) and as the
 * code produced it at the certification commit 39b74f05. SIMULATOR_SOFTWARE_CONFIG today names the software
 * "דוביז Dubiz" / vendor "נהרי אלדד" (changed after the run, in 98fef0fa), although its comment says it is the
 * 2026-07-02 identity. Only these two INI fields differ; BKMVDATA does not depend on them.
 */
const CERTIFIED_RUN_CONFIG = { ...SIMULATOR_SOFTWARE_CONFIG, softwareName: "DUBIZ", vendorName: "DUBIZ" };
/** sha256 of the package regenerated at 39b74f05 with scripts/uniform-export-sim-package.ts (2026-11-11). */
const CERTIFIED = {
  ini: "7cd4636034be8f2cffb5228efcf26a60865db04fa3115611a0477ab52b19fd2b",
  bkmvdata: "e863dbdef792f0a965ca5318a1123fd1cc43a7f3316a68c4518aa4b36ccde3c1",
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const proj = assembleUniformExportProjection(SIM_FIXTURE_INPUT);
const built = buildUniformExportFiles(proj, CERTIFIED_RUN_CONFIG, { primaryId: SIM_BUILD_OPTS.primaryId, generatedAt: SIM_BUILD_OPTS.generatedAt });
if (sha(built.iniBuffer) !== CERTIFIED.ini || sha(built.bkmvdataBuffer) !== CERTIFIED.bkmvdata) {
  throw new Error(`control is not the certified package: INI ${sha(built.iniBuffer)}, BKMVDATA ${sha(built.bkmvdataBuffer)}`);
}
console.log("control C = the certified package, byte for byte (INI + BKMVDATA sha256 pinned)");
const control = built.bkmvdataText.split(CRLF);

// documents: C100 header + its D110 lines (same type + number), tax invoices without payments only
type Doc = { header: number; lines: number[]; number: string; date: string; customer: string; hasPayments: boolean };
const docs: Doc[] = [];
control.forEach((rec, i) => {
  if (rec.startsWith("C100") && get(rec, C.type) === "305") docs.push({ header: i, lines: [], number: get(rec, C.number), date: get(rec, C.date), customer: get(rec, C.customerKey), hasPayments: false });
});
const byNumber = new Map(docs.map((d) => [d.number, d]));
control.forEach((rec, i) => {
  if (rec.startsWith("D110") && get(rec, D.type) === "305") byNumber.get(get(rec, D.number))?.lines.push(i);
  if (rec.startsWith("D120") && get(rec, D.type) === "305") { const d = byNumber.get(get(rec, D.number)); if (d) d.hasPayments = true; }
});

// pick NOTES delivery notes, each with a later tax invoice of the same customer (not itself a note) that will name it
const pairs: { note: Doc; invoice: Doc }[] = [];
const used = new Set<Doc>();
for (const note of docs) {
  if (pairs.length >= NOTES) break;
  if (used.has(note) || note.hasPayments || note.lines.length === 0) continue;
  const invoice = docs.find((d) => !used.has(d) && d !== note && !d.hasPayments && d.lines.length > 0 && d.customer === note.customer && d.date >= note.date && !pairs.some((p) => p.note === d));
  if (!invoice) continue;
  used.add(note);
  used.add(invoice);
  pairs.push({ note, invoice });
}
if (pairs.length !== NOTES) throw new Error(`only ${pairs.length} note/invoice pairs found`);

const asNote = (recs: string[], withPrefix: boolean) => {
  for (const { note } of pairs) {
    const num = withPrefix ? formatAlpha(PREFIX + note.number.trim(), 20) : note.number;
    recs[note.header] = set(set(recs[note.header], C.type, "200"), C.number, num);
    for (const l of note.lines) recs[l] = set(set(recs[l], D.type, "200"), D.number, num);
  }
};
const withReferences = (recs: string[], withPrefix: boolean) => {
  for (const { note, invoice } of pairs) {
    const first = invoice.lines[0];
    if (get(recs[first], D.baseType).replace(/^0+$/, "") !== "" || get(recs[first], D.baseNumber).trim() !== "") throw new Error("1256/1257 not empty in the certified package");
    const num = withPrefix ? formatAlpha(PREFIX + note.number.trim(), 20) : note.number;
    recs[first] = set(set(recs[first], D.baseType, formatNumeric("200", 3)), D.baseNumber, num);
  }
};

const packages: Record<"C" | "D" | "A" | "B", string[]> = { C: [...control], D: [...control], A: [...control], B: [...control] };
asNote(packages.D, false);
asNote(packages.A, false);
withReferences(packages.A, false);
asNote(packages.B, true);
withReferences(packages.B, true);

// A and B differ ONLY in the delivery-note number fields and the referencing 1257
const allowed = new Set<string>();
for (const { note, invoice } of pairs) {
  allowed.add(`${note.header}:${C.number.join("-")}`);
  for (const l of note.lines) allowed.add(`${l}:${D.number.join("-")}`);
  allowed.add(`${invoice.lines[0]}:${D.baseNumber.join("-")}`);
}
packages.A.forEach((a, i) => {
  const b = packages.B[i];
  if (a === b) return;
  if ([...a].length !== [...b].length) throw new Error(`record ${i}: length differs`);
  const spans = a.startsWith("C100") ? [C.number] : [D.number, D.baseNumber];
  const outside = [...a].some((ch, k) => ch !== [...b][k] && !spans.some(([x, y]) => k + 1 >= x && k + 1 <= y));
  if (outside) throw new Error(`record ${i}: A and B differ outside the number fields`);
  for (const sp of spans) if (get(a, sp) !== get(b, sp) && !allowed.has(`${i}:${sp.join("-")}`)) throw new Error(`record ${i}: unexpected difference at ${sp}`);
});
for (const k of ["D", "A", "B"] as const) if (packages[k].length !== control.length) throw new Error("record count changed");

const root = join(process.cwd(), "artifacts", "uniform-sim-base-doc");
const sums: string[] = [];
for (const [k, recs] of Object.entries(packages)) {
  const dir = join(root, k, built.meta.dirPath);
  mkdirSync(dir, { recursive: true });
  const bkmv = encodeIso8859_8i(recs.join(CRLF));
  writeFileSync(join(dir, "INI.TXT"), built.iniBuffer); // counts per record type and totals do not move
  writeFileSync(join(dir, "BKMVDATA.TXT"), bkmv);
  for (const [name, buf] of [["INI.TXT", built.iniBuffer], ["BKMVDATA.TXT", bkmv]] as const) sums.push(`${sha(buf)}  ${k}/${built.meta.dirPath}/${name}`);
  const changed = recs.filter((r, i) => r !== control[i]).length;
  console.log(`${k}: ${changed} records differ from the certified package → ${dir}`);
}
writeFileSync(join(root, "SHA256SUMS"), sums.join("\n") + "\n");
const pairRows = pairs.map((p, i) => `| ${i + 1} | ${p.note.number.trim()} | ${PREFIX}${p.note.number.trim()} | ${p.invoice.number.trim()} | ${p.note.date} → ${p.invoice.date} |`).join("\n");
writeFileSync(join(root, "PAIRS.md"), `| # | תעודת משלוח (A) | תעודת משלוח (B) | חשבונית שמפנה אליה (305) | תאריכים |\n|---|---|---|---|---|\n${pairRows}\n`);
console.log(`pairs (note → invoice): ${pairs.map((p) => `${p.note.number.trim()}→${p.invoice.number.trim()}`).join(", ")}`);
console.log("A vs B: differ only in the delivery-note number fields and 1257 — checked. Nothing uploaded.");
