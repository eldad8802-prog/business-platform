/**
 * App document-title metadata hierarchy (Wave 3 · F-24). Run:
 *   npx tsx lib/navigation/app-title-metadata.test.ts
 *
 * Non-brittle source guard (no DOM snapshots): the root must brand as Dubiz with
 * a "%s · Dubiz" template, the generic "Business Platform" title must never
 * reappear in any layout/page metadata, and the main sections keep their unique
 * Hebrew titles. Guards the regression, not exact rendered strings.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const APP = join(process.cwd(), "app");
function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

// --- root: Dubiz brand default + suffix template, no Business Platform -----
const root = read("app/layout.tsx");
ok("root: no 'Business Platform' title", !/Business Platform/.test(root), root.slice(0, 0));
ok("root: default is Dubiz", /default:\s*["']Dubiz["']/.test(root));
ok("root: template is '%s · Dubiz'", /template:\s*["']%s · Dubiz["']/.test(root));

// --- no layout/page anywhere reintroduces the generic title ---------------
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/^(layout|page)\.tsx$/.test(name)) out.push(p);
  }
  return out;
}
const offenders = walk(APP).filter((f) => /["']Business Platform["']/.test(readFileSync(f, "utf8")));
ok("no layout/page metadata contains 'Business Platform'", offenders.length === 0, offenders);

// --- main sections keep their unique Hebrew titles ------------------------
const sections: Array<[string, string]> = [
  ["app/(shell)/app/layout.tsx", "בית"],
  ["app/(shell)/documents/layout.tsx", "מסמכים"],
  ["app/(shell)/inventory/layout.tsx", "מלאי"],
  ["app/(shell)/suppliers/layout.tsx", "ספקים"],
  ["app/billing/layout.tsx", "חשבוניות"],
  ["app/settings/layout.tsx", "הגדרות"],
  ["app/login/layout.tsx", "התחברות"],
  ["app/register/layout.tsx", "הרשמה"],
];
for (const [file, title] of sections) {
  const src = read(file);
  ok(`${file} → title "${title}"`, new RegExp(`title:\\s*["']${title}["']`).test(src), src.slice(0, 0));
}

// --- public group untouched (still its own Dubiz template) ----------------
const corp = read("app/(corporate)/layout.tsx");
ok("public (corporate) group keeps its own Dubiz metadata", /Dubiz/.test(corp) && !/Business Platform/.test(corp));

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll app-title-metadata (F-24) assertions passed");
