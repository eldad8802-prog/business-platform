/**
 * Run: npx tsx lib/services/service-desk/intake-orphan-sweep.test.ts
 *
 * The intake orphan sweep, pure parts: which keys it may judge (exact intake shapes of THIS business only) and the age
 * rule (never younger than the 1 h floor; no time → kept). The deletion itself is proven in the PG lab (.sd13b, section O).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { SWEEP_GRACE_MIN_MS, oldEnough, parseIntakeKey } from "./intake-orphan-sweep";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}
const H = "a".repeat(64);

ok("K1 the three intake shapes of this business are recognised, with their case and kind",
  parseIntakeKey(`biz/7/service/cases/3/intake/photos/${H}.jpg`, 7)?.kind === "photo"
    && parseIntakeKey(`biz/7/service/cases/3/intake/signature/${H}.png`, 7)?.kind === "signature"
    && parseIntakeKey(`biz/7/service/cases/3/intake/slip/${H}.pdf`, 7)?.caseId === 3);
ok("K2 another business's key, another domain, another folder or a traversal → not this sweep's",
  parseIntakeKey(`biz/70/service/cases/3/intake/photos/${H}.jpg`, 7) === null
    && parseIntakeKey(`biz/7/business-docs/cases/3/intake/photos/${H}.jpg`, 7) === null
    && parseIntakeKey(`biz/7/service/cases/3/handover/${H}.png`, 7) === null
    && parseIntakeKey(`biz/7/service/cases/3/intake/photos/../${H}.jpg`, 7) === null);
ok("K3 a wrong extension for its folder, a short hash or case 0 → not judged",
  parseIntakeKey(`biz/7/service/cases/3/intake/signature/${H}.jpg`, 7) === null
    && parseIntakeKey(`biz/7/service/cases/3/intake/slip/${H}.png`, 7) === null
    && parseIntakeKey(`biz/7/service/cases/3/intake/photos/${H}.pdf`, 7) === null
    && parseIntakeKey(`biz/7/service/cases/3/intake/photos/abc.jpg`, 7) === null
    && parseIntakeKey(`biz/7/service/cases/0/intake/photos/${H}.jpg`, 7) === null);
const now = new Date("2026-11-11T12:00:00.000Z");
ok("A1 older than the grace → judged; younger → kept as in flight; no / bad time → kept",
  oldEnough("2026-11-10T11:00:00.000Z", now, 24 * 3600_000) === "OK" && oldEnough("2026-11-11T11:30:00.000Z", now, 24 * 3600_000) === "TOO_YOUNG"
    && oldEnough(undefined, now, 1) === "NO_TIME" && oldEnough("not a date", now, 1) === "NO_TIME");
ok("A2 a grace below the 1 h floor is raised to it (an object 10 minutes old is never judged)",
  oldEnough(new Date(now.getTime() - 10 * 60_000).toISOString(), now, 0) === "TOO_YOUNG"
    && oldEnough(new Date(now.getTime() - SWEEP_GRACE_MIN_MS).toISOString(), now, 0) === "OK");
const src = fs.readFileSync(path.join(process.cwd(), "lib/services/service-desk/intake-orphan-sweep.ts"), "utf8");
ok("S1 dry run is the default, and the delete happens only inside the locked transaction after the no-row check",
  /const dryRun = opts\.dryRun !== false;/.test(src) && /FOR UPDATE[\s\S]*if \(linked\) return "LINKED"[\s\S]*if \(!dryRun\) await storage\.deleteObject/.test(src));
const callers = ["app", "lib", "features", "scripts"].flatMap(function walk(d: string): string[] {
  const p = path.join(process.cwd(), d);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p, { withFileTypes: true }).flatMap((e) => e.name === "node_modules" || e.name.startsWith(".") ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx|mjs)$/.test(e.name) ? [path.join(d, e.name)] : []);
}).filter((f) => !/intake-orphan-sweep(\.test)?\.ts$/.test(f) && /from "[^"]*intake-orphan-sweep"/.test(fs.readFileSync(path.join(process.cwd(), f), "utf8")));
ok("S2 NOT scheduled: no route, cron or script calls the sweep (owner: prepare, do not run)", callers.length === 0, callers.join(", "));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
