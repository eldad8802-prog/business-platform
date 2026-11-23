/**
 * Activity packs — API and capabilities contract (static: reads the source files). Run:
 *   npx tsx lib/activity-packs/activity-packs-api.test.ts
 *
 * The packs are display only, but the endpoint writes a tenant row, so it must hold the usual line: a session, the
 * session's own business, the feature ON (OFF everywhere by default), a validated body, tenantTx for every query.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PLATFORM_FEATURE_CATALOG, PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const route = read("app/api/business/activity/route.ts");
const service = read("lib/services/activity-packs/activity-profile.service.ts");
const caps = read("lib/services/feature-access/business-capabilities.service.ts");

ok("catalog: activity_packs exists", PLATFORM_FEATURE_KEYS.ACTIVITY_PACKS === "activity_packs");
const entry = PLATFORM_FEATURE_CATALOG.find((e) => e.key === "activity_packs");
ok("catalog: activity_packs is ON by default (open for every business — the policy row decides first)", entry?.defaultEnabled === true);

ok("route: GET and PUT only", /export async function GET\(/.test(route) && /export async function PUT\(/.test(route) && !/export async function (POST|DELETE|PATCH)\(/.test(route));
ok("route: both require a session (401)", (route.match(/getCurrentUser\(req\)/g) ?? []).length === 2 && (route.match(/status: 401/g) ?? []).length === 2);
ok("route: both check the feature before anything else", (route.match(/if \(!\(await featureOn\(user\.businessId\)\)\) return NOT_AVAILABLE\(\);/g) ?? []).length === 2);
ok("route: 404 FEATURE_NOT_AVAILABLE while OFF", /error: "FEATURE_NOT_AVAILABLE" \}, \{ status: 404/.test(route));
ok("route: the feature check fails closed", /catch \{\s*return false;/.test(route));
ok("route: the tenant is the session's business (never the body's)", !/body\.businessId|businessId:\s*body/.test(route) && /saveActivitySelection\(user\.businessId, user\.id, parsed\.value\)/.test(route));
ok("route: the body is validated", /parseActivitySelection\(body\)/.test(route) && /status: 400/.test(route));
ok("route: no raw error text leaks", !/error\.message/.test(route));

ok("service: every query runs in tenantTx", (service.match(/tenantTx\(businessId/g) ?? []).length === 2 && !/prisma\./.test(service));
ok("service: never deletes", !/\.delete(Many)?\(/.test(service));
ok("service: writes only OWNER_SELECTED", /source: "OWNER_SELECTED"/.test(service));

ok("capabilities: packs read only while the feature is ON", /if \(features\.activity_packs\?\.allowed === true\) \{/.test(caps));
ok("capabilities: a failed read degrades to null, never an error", /catch \{\s*response\.activity = null;/.test(caps));

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nactivity-packs-api: all checks passed");
