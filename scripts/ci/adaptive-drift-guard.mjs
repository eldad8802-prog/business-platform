/**
 * Adaptive anti-drift guard (Spec v1 §29) — a RATCHET, not a blanket ban.
 *
 * Counts the ad-hoc layout authorities the architecture migration is removing,
 * and fails only if a metric EXCEEDS the checked-in baseline. When a wave
 * reduces a count, lower the baseline in the same PR (the script prints the
 * new values). This blocks regressions without freezing legitimate component
 * dimensions or the not-yet-migrated legacy.
 *
 *   node scripts/ci/adaptive-drift-guard.mjs            # check
 *   node scripts/ci/adaptive-drift-guard.mjs --update   # rewrite baseline
 *
 * Metrics (deliberately narrow — see Spec §29 "smart guardrails"):
 *   pageMaxWidth   `maxWidth:` inside page/screen wrappers (app/** page.tsx
 *                  + layout.tsx). Component-level widths are NOT counted.
 *   rawEnv         `env(safe-area` outside the allowlist (globals.css,
 *                  shell/nav, overlay primitive, capacitor www).
 *   innerWidth     `window.innerWidth` under app/.
 *   rawZ           `zIndex: 21474` style escalations (the arms-race marker).
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASELINE_PATH = path.join(ROOT, "scripts/ci/adaptive-drift-baseline.json");

const ENV_ALLOWLIST = [
  "app/globals.css",
  "components/navigation/",
  "components/ui/adaptive-overlay.tsx",
  "capacitor/www/",
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next" || name === ".git") continue;
      yield* walk(p);
    } else if (/\.(tsx?|css|mjs)$/.test(name)) {
      yield p;
    }
  }
}

function rel(p) {
  return path.relative(ROOT, p).replaceAll("\\", "/");
}

const counts = { pageMaxWidth: 0, rawEnv: 0, innerWidth: 0, rawZ: 0 };
const hits = { pageMaxWidth: [], rawEnv: [], innerWidth: [], rawZ: [] };

for (const file of walk(path.join(ROOT, "app"))) {
  const r = rel(file);
  const src = readFileSync(file, "utf8");
  const isPageLevel = /\/(page|layout)\.tsx$/.test(r);
  if (isPageLevel) {
    const n = (src.match(/maxWidth\s*:/g) || []).length;
    if (n) {
      counts.pageMaxWidth += n;
      hits.pageMaxWidth.push(`${r} (${n})`);
    }
  }
  const iw = (src.match(/window\.innerWidth/g) || []).length;
  if (iw) {
    counts.innerWidth += iw;
    hits.innerWidth.push(`${r} (${iw})`);
  }
}

for (const base of ["app", "components", "features", "lib"]) {
  let dir;
  try {
    dir = path.join(ROOT, base);
    statSync(dir);
  } catch {
    continue;
  }
  for (const file of walk(dir)) {
    const r = rel(file);
    const src = readFileSync(file, "utf8");
    if (!ENV_ALLOWLIST.some((a) => r.startsWith(a))) {
      const n = (src.match(/env\(safe-area/g) || []).length;
      if (n) {
        counts.rawEnv += n;
        hits.rawEnv.push(`${r} (${n})`);
      }
    }
    const z = (src.match(/21474\d{5}/g) || []).length;
    if (z) {
      counts.rawZ += z;
      hits.rawZ.push(`${r} (${z})`);
    }
  }
}

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE_PATH, JSON.stringify(counts, null, 2) + "\n");
  console.log("baseline updated:", JSON.stringify(counts));
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
} catch {
  console.error("no baseline — run with --update once");
  process.exit(1);
}

let failed = false;
for (const key of Object.keys(counts)) {
  const now = counts[key];
  const base = baseline[key] ?? 0;
  const mark = now > base ? "REGRESSION" : now < base ? "improved " : "ok       ";
  console.log(`${mark}  ${key}: ${now} (baseline ${base})`);
  if (now > base) {
    failed = true;
    console.log(`  offenders:\n    ${hits[key].join("\n    ")}`);
  }
  if (now < base) {
    console.log(`  -> lower the baseline to ${now} in this PR to lock the gain`);
  }
}

process.exit(failed ? 1 : 0);
