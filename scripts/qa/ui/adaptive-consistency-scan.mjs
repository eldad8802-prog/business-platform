/**
 * Dubiz adaptive consistency scan — READ-ONLY static pass.
 *
 * Reads every runtime route and reports, per route, how it obtains its width,
 * which breakpoints it uses, and how it treats the app shell. It changes
 * nothing; it exists so the audit rests on a complete inventory rather than on
 * the clusters that happen to be memorable.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CANON_BP = new Set([768, 1024, 1280]);
const CANON_WIDTH = new Map([[560, "focused"], [760, "standard"], [960, "content"], [1280, "data"]]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === ".next") continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

const pages = walk(path.join(ROOT, "app")).filter((f) => /[\\/]page\.tsx$/.test(f));
const layouts = walk(path.join(ROOT, "app")).filter((f) => /[\\/]layout\.tsx$/.test(f));

/** Which layout file governs a page (nearest ancestor). */
function governingLayouts(pageFile) {
  const dir = path.dirname(pageFile);
  return layouts.filter((l) => dir.startsWith(path.dirname(l)));
}

const routeOf = (f) =>
  "/" +
  path
    .relative(path.join(ROOT, "app"), path.dirname(f))
    .replaceAll("\\", "/")
    .replace(/\((shell|corporate|platform-admin)\)\/?/g, "")
    .replace(/^$/, "");

const rows = [];
for (const f of pages) {
  const src = readFileSync(f, "utf8");
  const layoutSrc = governingLayouts(f).map((l) => readFileSync(l, "utf8")).join("\n");
  const all = src + "\n" + layoutSrc;

  // Width authority.
  const maxWidths = [...src.matchAll(/maxWidth\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  const maxWidthTokens = [...src.matchAll(/maxWidth\s*:\s*LAYOUT\.width\.(\w+)/g)].map((m) => m[1]);
  const maxWidthOther = (src.match(/maxWidth\s*:/g) || []).length - maxWidths.length - maxWidthTokens.length;

  // Breakpoints actually used in this file.
  const bps = [
    ...[...src.matchAll(/min-width:\s*(\d+)px/g)].map((m) => Number(m[1])),
    ...[...src.matchAll(/max-width:\s*(\d+)px/g)].map((m) => Number(m[1])),
    ...[...src.matchAll(/LAYOUT\.bp\.(\w+)/g)].map((m) => ({ medium: 768, expanded: 1024, wide: 1280 }[m[1]])),
  ].filter(Boolean);

  rows.push({
    route: routeOf(f) || "/",
    file: path.relative(ROOT, f).replaceAll("\\", "/"),
    pageContainer: /\bPageContainer\b/.test(src),
    workspace: /\bWorkspaceLayout\b/.test(src) || /\bWorkspaceLayout\b/.test(layoutSrc),
    intentDeclared: /data-page-intent/.test(all),
    intents: [...new Set([...all.matchAll(/data-page-intent=["{]?["']?(\w+)/g)].map((m) => m[1]))],
    rawMaxWidth: maxWidths,
    tokenMaxWidth: maxWidthTokens,
    otherMaxWidth: maxWidthOther > 0 ? maxWidthOther : 0,
    breakpoints: [...new Set(bps)].sort((a, b) => a - b),
    shellChrome: /ShellChrome/.test(layoutSrc),
    hidesChrome: /useHideShellChrome/.test(src),
    hidesUnconditionally: /useHideShellChrome\(true\)/.test(src),
    innerWidth: /window\.innerWidth/.test(src),
    rawEnv: /env\(safe-area/.test(src),
    phoneFrame: /PhoneFrame/.test(src),
    dvh: /100dvh|100vh/.test(src),
  });
}

const nonCanonBp = rows.filter((r) => r.breakpoints.some((b) => !CANON_BP.has(b)));
const rawWidth = rows.filter((r) => r.rawMaxWidth.length > 0);
const offScaleWidth = rows.filter((r) => r.rawMaxWidth.some((w) => !CANON_WIDTH.has(w)));
const noIntent = rows.filter((r) => !r.intentDeclared && !r.workspace);
const unconditionalHide = rows.filter((r) => r.hidesUnconditionally);
const noShellAtAll = rows.filter((r) => !r.shellChrome);

console.log("runtime routes scanned: " + rows.length + "\n");

console.log("=== A. page-level width literals (ratchet metric) ===");
for (const r of rawWidth) {
  const off = r.rawMaxWidth.filter((w) => !CANON_WIDTH.has(w));
  console.log("  " + r.route + "  " + JSON.stringify(r.rawMaxWidth) +
    (off.length ? "   OFF-SCALE: " + JSON.stringify(off) : "   (on-scale)") + "   " + r.file);
}
console.log("  total routes with a literal: " + rawWidth.length + ", off-scale: " + offScaleWidth.length + "\n");

console.log("=== B. non-canonical breakpoints (outside 768/1024/1280) ===");
for (const r of nonCanonBp) {
  console.log("  " + r.route + "  " + JSON.stringify(r.breakpoints) + "   " + r.file);
}
console.log("  total: " + nonCanonBp.length + "\n");

console.log("=== C. width-intent declaration ===");
console.log("  declare an intent: " + rows.filter((r) => r.intentDeclared).length);
console.log("  use PageContainer: " + rows.filter((r) => r.pageContainer).length);
console.log("  use WorkspaceLayout: " + rows.filter((r) => r.workspace).length);
console.log("  neither, and no intent: " + noIntent.length);
console.log("  intents in use: " + JSON.stringify([...new Set(rows.flatMap((r) => r.intents))]) + "\n");

console.log("=== D. shell contract ===");
console.log("  routes with NO ShellChrome ancestor: " + noShellAtAll.length);
for (const r of noShellAtAll) console.log("    " + r.route + "   " + r.file);
console.log("  routes hiding chrome UNCONDITIONALLY: " + unconditionalHide.length);
for (const r of unconditionalHide) console.log("    " + r.route + "   " + r.file);
console.log("  routes hiding chrome conditionally: " +
  rows.filter((r) => r.hidesChrome && !r.hidesUnconditionally).map((r) => r.route).join(", ") + "\n");

console.log("=== E. other contract markers ===");
console.log("  window.innerWidth: " + rows.filter((r) => r.innerWidth).map((r) => r.route).join(", "));
console.log("  raw env(safe-area): " + (rows.filter((r) => r.rawEnv).map((r) => r.route).join(", ") || "none"));
console.log("  PhoneFrame at page level: " + (rows.filter((r) => r.phoneFrame).map((r) => r.route).join(", ") || "none"));

console.log("\n=== FULL TABLE ===");
console.log(JSON.stringify(rows, null, 1));
