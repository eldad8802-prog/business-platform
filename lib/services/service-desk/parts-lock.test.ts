/**
 * Run: npx tsx lib/services/service-desk/parts-lock.test.ts
 *
 * 1d-B (owner, 2026-11-10): the parts API without stock movements exists but is CLOSED to users until the intake and
 * signature path (1.3b) is complete and tested. Pure source proofs (no database): the constant is false; every handler
 * of the two parts routes calls assertPartsApiOpen() first; the closed answer is ACTION_NOT_IN_SCOPE; only those routes
 * import the service; exactly four actions are in scope and every other part action is refused with a reason; and the
 * service never calls the inventory writer, never writes an inventory table and never links a movement.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { PART_EVENT_KINDS, type PartActionType } from "./parts.contracts";
import { IN_SCOPE_PART_ACTIONS, OUT_OF_SCOPE_PART_ACTIONS, PARTS_API_OPEN, assertPartsApiOpen } from "./parts.service";
import { ServiceDeskError } from "./service-desk-errors";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

ok("P1 PARTS_API_OPEN is true (opened by the owner's decision — this PR)", PARTS_API_OPEN === true);
let thrown: unknown = null;
try { assertPartsApiOpen(); } catch (e) { thrown = e; }
ok("P2 the lock no longer refuses (the routes still call it first; feature gate + tenant checks unchanged)", thrown === null && !(thrown instanceof ServiceDeskError));

const ROOT = process.cwd();
const ROUTES = ["app/api/service-desk/cases/[id]/parts/route.ts", "app/api/service-desk/parts/[partId]/actions/route.ts"];
let handlers = 0, guardedFirst = 0;
for (const r of ROUTES) {
  const src = fs.readFileSync(path.join(ROOT, r), "utf8");
  for (const m of src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\([\s\S]*?\n}\n/g)) {
    handlers++;
    if (/serviceDeskRoute\(req, "(read|write)", async \(\{ principal \}\) => \{\s*assertPartsApiOpen\(\);/.test(m[0])) guardedFirst++;
  }
}
ok("P3 three handlers in the two routes, each calls assertPartsApiOpen() first inside the edge", handlers === 3 && guardedFirst === 3, `${guardedFirst}/${handlers}`);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const callers = ["app", "lib", "features", "components"].flatMap((d) => walk(path.join(ROOT, d)))
  .filter((f) => /parts\.service["']/.test(fs.readFileSync(f, "utf8")))
  .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
  .filter((f) => !f.endsWith("parts-lock.test.ts"));
ok("P4 only the two closed routes import the parts service", callers.length === 2 && ROUTES.every((r) => callers.includes(r)), callers.join(", "));

const ALL: PartActionType[] = ["RESERVE", "RELEASE", "MARK_ON_ORDER", "UPDATE_ORDER", "ISSUE", "INSTALL", "RETURN", "WRITE_OFF", "CANCEL", "SET_PRICE", "RECORD_QUOTED", "CORRECT_COST", "SEND_WITH_EXTERNAL", "RESOLVE_FROM_EXTERNAL"];
ok("P5 exactly RESERVE, RELEASE, SET_PRICE and CANCEL are in scope", JSON.stringify([...IN_SCOPE_PART_ACTIONS].sort()) === JSON.stringify(["CANCEL", "RELEASE", "RESERVE", "SET_PRICE"]));
ok("P6 every other part action is out of scope with a reason (ISSUE, RETURN, orders, external, install, write-off, cost, quote)",
  ALL.every((a) => (IN_SCOPE_PART_ACTIONS as readonly string[]).includes(a) !== (a in OUT_OF_SCOPE_PART_ACTIONS))
    && Object.values(OUT_OF_SCOPE_PART_ACTIONS).every((r) => typeof r === "string" && r.length > 10)
    && ["ISSUE", "RETURN", "MARK_ON_ORDER", "UPDATE_ORDER", "SEND_WITH_EXTERNAL"].every((a) => a in OUT_OF_SCOPE_PART_ACTIONS));

const SRC = fs.readFileSync(path.join(ROOT, "lib/services/service-desk/parts.service.ts"), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // comments out
ok("P7 the service never calls the inventory writer and never writes an inventory table",
  !/inventoryService|createMovement|addStock|removeStock|inventory\.service/.test(CODE)
    && !/(INSERT INTO|UPDATE|DELETE FROM)\s+"Inventory/i.test(CODE));
ok("P8 the service never links a stock movement and never inserts a part beyond NEEDED (the insert names no state)",
  !/issueMovementId"?\s*=|returnMovementId"?\s*=|"issueMovementId",|"returnMovementId",/.test(CODE.replace(/SELECT[\s\S]*?FROM "ServicePart" WHERE id = \$\{partId\}::int AND "businessId" = \$\{b\}::int FOR UPDATE/g, ""))
    && /INSERT INTO "ServicePart" \("businessId", "caseId", source, "inventoryItemId", "nameSnapshot"/.test(CODE) && !/INSERT INTO "ServicePart" \([^)]*\bstate\b/.test(CODE));
ok("P9 the inventory is only READ (InventoryItem appears in SELECT statements only)", (CODE.match(/"InventoryItem"/g) ?? []).length === (CODE.match(/FROM "InventoryItem"/g) ?? []).length && /FROM "InventoryItem"/.test(CODE));
ok("P10 the part event kinds this PR can write are ADDED, RESERVED, RELEASED, PRICE_SET, CANCELLED (all known kinds)",
  ["ADDED", "RESERVED", "RELEASED", "PRICE_SET", "CANCELLED"].every((k) => (PART_EVENT_KINDS as readonly string[]).includes(k)));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
