/**
 * S1 — field-by-field difference report between the simulator packages C → D, D → A, A → B (owner request
 * 2026-11-11), read back from the BKMVDATA.TXT / INI.TXT files written by simulator-base-document-package.mts and
 * parsed with the official 1.31 layouts (lib/services/billing/uniform/uniform-layout-1_31.ts).
 *
 * Besides listing every changed field, it checks:
 *   - only the intended fields change at each step (1203/1253 type in C→D; 1256/1257 in D→A; 1204/1254/1257 in A→B);
 *   - in B the series prefix is consistent: every delivery-note number (C100 1204 and the note's D110 1254) and every
 *     reference to it (D110 1257) carry the same "N-" number, and every reference points at a note in the file;
 *   - fields that depend on the document type stay consistent: each delivery note's D110 lines carry the note's type
 *     and number (1253/1254), the C100 header-to-line link (1234/1273) is unchanged, and the control sums per document
 *     (C100 1219 = Σ D110 1267) still hold for every changed document.
 * Writes artifacts/uniform-sim-base-doc/DIFF.md, then packs C/D/A/B, SHA256SUMS, DIFF.md, PAIRS.md and README-he.md into
 * artifacts/s1-simulator-packages.zip (forward-slash paths, fixed timestamps). Run after the package script:
 *   npx tsx .business-documents/simulator-package-diff.mts
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { zipSync, type Zippable } from "fflate";

import { ALL_LAYOUTS, type RecordLayout } from "@/lib/services/billing/uniform/uniform-layout-1_31";

const ROOT = join(process.cwd(), "artifacts", "uniform-sim-base-doc");
const dirOf = (k: string) => {
  const base = join(ROOT, k, "OPENFRMT");
  const vat = readdirSync(base)[0];
  const stamp = readdirSync(join(base, vat))[0];
  return join(base, vat, stamp);
};
const decode = (buf: Buffer) => new TextDecoder("iso-8859-8").decode(buf);
const read = (k: string, f: string) => decode(readFileSync(join(dirOf(k), f)));
const records = (k: string) => read(k, "BKMVDATA.TXT").split("\r\n").filter(Boolean);

const LAYOUTS = new Map<string, RecordLayout>(ALL_LAYOUTS.filter((l) => /^[A-Z]\d{3}$/.test(l.code)).map((l) => [l.code, l]));
type Field = { id: number; name: string; value: string };
function parse(rec: string): Field[] {
  const layout = LAYOUTS.get(rec.slice(0, 4));
  if (!layout) throw new Error(`no layout for ${rec.slice(0, 4)}`);
  const chars = [...rec];
  if (chars.length !== layout.length) throw new Error(`${layout.code}: length ${chars.length} ≠ ${layout.length}`);
  let pos = 0;
  return layout.fields.map((f) => {
    const value = chars.slice(pos, pos + f.len).join("");
    pos += f.len;
    return { id: f.id, name: f.name, value };
  });
}
const val = (fs: Field[], id: number) => fs.find((f) => f.id === id)!.value;
const num = (s: string) => (/^[+-]?\d+$/.test(s.trim()) ? Number(s.trim()) / 100 : NaN); // amounts: implied 2 decimals

type Change = { record: number; code: string; id: number; name: string; from: string; to: string };
function diff(a: string, b: string): Change[] {
  const ra = records(a), rb = records(b);
  if (ra.length !== rb.length) throw new Error(`${a}→${b}: record count ${ra.length} ≠ ${rb.length}`);
  if (read(a, "INI.TXT") !== read(b, "INI.TXT")) throw new Error(`${a}→${b}: INI.TXT differs`);
  const out: Change[] = [];
  ra.forEach((rec, i) => {
    if (rec === rb[i]) return;
    const fa = parse(rec), fb = parse(rb[i]);
    fa.forEach((f, k) => { if (f.value !== fb[k].value) out.push({ record: i + 1, code: rec.slice(0, 4), id: f.id, name: f.name, from: f.value.trimEnd(), to: fb[k].value.trimEnd() }); });
  });
  return out;
}

const problems: string[] = [];
const expectOnly = (step: string, changes: Change[], ids: number[]) => {
  const bad = changes.filter((c) => !ids.includes(c.id));
  if (bad.length) problems.push(`${step}: unexpected fields changed: ${[...new Set(bad.map((c) => `${c.code}.${c.id}`))].join(", ")}`);
};
const steps = [
  { step: "C → D", from: "C", to: "D", ids: [1203, 1253] },
  { step: "D → A", from: "D", to: "A", ids: [1256, 1257] },
  { step: "A → B", from: "A", to: "B", ids: [1204, 1254, 1257] },
] as const;
const results = steps.map((s) => {
  const changes = diff(s.from, s.to);
  expectOnly(s.step, changes, [...s.ids]);
  return { ...s, changes };
});

// consistency in every package with notes
for (const k of ["D", "A", "B"]) {
  const recs = records(k).map(parse);
  const headers = recs.filter((f) => f[0].value === "C100");
  const lines = recs.filter((f) => f[0].value === "D110");
  const notes = headers.filter((h) => val(h, 1203) === "200");
  if (notes.length !== 5) problems.push(`${k}: ${notes.length} delivery notes, expected 5`);
  for (const n of notes) {
    const number = val(n, 1204), link = val(n, 1234);
    const own = lines.filter((l) => val(l, 1273) === link);
    if (own.length === 0) problems.push(`${k}: note ${number.trim()} has no lines`);
    for (const l of own) if (val(l, 1253) !== "200" || val(l, 1254) !== number) problems.push(`${k}: note ${number.trim()} line carries ${val(l, 1253)}/${val(l, 1254).trim()}`);
    const sum = own.reduce((s, l) => s + num(val(l, 1267)), 0);
    if (Math.abs(sum - num(val(n, 1219))) > 0.005) problems.push(`${k}: note ${number.trim()} C100.1219 ${num(val(n, 1219))} ≠ ΣD110.1267 ${sum}`);
    if (k === "B" && !number.trim().startsWith("N-")) problems.push(`B: note number ${number.trim()} has no prefix`);
    if (k !== "B" && number.trim().startsWith("N-")) problems.push(`${k}: note number ${number.trim()} has a prefix`);
  }
  const noteNumbers = new Set(notes.map((n) => val(n, 1204)));
  const refs = lines.filter((l) => val(l, 1257).trim() !== "");
  if (k === "D" && refs.length) problems.push(`D: ${refs.length} references, expected none`);
  if (k !== "D") {
    if (refs.length !== 5) problems.push(`${k}: ${refs.length} references, expected 5`);
    for (const r of refs) {
      if (val(r, 1256) !== "200") problems.push(`${k}: reference with base type ${val(r, 1256)}`);
      if (!noteNumbers.has(val(r, 1257))) problems.push(`${k}: reference ${val(r, 1257).trim()} points at no delivery note in the file`);
      if (val(r, 1253) !== "305") problems.push(`${k}: a ${val(r, 1253)} line carries a reference`);
    }
  }
}

const table = (cs: Change[]) =>
  cs.length === 0
    ? "_אין הבדלים._\n"
    : "| רשומה | סוג | שדה | שם השדה | לפני | אחרי |\n|---|---|---|---|---|---|\n" +
      cs.map((c) => `| ${c.record} | ${c.code} | ${c.id} | ${c.name} | \`${c.from || "(ריק)"}\` | \`${c.to || "(ריק)"}\` |`).join("\n") + "\n";
const summary = (cs: Change[]) => [...new Set(cs.map((c) => `${c.code}.${c.id}`))].join(", ") || "—";
const md = [
  "# S1 — דוח הבדלים לפי שדות בין חבילות הסימולטור",
  "",
  "הופק על ידי `.business-documents/simulator-package-diff.mts` מתוך הקבצים עצמם, לפי פריסת 1.31. INI.TXT זהה בכל החבילות.",
  "",
  `**בדיקות עקביות:** ${problems.length === 0 ? "כולן עברו" : `${problems.length} בעיות`}. נבדקו: רק השדות הצפויים השתנו בכל שלב; בכל תעודה, שורותיה נושאות את הסוג והמספר שלה (1253/1254) והקישור 1234/1273 לא השתנה; סכום הבקרה C100.1219 = ΣD110.1267 נשמר; ב־B כל מספרי התעודות וכל ההפניות נושאים את הקידומת \`N-\`, ובכל חבילה כל הפניה מצביעה על תעודה שבקובץ.`,
  ...(problems.length ? ["", ...problems.map((p) => `- ${p}`)] : []),
  "",
  ...results.flatMap((r) => [`## ${r.step} — ${r.changes.length} שדות השתנו (${summary(r.changes)})`, "", table(r.changes)]),
].join("\n");
writeFileSync(join(ROOT, "DIFF.md"), md);
for (const r of results) console.log(`${r.step}: ${r.changes.length} field changes (${summary(r.changes)})`);
console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "consistency checks: all passed");
if (problems.length) process.exit(1);

// the ZIP for transfer: forward-slash paths, a fixed date so the same files give the same archive
const files: Zippable = {};
const MTIME = new Date("2026-07-01T09:00:00Z");
const add = (abs: string) => {
  if (statSync(abs).isDirectory()) return readdirSync(abs).forEach((n) => add(join(abs, n)));
  files[relative(ROOT, abs).split("\\").join("/")] = [new Uint8Array(readFileSync(abs)), { mtime: MTIME }];
};
for (const entry of ["C", "D", "A", "B", "SHA256SUMS", "DIFF.md", "PAIRS.md"]) add(join(ROOT, entry));
// the instructions live in the repository; the zip carries them at its root
files["README-he.md"] = [new Uint8Array(readFileSync(join(process.cwd(), ".business-documents", "simulator-s1-README-he.md"))), { mtime: MTIME }];
const zip = zipSync(files, { level: 9 });
writeFileSync(join(process.cwd(), "artifacts", "s1-simulator-packages.zip"), zip);
console.log(`zip: ${Object.keys(files).length} files, ${zip.length} bytes → artifacts/s1-simulator-packages.zip`);
