#!/usr/bin/env node
/**
 * PDF route tracing guard — run after `next build`.
 *
 * Every server route whose file trace reaches @sparticuz/chromium (it renders a PDF through
 * lib/pdf/chromium.ts) must also carry the package's compressed browser (@sparticuz/chromium/bin/*).
 * File tracing cannot see that directory (it is resolved at runtime), so it only ships when the route
 * is listed in next.config.ts outputFileTracingIncludes. A missed route builds fine and fails only in
 * Production, at the first render — which is exactly how the accountant PDF download failed before #832.
 *
 * Offline: reads .next/server/**\/*.nft.json only.
 *   node scripts/ci/pdf-route-tracing-guard.mjs [--self-test]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PACKAGE = "node_modules/@sparticuz/chromium/";
const BROWSER = "node_modules/@sparticuz/chromium/bin/";

/** Pure: trace file list → verdict. */
export function judgeTrace(files) {
  const norm = files.map((f) => f.replace(/\\/g, "/"));
  const reaches = norm.some((f) => f.includes(PACKAGE));
  const carries = norm.some((f) => f.includes(BROWSER));
  return { reaches, carries, ok: !reaches || carries };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".nft.json")) out.push(p);
  }
  return out;
}

function selfTest() {
  const cases = [
    [["../../node_modules/next/dist/server.js"], true],
    [["../../node_modules/@sparticuz/chromium/build/index.js"], false],
    [["..\\..\\node_modules\\@sparticuz\\chromium\\build\\index.js", "..\\..\\node_modules\\@sparticuz\\chromium\\bin\\chromium.br"], true],
    [["../../node_modules/@sparticuz/chromium/build/index.js", "../../node_modules/@sparticuz/chromium/bin/al2023.tar.br"], true],
  ];
  for (const [files, expected] of cases) {
    if (judgeTrace(files).ok !== expected) {
      console.error(`PDF-ROUTE-TRACING-GUARD self-test FAILED for ${JSON.stringify(files)}`);
      process.exit(1);
    }
  }
  console.log(`PDF-ROUTE-TRACING-GUARD self-test: PASS (${cases.length} cases)`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const root = join(process.cwd(), ".next", "server");
  let traces;
  try {
    traces = walk(root);
  } catch {
    console.error("PDF-ROUTE-TRACING-GUARD: no .next/server — run `next build` first");
    process.exit(1);
  }
  const rendering = [];
  const missing = [];
  for (const t of traces) {
    const { files = [] } = JSON.parse(readFileSync(t, "utf8"));
    const v = judgeTrace(files);
    if (!v.reaches) continue;
    const name = relative(root, t).replace(/\\/g, "/").replace(/\.nft\.json$/, "");
    rendering.push(name);
    if (!v.ok) missing.push(name);
  }
  for (const r of rendering.sort()) console.log(`  ${missing.includes(r) ? "[MISSING BROWSER]" : "[ok]"} ${r}`);
  if (rendering.length === 0) {
    console.error("PDF-ROUTE-TRACING-GUARD: no route reaches @sparticuz/chromium — the check would prove nothing");
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(
      `PDF-ROUTE-TRACING-GUARD: FAIL — ${missing.length} route(s) render PDFs without the serverless browser; ` +
        "add them to next.config.ts outputFileTracingIncludes"
    );
    process.exit(1);
  }
  console.log(`PDF-ROUTE-TRACING-GUARD: PASS — ${rendering.length} PDF-rendering route trace(s), all carry the browser`);
}

main();
