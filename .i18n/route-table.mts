/**
 * Static vs dynamic: the `next build` route tables of the flag-OFF and flag-ON builds of the same commit.
 * With the flag ON the root layout reads cookies() (lib/i18n/server.ts), which opts every page into
 * request-time rendering; this lists exactly which routes change and writes route-table.json.
 * Usage: npx tsx .i18n/route-table.mts <build-off.log> <build-on.log> [out.json]
 * Fails only if a log has no route table (a broken build) — the change itself is the finding.
 */
import { readFileSync, writeFileSync } from "fs";
import { diffRouteTables, parseBuildRouteTable } from "./readiness-lib";

const [offLog, onLog, out = "route-table.json"] = process.argv.slice(2);
const off = parseBuildRouteTable(readFileSync(offLog, "utf8"));
const on = parseBuildRouteTable(readFileSync(onLog, "utf8"));
const offApi = parseBuildRouteTable(readFileSync(offLog, "utf8"), true);
const onApi = parseBuildRouteTable(readFileSync(onLog, "utf8"), true);
const count = (m: Map<string, string>) => [...m.values()].reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});
const changed = diffRouteTables(off, on);
const apiChanged = diffRouteTables(offApi, onApi).filter((c) => c.route.startsWith("/api/"));
const result = {
  pages: { off: count(off), on: count(on), total: off.size },
  changed,
  apiChanged,
  staticOff: [...off].filter(([, k]) => k !== "dynamic").map(([r]) => r),
  staticOn: [...on].filter(([, k]) => k !== "dynamic").map(([r]) => r),
};
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`page routes: OFF ${JSON.stringify(result.pages.off)} · ON ${JSON.stringify(result.pages.on)}`);
console.log(`changed with the flag ON: ${changed.length} page routes, ${apiChanged.length} API routes`);
for (const c of changed) console.log(`  ${c.route.padEnd(56)} ${c.off} → ${c.on}`);
for (const c of apiChanged) console.log(`  ${c.route.padEnd(56)} ${c.off} → ${c.on}`);
if (off.size === 0 || on.size === 0) { console.error("no route table found in a build log"); process.exit(1); }
