/**
 * Server-function trace size report — what each route's serverless function
 * would carry, from Next's own trace files (.next/server/**\/*.nft.json, the
 * input Vercel uses to assemble functions).
 *
 * Run after `next build`:
 *   node scripts/qa/trace-size-report.mjs [out.json]
 *
 * Prints the heaviest functions, their qa-evidence share, and writes the full
 * per-route file lists to out.json so two builds can be diffed exactly.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = process.cwd();
const serverDir = join(root, ".next", "server");
const out = process.argv[2] ?? "trace-size-report.json";

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith(".nft.json")) acc.push(p);
  }
  return acc;
}

const report = {};
for (const traceFile of walk(serverDir)) {
  const { files } = JSON.parse(readFileSync(traceFile, "utf8"));
  const base = dirname(traceFile);
  let bytes = 0;
  let qaBytes = 0;
  let qaFiles = 0;
  const list = [];
  for (const rel of files) {
    const abs = resolve(base, rel);
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      /* missing on disk */
    }
    const fromRoot = relative(root, abs).split(sep).join("/");
    list.push(fromRoot);
    bytes += size;
    if (fromRoot.startsWith("qa-evidence/")) {
      qaBytes += size;
      qaFiles += 1;
    }
  }
  const route = relative(serverDir, traceFile).split(sep).join("/").replace(/\.js\.nft\.json$/, "");
  report[route] = { files: list.length, mb: +(bytes / 1e6).toFixed(1), qaEvidenceMb: +(qaBytes / 1e6).toFixed(1), qaEvidenceFiles: qaFiles, list };
}

writeFileSync(out, JSON.stringify(report, null, 2));
const rows = Object.entries(report).sort((a, b) => b[1].mb - a[1].mb);
const withQa = rows.filter(([, r]) => r.qaEvidenceFiles > 0).length;
console.log(`${rows.length} traced server entries; ${withQa} include qa-evidence files`);
console.log("heaviest:");
for (const [route, r] of rows.slice(0, 8)) {
  console.log(`  ${String(r.mb).padStart(6)} MB  (qa-evidence ${r.qaEvidenceMb} MB / ${r.qaEvidenceFiles} files)  ${route}`);
}
