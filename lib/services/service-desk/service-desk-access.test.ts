/**
 * Service Desk flag — the catalog entry is the migration's seed, and every resolution path is OFF unless an explicit
 * owner decision opens it. Pure (no database).
 *   npx tsx lib/services/service-desk/service-desk-access.test.ts
 */
import fs from "node:fs";
import path from "node:path";

import { BusinessFeatureAccessState } from "@prisma/client";

import {
  PLATFORM_FEATURE_KEYS,
  getPlatformFeatureCatalogEntry,
  isPlatformFeatureKey,
} from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccessFromInputs } from "@/lib/services/feature-access/resolve-feature-access";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const KEY = PLATFORM_FEATURE_KEYS.SERVICE_DESK;
const entry = getPlatformFeatureCatalogEntry(KEY);

console.log("— 1. the catalog entry is the migration's seed, as opened by 20261221190000");
const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261120090000_service_desk_ui_foundation/migration.sql"), "utf8");
const seed = sql.match(/VALUES \('service_desk', '([^']+)', '([^']+)', '([^']+)', (true|false), (true|false), CURRENT_TIMESTAMP\)/);
check("the migration seeds service_desk", seed !== null);
check("key is a catalog key", isPlatformFeatureKey("service_desk"));
const openAll = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261221190000_service_desk_open_all/migration.sql"), "utf8");
const opened = openAll.match(/SET "defaultEnabled" = true,\s*"description" = '([^']+)'\s*WHERE "key" = 'service_desk'/);
check("displayName / category equal the seed", seed !== null && entry.displayName === seed[1] && entry.category === seed[2], JSON.stringify(entry));
check("the description equals the open-all migration's", opened !== null && entry.description === opened[1], JSON.stringify(entry.description));
check("seeded OFF (definition + policy) by 20261120090000", seed?.[4] === "false" && /VALUES \('service_desk', false, false, CURRENT_TIMESTAMP\)/.test(sql));
check("opened by 20261221190000: definition default ON + policy global ON",
  opened !== null && /UPDATE "PlatformFeaturePolicy"\s+SET "globalEnabled" = true,[^;]*WHERE "featureKey" = 'service_desk'/.test(openAll));
check("the open-all migration leaves the emergency switch and the overrides alone", !/emergencyDisabled/.test(openAll.replace(/--[^\n]*/g, "")) && !/BusinessFeatureAccess/.test(openAll.replace(/--[^\n]*/g, "")));
check("defaultEnabled true in code (open for every business once the policy is ON)", entry.defaultEnabled === true);

console.log("— 2. resolution: open for all once the policy is ON; every switch still closes");
const r = (policy: { globalEnabled: boolean; emergencyDisabled: boolean } | null, override: BusinessFeatureAccessState | null) =>
  resolveFeatureAccessFromInputs({ featureKey: KEY, catalogDefaultEnabled: entry.defaultEnabled, policy, override: override ? { state: override } : null });
check("the seeded policy (global off, the state before 20261221190000) → OFF", r({ globalEnabled: false, emergencyDisabled: false }, null).allowed === false);
check("the opened policy (global on), no override → ON for every business, a new one included", r({ globalEnabled: true, emergencyDisabled: false }, null).allowed === true);
check("the opened policy + a DISABLED business override → OFF", r({ globalEnabled: true, emergencyDisabled: false }, BusinessFeatureAccessState.DISABLED).allowed === false);
check("the opened policy + the emergency switch → OFF", r({ globalEnabled: true, emergencyDisabled: true }, null).allowed === false);
check("a DISABLED business override (global off) → OFF", r({ globalEnabled: false, emergencyDisabled: false }, BusinessFeatureAccessState.DISABLED).allowed === false);
check("emergency switch beats an ENABLED override → OFF", r({ globalEnabled: true, emergencyDisabled: true }, BusinessFeatureAccessState.ENABLED).allowed === false);
check("while the policy is global OFF only an explicit ENABLED override opens it (the pilot)",
  r({ globalEnabled: false, emergencyDisabled: false }, BusinessFeatureAccessState.ENABLED).allowed === true);

console.log("— 3. the helper is fail-closed");
const helper = fs.readFileSync(path.join(process.cwd(), "lib/services/service-desk/service-desk-access.ts"), "utf8");
check("any error reads as OFF (catch → false)", /catch\s*\{\s*return false;\s*\}/.test(helper));
check("allowed only when === true", helper.includes("r.allowed === true"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
