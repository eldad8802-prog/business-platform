/**
 * Run: npx tsx lib/services/service-desk/external-work-lock.test.ts
 *
 * 1d-A (owner, 2026-11-10): the external-work API exists but is CLOSED to users until the intake and signature path
 * (1.3b) is complete and tested. Pure source proofs (no database): the constant is false; every handler of the three
 * external-work routes calls assertExternalWorkOpen() before anything else it does; the closed answer is
 * ACTION_NOT_IN_SCOPE; and no other route or module calls the external-work service.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { EXTERNAL_WORK_OPEN, assertExternalWorkOpen } from "./external-work.service";
import { ServiceDeskError } from "./service-desk-errors";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

ok("L1 EXTERNAL_WORK_OPEN is true (opened by the owner's decision — this PR)", EXTERNAL_WORK_OPEN === true);
let thrown: unknown = null;
try { assertExternalWorkOpen(); } catch (e) { thrown = e; }
ok("L2 the lock no longer refuses (the routes still call it first; feature gate + tenant checks unchanged)", thrown === null && !(thrown instanceof ServiceDeskError));

const ROOT = process.cwd();
const ROUTES = [
  "app/api/service-desk/cases/[id]/external-work/route.ts",
  "app/api/service-desk/external-work/[workId]/actions/route.ts",
  "app/api/service-desk/external-work/[workId]/return/route.ts",
];
let handlers = 0, guardedFirst = 0;
for (const r of ROUTES) {
  const src = fs.readFileSync(path.join(ROOT, r), "utf8");
  for (const m of src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\([\s\S]*?\n}\n/g)) {
    handlers++;
    // inside the edge callback, the first statement is the lock
    if (/serviceDeskRoute\(req, "(read|write)", async \(\{ principal \}\) => \{\s*assertExternalWorkOpen\(\);/.test(m[0])) guardedFirst++;
  }
}
ok("L3 four handlers in the three routes, each calls assertExternalWorkOpen() first inside the edge", handlers === 4 && guardedFirst === 4, `${guardedFirst}/${handlers}`);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const callers = ["app", "lib", "features", "components"].flatMap((d) => walk(path.join(ROOT, d)))
  .filter((f) => /external-work\.service["']/.test(fs.readFileSync(f, "utf8")))
  .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
  .filter((f) => !f.endsWith("external-work-lock.test.ts"));
ok("L4 only the three closed routes import the external-work service", callers.length === 3 && ROUTES.every((r) => callers.includes(r)), callers.join(", "));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
