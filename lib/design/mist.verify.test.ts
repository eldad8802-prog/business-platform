/**
 * Dubiz Mist — token integrity proof (`npm run verify:mist-tokens`).
 *
 * The colour system has exactly one source of truth: `app/dubiz-mist.css`.
 * `lib/design/mist.ts` mirrors it for inline styles, and `lib/design/tokens.ts`
 * re-points the legacy TOKEN surface at that mirror. Nothing in this chain is
 * type-checked by the compiler — a renamed variable or a hand-edited fallback
 * would silently degrade to the fallback colour (or to `transparent`) in the
 * browser, which is exactly the drift this file exists to prevent.
 *
 * It asserts:
 *   1. Every `var(--dz-*)` mist.ts references is actually declared in the CSS.
 *   2. Every flat fallback in mist.ts equals the CSS declaration it mirrors.
 *   3. Every `--dz-nav-*` / `--dz-fab-*` chrome variable has a matching entry
 *      in the `[data-dz-home]` freeze block — otherwise a nav colour would
 *      leak onto the Home route and break the §12 exclusion.
 *   4. No image-bearing surface token is used in a `backgroundColor` position
 *      anywhere in the app (a gradient there computes to `transparent`).
 *   5. Text colours keep WCAG AA (4.5:1) against every Mist ground.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MIST, MIST_FLAT } from "./mist";

const ROOT = process.cwd();
const CSS_PATH = join(ROOT, "app", "dubiz-mist.css");
const css = readFileSync(CSS_PATH, "utf8");

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Declarations inside a given selector block of the Mist stylesheet. */
function declarationsIn(selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`selector not found in CSS: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("\n}", open);
  const body = css.slice(open + 1, close);
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--dz-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

// `:root` is declared once at the top of dubiz-mist.css.
const rootVars = declarationsIn(":root");
const homeVars = declarationsIn('[data-dz-home="1"]');

console.log("Dubiz Mist — token integrity");
console.log(`  :root declarations           ${rootVars.size}`);
console.log(`  [data-dz-home] declarations  ${homeVars.size}`);

// ---------------------------------------------------------------- 1 + 2 ----
// Every var() reference in mist.ts must exist in :root, and its declared
// fallback must equal the CSS value (for the flat-colour tokens, where a
// literal comparison is meaningful).
const VAR_RE = /^var\((--dz-[a-z0-9-]+),\s*(.+)\)$/;

for (const [key, value] of Object.entries(MIST)) {
  const m = VAR_RE.exec(value);
  check(Boolean(m), `MIST.${key} is a var() reference`, value);
  if (!m) continue;
  const [, name, fallback] = m;
  check(rootVars.has(name), `MIST.${key} → ${name} declared in :root`);
  const cssValue = rootVars.get(name);
  if (!cssValue) continue;
  // Only compare where the CSS value is a literal (not itself a var()/stack).
  if (!cssValue.includes("var(") && !cssValue.includes("gradient")) {
    check(
      cssValue.toLowerCase() === fallback.toLowerCase(),
      `MIST.${key} fallback matches CSS`,
      `ts="${fallback}" css="${cssValue}"`,
    );
  }
}

// MIST_FLAT must mirror the flat CSS declarations exactly.
const FLAT_TO_VAR: Record<keyof typeof MIST_FLAT, string> = {
  background: "--dz-background",
  surface: "--dz-surface-flat",
  surfaceMuted: "--dz-surface-muted",
  surfaceRaised: "--dz-surface-raised-flat",
  appChrome: "--dz-app-chrome",
  border: "--dz-border",
  borderSubtle: "--dz-border-subtle",
  borderStrong: "--dz-border-strong",
  textPrimary: "--dz-text-primary",
  textSecondary: "--dz-text-secondary",
  textMuted: "--dz-text-muted",
  textDisabled: "--dz-text-disabled",
  textOnBrand: "--dz-text-on-brand",
  brand: "--dz-brand",
  brandHover: "--dz-brand-hover",
  brandSoft: "--dz-brand-soft",
  brandSoftStrong: "--dz-brand-soft-strong",
  brandBorder: "--dz-brand-border",
  success: "--dz-success",
  successBg: "--dz-success-bg",
  successBgSoft: "--dz-success-bg-soft",
  successBorder: "--dz-success-border",
  successAccent: "--dz-success-accent",
  warning: "--dz-warning",
  warningBg: "--dz-warning-bg",
  warningBgSoft: "--dz-warning-bg-soft",
  warningBorder: "--dz-warning-border",
  warningAccent: "--dz-warning-accent",
  danger: "--dz-danger",
  dangerBg: "--dz-danger-bg",
  dangerBgSoft: "--dz-danger-bg-soft",
  dangerBorder: "--dz-danger-border",
  dangerAccent: "--dz-danger-accent",
  info: "--dz-info",
  infoBg: "--dz-info-bg",
  infoBgSoft: "--dz-info-bg-soft",
  infoBorder: "--dz-info-border",
  infoAccent: "--dz-info-accent",
};

for (const [key, name] of Object.entries(FLAT_TO_VAR)) {
  const declared = rootVars.get(name);
  check(Boolean(declared), `MIST_FLAT.${key} → ${name} declared`);
  if (!declared) continue;
  check(
    declared.toLowerCase() ===
      MIST_FLAT[key as keyof typeof MIST_FLAT].toLowerCase(),
    `MIST_FLAT.${key} matches CSS`,
    `ts="${MIST_FLAT[key as keyof typeof MIST_FLAT]}" css="${declared}"`,
  );
}

// -------------------------------------------------------------------- 3 ----
// The Home exclusion only holds if EVERY global-chrome variable is frozen.
const chromeVars = [...rootVars.keys()].filter(
  (n) =>
    n.startsWith("--dz-nav-") ||
    n.startsWith("--dz-fab-") ||
    n.startsWith("--dz-shell-"),
);
check(chromeVars.length > 0, "global-chrome variables exist");
for (const name of chromeVars) {
  check(
    homeVars.has(name),
    `${name} is frozen in [data-dz-home]`,
    "an unfrozen chrome colour would repaint the Home route",
  );
}

// -------------------------------------------------------------------- 4 ----
// An image-bearing token in `backgroundColor` computes to `transparent`.
const IMAGE_TOKENS = [
  "surface",
  "surfaceStrong",
  "surfaceRaised",
  "brandGradient",
  "brandGradientHover",
];
const SCAN_DIRS = ["app", "components", "features", "lib"];
const offenders: string[] = [];

/** Every .ts/.tsx/.css file under a directory, recursively. */
function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(tsx?|css)$/.test(entry)) continue;
    const text = readFileSync(full, "utf8");
    for (const m of text.matchAll(/background-?[Cc]olor\s*:\s*([^,;\n]+)/g)) {
      const value = m[1];
      // An explicit `/* mist-ok: flat */` marker means the author checked that
      // the value is a flat colour. Everything else is rejected: Dubiz surface
      // tokens are image stacks, and an image in `background-color` silently
      // computes to `transparent` instead of erroring.
      if (value.includes("mist-ok")) continue;
      const hitsToken = IMAGE_TOKENS.some((t) =>
        new RegExp(`\\b(MIST|TOKEN|d|theme|C)\\.[\\w.]*\\b${t}\\b`).test(value),
      );
      // Only the IMAGE-bearing custom properties are unsafe here. Match them
      // exactly (terminated by `,` or `)`) so their flat siblings —
      // --dz-surface-muted, --dz-surface-flat, --dz-surface-raised-flat —
      // remain perfectly legal background-color values.
      const hitsVar =
        /var\(\s*--dz-(?:surface|surface-strong|surface-raised|brand-gradient|brand-gradient-hover|nav-fab|fab-trigger-bg)\s*[,)]/.test(
          value,
        );
      // Anything that is not a literal colour or a var() could resolve to a
      // token, so it has to be reviewed and marked rather than trusted.
      const isPlainLiteral =
        /^\s*["'`]?(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|transparent|currentColor|inherit|none|var\(\s*--[a-z0-9-]+)/.test(
          value,
        );
      if (hitsToken || hitsVar || !isPlainLiteral) {
        offenders.push(`${full.slice(ROOT.length + 1)}: ${value.trim()}`);
      }
    }
  }
}
for (const d of SCAN_DIRS) walk(join(ROOT, d));
check(
  offenders.length === 0,
  "no image-bearing token used as backgroundColor",
  offenders.join(" | "),
);

// ------------------------------------------------------------------ 4a ----
// The same trap in a second shape: an image-bearing token used as a COLOUR
// STOP inside a gradient. CSS rejects the whole gradient — the surface silently
// paints nothing at all, which is worse than a wrong colour.
const IMAGE_VARS =
  "surface|surface-strong|surface-raised|brand-gradient|brand-gradient-hover|nav-fab|fab-trigger-bg";
const GRADIENT_CALL = /(?:linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))*\)/g;
const stopLeaks: string[] = [];
for (const dir of SCAN_DIRS) {
  for (const f of collect(join(ROOT, dir))) {
    const text = readFileSync(f, "utf8");
    for (const g of text.match(GRADIENT_CALL) ?? []) {
      if (new RegExp(`var\\(\\s*--dz-(?:${IMAGE_VARS})\\s*[,)]`).test(g)) {
        stopLeaks.push(`${f.slice(ROOT.length + 1)}: ${g.slice(0, 70)}…`);
      }
    }
  }
}
check(
  stopLeaks.length === 0,
  "no image-bearing token used as a gradient colour stop",
  stopLeaks.slice(0, 5).join(" | "),
);

// ------------------------------------------------------------------ 4b ----
// A CSS custom property is only meaningful to a CSS engine. These outputs are
// consumed by something else — the OS (web-app manifest), a PDF renderer, an
// e-mail client, an HTTP response — where `var(--dz-…)` is simply an invalid
// colour that fails silently. The manifest already regressed this way once.
const NON_CSS_OUTPUTS = [
  "app/manifest.ts",
  "app/api",
  // Generated legal/financial documents and third-party render payloads. Their
  // palettes are print/video output, deliberately outside the app's UI system.
  "lib/services/billing/pdf",
  "lib/services/creatomate.service.ts",
];
const nonCssLeaks: string[] = [];
for (const target of NON_CSS_OUTPUTS) {
  const abs = join(ROOT, target);
  let files: string[] = [];
  try {
    files = statSync(abs).isDirectory() ? collect(abs) : [abs];
  } catch {
    continue;
  }
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (text.includes("var(--dz-")) {
      nonCssLeaks.push(f.slice(ROOT.length + 1));
    }
  }
}
check(
  nonCssLeaks.length === 0,
  "no CSS custom property leaked into a non-CSS output",
  nonCssLeaks.join(" | "),
);

// -------------------------------------------------------------------- 5 ----
// Accessibility: text must keep WCAG AA against every Mist ground.
function luminance(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const GROUNDS = {
  background: MIST_FLAT.background,
  surface: MIST_FLAT.surface,
  surfaceMuted: MIST_FLAT.surfaceMuted,
};
// `textDisabled` is intentionally excluded: WCAG 1.4.3 exempts disabled controls.
const AA_TEXT = [
  "textPrimary",
  "textSecondary",
  "textMuted",
  "brand",
  "brandHover",
  "success",
  "warning",
  "danger",
  "info",
] as const;

for (const [gName, ground] of Object.entries(GROUNDS)) {
  for (const t of AA_TEXT) {
    const r = ratio(MIST_FLAT[t], ground);
    check(r >= 4.5, `AA: ${t} on ${gName}`, `${r.toFixed(2)}:1`);
  }
}
// Semantic ink on its own tinted background.
for (const [ink, bg] of [
  ["success", "successBg"],
  ["warning", "warningBg"],
  ["danger", "dangerBg"],
  ["info", "infoBg"],
  ["brand", "brandSoft"],
] as const) {
  const r = ratio(MIST_FLAT[ink], MIST_FLAT[bg]);
  check(r >= 4.5, `AA: ${ink} on ${bg}`, `${r.toFixed(2)}:1`);
}
// On-brand text over the solid brand colour.
{
  const r = ratio(MIST_FLAT.textOnBrand, MIST_FLAT.brand);
  check(r >= 4.5, "AA: textOnBrand on brand", `${r.toFixed(2)}:1`);
}

// EVERY stop of every brand/chrome gradient must clear AA against the label ink
// it carries. A gradient is legible only as long as its LIGHTEST stop is — the
// pre-Mist CTA tail (#3d9c9a) sat at 3.13:1 and this check is what caught it.
const GRADIENT_VARS: Array<[string, string]> = [
  ["--dz-brand-gradient", "--dz-text-on-brand"],
  ["--dz-brand-gradient-hover", "--dz-text-on-brand"],
  ["--dz-nav-fab", "--dz-nav-fab-ink"],
  ["--dz-fab-trigger-bg", "--dz-fab-trigger-ink"],
];
for (const [gradName, inkName] of GRADIENT_VARS) {
  const grad = rootVars.get(gradName);
  const ink = rootVars.get(inkName);
  if (!grad || !ink || !/^#[0-9a-fA-F]{6}$/.test(ink)) continue;
  const stops = [...grad.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]);
  check(stops.length > 0, `${gradName} has parseable stops`);
  for (const stop of stops) {
    const r = ratio(ink, stop);
    check(r >= 4.5, `AA: ${inkName} on ${gradName} stop ${stop}`, `${r.toFixed(2)}:1`);
  }
}

/*
 * The `[data-dz-home]` block is NOT held to the same gate, and that is a
 * deliberate, declared trade-off rather than an oversight.
 *
 * Those values are the pre-Mist chrome, preserved verbatim so `/app` renders
 * pixel-identically (§12 Home exclusion). Some of them — notably the old
 * turquoise FAB ramp — already failed contrast on `main`; Dubiz Mist neither
 * introduced nor inherits them anywhere else. Raising them would repaint the
 * Home route, which the exclusion forbids. So they are REPORTED here on every
 * run, loudly and by name, instead of being silently exempted: the day the
 * owner lifts the Home freeze, this list is the work queue.
 */
const homeExceptions: string[] = [];
for (const [gradName, inkName] of GRADIENT_VARS) {
  const grad = homeVars.get(gradName);
  const ink = homeVars.get(inkName) ?? rootVars.get(inkName);
  if (!grad || !ink || !/^#[0-9a-fA-F]{6}$/.test(ink)) continue;
  for (const m of grad.matchAll(/#[0-9a-fA-F]{6}/g)) {
    const r = ratio(ink, m[0]);
    if (r < 4.5) {
      homeExceptions.push(
        `${gradName} stop ${m[0]} vs ${ink} = ${r.toFixed(2)}:1 (needs 4.5)`,
      );
    }
  }
}
if (homeExceptions.length) {
  console.log(
    `\n  NOTE — ${homeExceptions.length} pre-existing contrast issue(s) preserved` +
      ` inside the [data-dz-home] freeze (unchanged from main; fixing them` +
      ` would repaint the excluded Home route):`,
  );
  for (const e of homeExceptions) console.log(`    · ${e}`);
}

console.log(`\n  ${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`\nDubiz Mist token integrity FAILED (${failures} failures)`);
  process.exit(1);
}
console.log("Dubiz Mist token integrity PASSED");
