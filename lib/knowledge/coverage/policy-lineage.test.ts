/**
 * All-Feature Learning Coverage — catalogue ↔ migration consistency. No database. Run:
 *   npx tsx lib/knowledge/coverage/policy-lineage.test.ts
 *
 * The derivation resolver is fail-closed: a rule whose policy lineage has no row refuses at the
 * "policy" stage. So the lineage rows ARE part of every rule, and they ship in a migration that must
 * be applied before the code (migration-first). This holds the two together: every policy key the
 * catalogues use is seeded by exactly one shipped migration, with v1; and the coverage migration
 * seeds nothing the catalogues do not use, and changes nothing but governance rows.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { catalogueDescriptors } from "../registry";
import { temporalCatalogue } from "../temporal/rules";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const MIGRATIONS = join(process.cwd(), "prisma/migrations");
const COVERAGE = "20261008090000_learning_coverage_policies";
const strip = (sql: string) => sql.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const keysIn = (sql: string) => {
  const ins = strip(sql).match(/INSERT INTO "DerivationPolicy" \("key", "name"\) VALUES([\s\S]*?)ON CONFLICT/);
  return ins ? [...ins[1].matchAll(/\(\s*'([a-z0-9-]+)'\s*,/g)].map((m) => m[1]) : [];
};

const seededBy = new Map<string, string[]>();
for (const dir of readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort()) {
  let sql = "";
  try { sql = readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8"); } catch { continue; }
  for (const k of keysIn(sql)) seededBy.set(k, [...(seededBy.get(k) ?? []), dir]);
}

const used = [
  ...catalogueDescriptors().map((d) => ({ id: d.ruleId, key: d.policyKey })),
  ...temporalCatalogue().map((t) => ({ id: t.ruleId, key: t.policyKey })),
];
for (const u of used) {
  const by = seededBy.get(u.key) ?? [];
  ok(`${u.id}: lineage '${u.key}' is seeded by exactly one migration`, by.length === 1, by);
}

const sql = readFileSync(join(MIGRATIONS, COVERAGE, "migration.sql"), "utf8");
const coverageKeys = keysIn(sql);
const usedKeys = new Set(used.map((u) => u.key));
ok("the coverage migration seeds 33 lineages (26 measure + 7 temporal)", coverageKeys.length === 33, coverageKeys.length);
ok("…every one of them used by a catalogue (nothing speculative)", coverageKeys.every((k) => usedKeys.has(k)), coverageKeys.filter((k) => !usedKeys.has(k)));
const versionBlock = strip(sql).match(/INSERT INTO "DerivationPolicyVersion"[\s\S]*?WHERE p\."key" IN \(([\s\S]*?)\)/);
const versioned = versionBlock ? [...versionBlock[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]) : [];
ok("…and each gets its v1 version row", coverageKeys.every((k) => versioned.includes(k)) && versioned.length === coverageKeys.length);
ok("governance rows only: no DDL, RLS, grants, updates or deletes",
  !/\b(CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|UPDATE|DELETE)\b/i.test(strip(sql).replace(/'(?:[^']|'')*'/g, "''")));
ok("idempotent: both inserts ON CONFLICT DO NOTHING", (strip(sql).match(/ON CONFLICT \([^)]*\) DO NOTHING/g) ?? []).length === 2);

console.log(failed === 0 ? "\nPolicy lineages: every rule is versioned by a shipped migration, and the migration seeds only real rules. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
