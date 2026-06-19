/**
 * INVESTIGATION ONLY (read-only observation) — bare-integer-total coverage class.
 *
 * Does NOT change the Amount engine, does NOT extend parse, adds NO keyword /
 * blocklist / fallback. It runs the EXISTING representation, then MEASURES, for
 * every numeral that the whitelist excluded, what structural evidence exists
 * around it — so we can decide whether "bare-integer total" is a real, closable
 * Representation gap or a noise hazard. Pure measurement.
 *
 *   npx tsx --env-file=.env eval/bare-int-investigation.ts
 */
import fs from "fs";
import path from "path";
import { runGoogleVisionOCRWithGeometry } from "../lib/services/documents/google-vision-ocr.service";
import { buildRepresentationFromOcr } from "../lib/services/documents/representation/document-representation";
import { deriveMoneyAmounts } from "../lib/services/documents/representation/document-money-amount";
import { parseMoneyShape } from "../lib/services/documents/representation/document-amount-relations";
import type { DocumentToken } from "../lib/services/documents/representation/document-representation";

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
const isMedia = (f: string) => /\.(jpe?g|png|pdf)$/i.test(f);
const mimeFor = (f: string) =>
  f.toLowerCase().endsWith(".pdf") ? "application/pdf" : f.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

function sampleUploads(cap: number): string[] {
  const all = walk(path.join("public", "uploads")).filter(isMedia).sort();
  if (!all.length) return [];
  const stride = Math.max(1, Math.floor(all.length / cap));
  return all.filter((_, i) => i % stride === 0).slice(0, cap);
}

async function silence<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
}

type Num = { v: string; mag: number; intLen: number; cx: number; cy: number; ry: number; rx: number };

function center(t: DocumentToken): { cx: number; cy: number } | null {
  const b = t.geometry.bbox;
  if (!b) return null;
  return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
}

function geomKey(t: DocumentToken): string {
  const b = t.geometry.bbox;
  return b ? `${t.page}:${b.x},${b.y}:${t.value}` : `${t.page}:nobox:${t.value}`;
}

async function analyzeDoc(file: string) {
  const ocr = await silence(() => runGoogleVisionOCRWithGeometry(path.resolve(file), mimeFor(file)));
  const rep = buildRepresentationFromOcr(ocr);
  const tokens = rep.tokens;

  // page extent (works for pixel OR normalized coords)
  let maxX = 0, maxY = 0;
  for (const t of tokens) {
    const b = t.geometry.bbox; if (!b) continue;
    maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
  }
  const rel = (c: { cx: number; cy: number }) => ({ rx: maxX ? c.cx / maxX : 0, ry: maxY ? c.cy / maxY : 0 });

  const money = deriveMoneyAmounts(rep).filter((m) => m.publishable);
  const moneyMags = money.map((m) => Math.round(m.magnitude * 100) / 100);
  const moneyTokenKeys = new Set(
    money.flatMap((m) => m.sourceTokens.map((t) => geomKey(t)))
  );

  // every numeral the whitelist did NOT promote to a publishable money amount
  const excluded: Num[] = [];
  for (const t of tokens) {
    const mag = parseMoneyShape(t.value);
    if (mag === null) continue;
    if (moneyTokenKeys.has(geomKey(t))) continue; // it's a money source token
    const c = center(t); if (!c) continue;
    const r = rel(c);
    const intLen = String(Math.trunc(Math.abs(mag))).length;
    excluded.push({ v: t.value, mag, intLen, cx: c.cx, cy: c.cy, ry: r.ry, rx: r.rx });
  }

  // money-range excluded numerals (shape-only filter for analysis: not too many digits)
  const moneyRange = excluded.filter((e) => e.mag >= 1 && e.intLen <= 6);

  const sumMoney = Math.round(moneyMags.reduce((a, b) => a + b, 0) * 100) / 100;

  // candidate bare-integer totals: an excluded numeral that is anchored by structure
  const candidates = moneyRange.map((e) => {
    const repeatCount = moneyRange.filter((o) => Math.abs(o.mag - e.mag) < 0.01).length;
    const eqSumAllMoney = moneyMags.length >= 2 && Math.abs(e.mag - sumMoney) < 0.5;
    // equals sum of (all publishable money + all OTHER money-range excluded), i.e. full line set
    const others = moneyRange.filter((o) => o !== e);
    const sumMoneyPlusOthers =
      Math.round((sumMoney + others.reduce((a, b) => a + b.mag, 0)) * 100) / 100;
    const eqSumAll = Math.abs(e.mag - sumMoneyPlusOthers) < 0.5 && (moneyMags.length + others.length) >= 2;
    // arithmetic anchor: equals sum of some subset of trusted money (pairwise+)
    let eqSubsetMoney = false;
    for (let i = 0; i < moneyMags.length; i++)
      for (let j = i + 1; j < moneyMags.length; j++)
        if (Math.abs(e.mag - (moneyMags[i] + moneyMags[j])) < 0.5) eqSubsetMoney = true;
    const colAlignedMoney = money.some((m) => {
      const t = m.sourceTokens[m.sourceTokens.length - 1];
      const c = center(t); if (!c) return false;
      return Math.abs(c.cx - e.cx) < Math.max(maxX * 0.04, 8);
    });
    const isMax = e.mag >= Math.max(...[...moneyMags, ...moneyRange.map((o) => o.mag)]);
    return {
      v: e.v, mag: e.mag, intLen: e.intLen, ry: +e.ry.toFixed(2), rx: +e.rx.toFixed(2),
      repeatCount, bottom: e.ry > 0.6, isMax, colAlignedMoney,
      eqSumAllMoney, eqSumAll, eqSubsetMoney,
    };
  });

  const anchored = candidates.filter(
    (c) => c.eqSumAllMoney || c.eqSumAll || c.eqSubsetMoney || c.repeatCount >= 2
  );

  // NOISE: digit-length histogram of ALL excluded numerals (phones/ids/barcodes show up as long)
  const lenHist: Record<number, number> = {};
  for (const e of excluded) lenHist[e.intLen] = (lenHist[e.intLen] ?? 0) + 1;

  // spurious pairwise closures if money-range excluded were admitted into the graph
  const pool = [...moneyMags, ...moneyRange.map((o) => o.mag)];
  let spuriousPairs = 0;
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++)
      for (let k = 0; k < pool.length; k++)
        if (k !== i && k !== j && Math.abs(pool[i] + pool[j] - pool[k]) < 0.01) spuriousPairs++;

  return {
    file: file.replace(/\\/g, "/"),
    money: moneyMags,
    nExcluded: excluded.length,
    nMoneyRangeExcluded: moneyRange.length,
    lenHist,
    candidates,
    anchored,
    spuriousPairsIfAdmitted: spuriousPairs,
    text: rep.text.slice(0, 1100),
  };
}

async function main() {
  const storage = Array.from(
    new Set([path.join("storage", "documents"), path.join("storage", "platform")].flatMap(walk))
  ).filter((f) => isMedia(f) && /[\\/]documents[\\/]/.test(f));
  const uploads = sampleUploads(40);
  const files = [...storage, ...uploads];
  console.log(`investigating ${files.length} docs (${storage.length} storage + ${uploads.length} uploads)`);

  const rows = [];
  for (const f of files) {
    try { rows.push(await analyzeDoc(f)); }
    catch (e) { console.log("ERR", f, e instanceof Error ? e.message : e); }
  }
  fs.writeFileSync("tmp/bare-int-data.json", JSON.stringify(rows, null, 2));

  // print only docs with at least one structurally-anchored excluded numeral
  const flagged = rows.filter((r) => r.anchored.length > 0);
  console.log(`\n==== docs with structurally-anchored excluded numeral: ${flagged.length}/${rows.length} ====`);
  for (const r of flagged) {
    console.log(`\n--- ${r.file}`);
    console.log(`  money=[${r.money.join(",")}]  spuriousPairsIfAdmitted=${r.spuriousPairsIfAdmitted}`);
    for (const a of r.anchored)
      console.log(`  ANCHOR v=${a.v} mag=${a.mag} ry=${a.ry} rx=${a.rx} repeat=${a.repeatCount} bottom=${a.bottom} isMax=${a.isMax} colAligned=${a.colAlignedMoney} eqSumMoney=${a.eqSumAllMoney} eqSumAll=${a.eqSumAll} eqSubset=${a.eqSubsetMoney}`);
  }

  // aggregate noise picture
  const allLen: Record<number, number> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.lenHist)) allLen[+k] = (allLen[+k] ?? 0) + (v as number);
  console.log("\n==== excluded-numeral digit-length histogram (all docs) ====");
  console.log(allLen);
  console.log("\nwrote tmp/bare-int-data.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
