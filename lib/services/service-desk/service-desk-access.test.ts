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

console.log("— 1. the catalog entry is the migration's seed");
const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261120090000_service_desk_ui_foundation/migration.sql"), "utf8");
const seed = sql.match(/VALUES \('service_desk', '([^']+)', '([^']+)', '([^']+)', (true|false), (true|false), CURRENT_TIMESTAMP\)/);
check("the migration seeds service_desk", seed !== null);
check("key is a catalog key", isPlatformFeatureKey("service_desk"));
check("displayName / category / description equal the seed", seed !== null
  && entry.displayName === seed[1] && entry.category === seed[2] && entry.description === seed[3], JSON.stringify(entry));
check("defaultEnabled false, as seeded", entry.defaultEnabled === false && seed?.[4] === "false");
check("the global policy is seeded OFF", /VALUES \('service_desk', false, false, CURRENT_TIMESTAMP\)/.test(sql));

console.log("— 2. fail-closed resolution");
const r = (policy: { globalEnabled: boolean; emergencyDisabled: boolean } | null, override: BusinessFeatureAccessState | null) =>
  resolveFeatureAccessFromInputs({ featureKey: KEY, catalogDefaultEnabled: entry.defaultEnabled, policy, override: override ? { state: override } : null });
check("no policy row (a database without 1.3-0) → OFF", r(null, null).allowed === false);
check("the seeded policy (global off) → OFF", r({ globalEnabled: false, emergencyDisabled: false }, null).allowed === false);
check("a DISABLED business override → OFF", r({ globalEnabled: false, emergencyDisabled: false }, BusinessFeatureAccessState.DISABLED).allowed === false);
check("emergency switch beats an ENABLED override → OFF", r({ globalEnabled: true, emergencyDisabled: true }, BusinessFeatureAccessState.ENABLED).allowed === false);
check("only an explicit ENABLED business override opens it (owner decision, not taken)",
  r({ globalEnabled: false, emergencyDisabled: false }, BusinessFeatureAccessState.ENABLED).allowed === true);

console.log("— 3. the helper is fail-closed");
const helper = fs.readFileSync(path.join(process.cwd(), "lib/services/service-desk/service-desk-access.ts"), "utf8");
check("any error reads as OFF (catch → false)", /catch\s*\{\s*return false;\s*\}/.test(helper));
check("allowed only when === true", helper.includes("r.allowed === true"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
