/**
 * Run: npx tsx lib/services/service-desk/legal-approval-guard.test.ts
 *
 * Owner decision D25 (2026-11-11), item 6: nothing may grant LEGALLY_APPROVED automatically, and a business owner may not
 * declare a text legally reviewed. The database still lets the runtime role move a text DRAFT → LEGALLY_APPROVED with an
 * approver of the same business (migration 20261120090000), so until the separate schema proposal for the D25 model is
 * approved and applied, this source proof keeps every product path from doing it: no file under app/, lib/, features/ or
 * components/ (tests and labs aside) sets "legalStatus", "legallyApprovedAt" or "legallyApprovedByUserId".
 */
import * as fs from "node:fs";
import * as path from "node:path";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && !/\.test\.|\.spec\.|battery/.test(e.name)) out.push(p);
  }
  return out;
}

// A write of the approval: SQL SET / INSERT column lists, or an ORM data object naming the approval fields.
const WRITE_PATTERNS: [string, RegExp][] = [
  ["SQL SET of the approval", /SET[^;`]*"(legalStatus|legallyApprovedAt|legallyApprovedByUserId)"\s*=/i],
  ["SQL INSERT naming the approval", /INSERT\s+INTO\s+"?ServiceTextVersion"?\s*\([^)]*"(legalStatus|legallyApprovedAt|legallyApprovedByUserId)"/i],
  ["ORM data with the approval", /\b(legalStatus|legallyApprovedAt|legallyApprovedByUserId)\s*:\s*(["']LEGALLY_APPROVED["']|new Date|now\(|[A-Za-z_.]+\.id\b)/],
];

const files = ["app", "lib", "features", "components"].flatMap((d) => walk(path.join(ROOT, d)));
const hits: string[] = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const [label, re] of WRITE_PATTERNS) if (re.test(src)) hits.push(`${path.relative(ROOT, f).split(path.sep).join("/")} (${label})`);
}
ok("A1 the scan covers the product code (hundreds of files, including the intake service)", files.length > 200 && files.some((f) => f.endsWith(path.join("service-desk", "intake.service.ts"))), String(files.length));
ok("A2 no product path grants LEGALLY_APPROVED or records a legal approver (D25 item 6)", hits.length === 0, hits.join(", "));

// The detector itself catches the shapes it is meant to catch.
const probe = (src: string) => WRITE_PATTERNS.some(([, re]) => re.test(src));
ok("A3 the detector catches an UPDATE … SET \"legalStatus\" = …, an INSERT naming it, and an ORM data write",
  probe(`UPDATE "ServiceTextVersion" SET "legalStatus" = 'LEGALLY_APPROVED', "legallyApprovedAt" = now()`)
    && probe(`INSERT INTO "ServiceTextVersion" ("businessId", "legalStatus") VALUES (1, 'LEGALLY_APPROVED')`)
    && probe(`tx.serviceTextVersion.update({ data: { legalStatus: "LEGALLY_APPROVED" } })`));
ok("A4 …but not a read that compares the status (the intake view and the terms decision read it)",
  !probe(`SELECT (t."legalStatus" = 'LEGALLY_APPROVED' AND s."legalStatus" = 'LEGALLY_APPROVED') IS TRUE AS ok FROM "ServiceSettings" st`)
    && !probe(`WHERE t."legalStatus" = 'LEGALLY_APPROVED'`));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
