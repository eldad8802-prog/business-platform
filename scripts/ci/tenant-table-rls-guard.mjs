#!/usr/bin/env node
// tenant-table-rls-guard — every tenant table ships with its isolation, or the build stops.
//
// WHAT IT PREVENTS
//
// Production runs as a NOBYPASSRLS role, and every tenant table is FORCE RLS. A
// new table that arrives WITHOUT RLS is not "unprotected but harmless": this
// project's databases carry ALTER DEFAULT PRIVILEGES granting app_runtime
// a,r,w,d on every new table (20260908200000_auth_session_privilege_contract),
// so it would be readable and writable across every business the moment its
// migration ran. Nothing in the one REQUIRED check (release/verify) looked at
// that — the RLS batteries are path-filtered and advisory, so a PR that simply
// did not touch their paths skipped them and merged green.
//
// THE RULES (derived from the repository alone — no database, no network)
//
//   R1  Every Prisma model with a `businessId` column maps to a table that some
//       migration puts under ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL
//       SECURITY, and at least one CREATE POLICY keyed on
//       current_setting('app.current_business_id').
//       Exceptions live in EXEMPT below, each with its reason. The list is a
//       RATCHET: an entry whose table no longer exists, no longer has a
//       businessId, or has since gained full RLS fails the guard, so the list can
//       only shrink.
//
//   R2  A table CREATED by a migration newer than NEW_TABLE_CUTOFF must also:
//         a. use per-command policies only — no `FOR ALL` and no policy without a
//            FOR clause (both silently include DELETE; see cutover2b), and
//         b. name its privileges explicitly: some migration GRANTs on the table to
//            app_runtime (a default ACL is not a decision — see the inbound email
//            foundation migration for why).
//
// EXIT CODES: 0 = pass, 1 = violation, 2 = could not evaluate (blocks too).
//
// Run the mutation proofs: node scripts/ci/tenant-table-rls-guard.mjs --self-test

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Migrations at or after this directory prefix are held to R2. */
export const NEW_TABLE_CUTOFF = "20260927000000";

/**
 * Tables that carry `businessId` but are deliberately NOT tenant-RLS'd.
 * Adding to this list is an architecture decision, not a convenience.
 */
export const EXEMPT = {
  User: "auth plane — read before any tenant exists; column-level grants instead (20260908180000)",
  WhatsAppConnection:
    "provider-bootstrap table (docs/security-d2-provider-bootstrap-allowlist-v1.md)",
  POSApiKey: "provider-bootstrap table (docs/security-d2-provider-bootstrap-allowlist-v1.md)",
  PaymentProviderRouting:
    "provider-bootstrap table (docs/security-d2-provider-bootstrap-allowlist-v1.md)",
  ProductUsageEvent:
    "KNOWN GAP — product analytics with nullable businessId, global writer; recorded in the M1 audit",
  InventorySale:
    "P0 sale evidence applied in Production by 20260926120000 before this guard; the application release adds no migration",
  InventorySaleLine:
    "P0 sale evidence applied in Production by 20260926120000 before this guard; the application release adds no migration",
  InventorySourceSaleLine:
    "P0 source-line evidence applied in Production by 20260927120000 before this guard; the application release adds no migration",
  BusinessAsset:
    "P0 asset provenance applied in Production by 20260927120000 before this guard; the application release adds no migration",
};

/**
 * Tables created on or after the cutoff that merged BEFORE this guard existed
 * and do not meet R2. Recorded debt, not approval: the guard does not rewrite
 * history, but it names what it is not holding to R2 and why. A RATCHET — an
 * entry that now meets R2, or that no longer names a new tenant table, fails.
 */
export const R2_GRANDFATHERED = {
  InstallmentWorkflow:
    "payables Phase 2 (#538), merged 2026-09-27 before this guard; tenant policy is FOR ALL (includes DELETE) — to be split per command in a payables follow-up",
  InventorySourceSaleLine:
    "P0 source-line table (20260927120000) merged in #544 before this guard, with no app_runtime GRANT in that migration",
  BusinessAsset:
    "P0 asset table (20260927120000) merged in #544 before this guard, with no app_runtime GRANT in that migration",
};

// ── pure helpers (exercised by --self-test) ───────────────────────────────────

/** Models → { table, hasBusinessId }. Reads @@map; ignores comments. */
export function parseModels(schemaSrc) {
  const models = [];
  let cur = null;
  for (const raw of String(schemaSrc).split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const open = line.match(/^model\s+([A-Za-z0-9_]+)\s*\{$/);
    if (open) {
      cur = { name: open[1], table: open[1], hasBusinessId: false };
      continue;
    }
    if (!cur) continue;
    if (line === "}") {
      models.push(cur);
      cur = null;
      continue;
    }
    if (/^businessId\s+Int\b/.test(line)) cur.hasBusinessId = true;
    const map = line.match(/^@@map\("([^"]+)"\)/);
    if (map) cur.table = map[1];
  }
  return models;
}

/** Strip SQL line comments and collapse whitespace so statements match on one line. */
export function normalizeSql(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ");
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every CREATE POLICY statement on `table`, as normalized text. */
export function policiesOn(sqlNorm, table) {
  const re = new RegExp(`CREATE POLICY "?[A-Za-z0-9_]+"? ON "${esc(table)}"[^;]*;`, "gi");
  return sqlNorm.match(re) ?? [];
}

export function rlsFacts(sqlNorm, table) {
  const t = esc(table);
  const policies = policiesOn(sqlNorm, table);
  return {
    enabled: new RegExp(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`, "i").test(sqlNorm),
    forced: new RegExp(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`, "i").test(sqlNorm),
    tenantPolicy: policies.some((p) => /current_setting\('app\.current_business_id'/i.test(p)),
    policies,
    granted: new RegExp(`GRANT [A-Z, ]+ ON (TABLE )?"${t}" TO app_runtime`, "i").test(sqlNorm),
  };
}

/** A policy with no FOR clause is FOR ALL. Both include DELETE. */
export function isForAll(policySql) {
  const m = policySql.match(/ ON "[^"]+" (AS (PERMISSIVE|RESTRICTIVE) )?FOR (SELECT|INSERT|UPDATE|DELETE|ALL)\b/i);
  return !m || m[3].toUpperCase() === "ALL";
}

/** Tables created by migrations at/after the cutoff. */
export function newTables(migrations, cutoff = NEW_TABLE_CUTOFF) {
  const out = new Set();
  for (const { dir, sql } of migrations) {
    if (dir < cutoff) continue;
    for (const m of normalizeSql(sql).matchAll(/CREATE TABLE (IF NOT EXISTS )?"([A-Za-z0-9_]+)"/gi)) {
      out.add(m[2]);
    }
  }
  return out;
}

/**
 * The whole decision. `migrations` is [{ dir, sql }] in any order.
 * Returns a list of violations; empty means pass.
 */
export function evaluate({
  schemaSrc,
  migrations,
  exempt = EXEMPT,
  cutoff = NEW_TABLE_CUTOFF,
  grandfathered = R2_GRANDFATHERED,
}) {
  const violations = [];
  const all = normalizeSql(migrations.map((m) => m.sql).join("\n"));
  const models = parseModels(schemaSrc);
  const tenantTables = new Map(models.filter((m) => m.hasBusinessId).map((m) => [m.table, m]));

  // R1
  for (const [table, model] of tenantTables) {
    const f = rlsFacts(all, table);
    const complete = f.enabled && f.forced && f.tenantPolicy;
    if (Object.prototype.hasOwnProperty.call(exempt, table)) {
      if (complete) {
        violations.push(`R1 stale exemption: "${table}" now has full tenant RLS — remove it from EXEMPT`);
      }
      continue;
    }
    if (!complete) {
      const missing = [
        f.enabled ? null : "ENABLE ROW LEVEL SECURITY",
        f.forced ? null : "FORCE ROW LEVEL SECURITY",
        f.tenantPolicy ? null : "a CREATE POLICY keyed on app.current_business_id",
      ].filter(Boolean);
      violations.push(`R1 model ${model.name} (table "${table}") has businessId but no ${missing.join(", ")}`);
    }
  }
  for (const table of Object.keys(exempt)) {
    if (!tenantTables.has(table)) {
      violations.push(`R1 stale exemption: "${table}" is not a model with businessId any more — remove it`);
    }
  }

  // R2
  const created = newTables(migrations, cutoff);
  for (const table of created) {
    if (!tenantTables.has(table)) continue;
    const f = rlsFacts(all, table);
    const r2 = [];
    for (const p of f.policies) {
      if (isForAll(p)) {
        r2.push(`R2 new table "${table}" has a FOR ALL policy (or one with no FOR clause): ${p.slice(0, 120)}`);
      }
    }
    if (!f.granted) {
      r2.push(`R2 new table "${table}" has no explicit GRANT ... TO app_runtime`);
    }
    if (Object.prototype.hasOwnProperty.call(grandfathered, table)) {
      if (r2.length === 0) {
        violations.push(`R2 stale grandfather: "${table}" now meets R2 — remove it from R2_GRANDFATHERED`);
      }
      continue;
    }
    violations.push(...r2);
  }
  for (const table of Object.keys(grandfathered)) {
    if (!created.has(table) || !tenantTables.has(table)) {
      violations.push(`R2 stale grandfather: "${table}" is not a tenant table created after the cutoff — remove it`);
    }
  }
  return violations;
}

// ── repository I/O ───────────────────────────────────────────────────────────

function readRepo(root) {
  const schemaSrc = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
  const dir = path.join(root, "prisma", "migrations");
  const migrations = [];
  for (const d of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, d, "migration.sql");
    if (fs.existsSync(f)) migrations.push({ dir: d, sql: fs.readFileSync(f, "utf8") });
  }
  return { schemaSrc, migrations };
}

// ── self-test: each rule must be able to fail ─────────────────────────────────

function selfTest() {
  const pred = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;
  const schema = (extra = "") => `
model Business { id Int @id }
model Widget {
  id Int @id
  businessId Int
}
${extra}`;
  const fullRls = (t, forAll = false) => `
ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;
CREATE POLICY p_${t} ON "${t}" ${forAll ? "" : "FOR SELECT "}USING (${pred});
GRANT SELECT, INSERT ON "${t}" TO app_runtime;`;
  const cases = [
    {
      name: "compliant old table passes",
      input: { schemaSrc: schema(), migrations: [{ dir: "20260101000000_a", sql: `CREATE TABLE "Widget" (id int);${fullRls("Widget")}` }], exempt: {} },
      expect: 0,
    },
    {
      name: "missing FORCE fails R1",
      input: {
        schemaSrc: schema(),
        migrations: [{ dir: "20260101000000_a", sql: `CREATE TABLE "Widget" (id int); ALTER TABLE "Widget" ENABLE ROW LEVEL SECURITY; CREATE POLICY p ON "Widget" FOR SELECT USING (${pred});` }],
        exempt: {},
      },
      expect: 1,
    },
    {
      name: "no RLS at all fails R1",
      input: { schemaSrc: schema(), migrations: [{ dir: "20260101000000_a", sql: `CREATE TABLE "Widget" (id int);` }], exempt: {} },
      expect: 1,
    },
    {
      name: "policy not keyed on the tenant GUC fails R1",
      input: {
        schemaSrc: schema(),
        migrations: [{ dir: "20260101000000_a", sql: `CREATE TABLE "Widget" (id int); ALTER TABLE "Widget" ENABLE ROW LEVEL SECURITY; ALTER TABLE "Widget" FORCE ROW LEVEL SECURITY; CREATE POLICY p ON "Widget" FOR SELECT USING (true);` }],
        exempt: {},
      },
      expect: 1,
    },
    {
      name: "commented-out RLS does not count",
      input: {
        schemaSrc: schema(),
        migrations: [{ dir: "20260101000000_a", sql: `CREATE TABLE "Widget" (id int);\n-- ALTER TABLE "Widget" ENABLE ROW LEVEL SECURITY;\n-- ALTER TABLE "Widget" FORCE ROW LEVEL SECURITY;\n-- CREATE POLICY p ON "Widget" FOR SELECT USING (${pred});` }],
        exempt: {},
      },
      expect: 1,
    },
    {
      name: "exempt table passes R1",
      input: { schemaSrc: schema(), migrations: [{ dir: "20260101000000_a", sql: `CREATE TABLE "Widget" (id int);` }], exempt: { Widget: "bootstrap" } },
      expect: 0,
    },
    {
      name: "stale exemption (table now has RLS) fails",
      input: { schemaSrc: schema(), migrations: [{ dir: "20260101000000_a", sql: `CREATE TABLE "Widget" (id int);${fullRls("Widget")}` }], exempt: { Widget: "bootstrap" } },
      expect: 1,
    },
    {
      name: "stale exemption (no such model) fails",
      input: { schemaSrc: schema(), migrations: [{ dir: "20260101000000_a", sql: `CREATE TABLE "Widget" (id int);${fullRls("Widget")}` }], exempt: { Gone: "x" } },
      expect: 1,
    },
    {
      name: "@@map table name is what is checked",
      input: {
        schemaSrc: `model Gadget {\n  id Int @id\n  businessId Int\n  @@map("gadgets")\n}`,
        migrations: [{ dir: "20260101000000_a", sql: `CREATE TABLE "gadgets" (id int);${fullRls("gadgets")}` }],
        exempt: {},
      },
      expect: 0,
    },
    {
      name: "NEW table with FOR ALL policy fails R2",
      input: { schemaSrc: schema(), migrations: [{ dir: "20260930000000_new", sql: `CREATE TABLE "Widget" (id int);${fullRls("Widget", true)}` }], exempt: {} },
      expect: 1,
    },
    {
      name: "OLD table with FOR ALL policy is grandfathered",
      input: { schemaSrc: schema(), migrations: [{ dir: "20260101000000_a", sql: `CREATE TABLE "Widget" (id int);${fullRls("Widget", true)}` }], exempt: {} },
      expect: 0,
    },
    {
      name: "NEW table without explicit GRANT fails R2",
      input: {
        schemaSrc: schema(),
        migrations: [{ dir: "20260930000000_new", sql: `CREATE TABLE "Widget" (id int); ALTER TABLE "Widget" ENABLE ROW LEVEL SECURITY; ALTER TABLE "Widget" FORCE ROW LEVEL SECURITY; CREATE POLICY p ON "Widget" FOR SELECT USING (${pred});` }],
        exempt: {},
      },
      expect: 1,
    },
    {
      name: "NEW compliant table passes R2",
      input: { schemaSrc: schema(), migrations: [{ dir: "20260930000000_new", sql: `CREATE TABLE "Widget" (id int);${fullRls("Widget")}` }], exempt: {} },
      expect: 0,
    },
    {
      name: "grandfathered NEW table with FOR ALL passes R2",
      input: { schemaSrc: schema(), migrations: [{ dir: "20260930000000_new", sql: `CREATE TABLE "Widget" (id int);${fullRls("Widget", true)}` }], exempt: {}, grandfathered: { Widget: "pre-guard" } },
      expect: 0,
    },
    {
      name: "stale grandfather (table now meets R2) fails",
      input: { schemaSrc: schema(), migrations: [{ dir: "20260930000000_new", sql: `CREATE TABLE "Widget" (id int);${fullRls("Widget")}` }], exempt: {}, grandfathered: { Widget: "pre-guard" } },
      expect: 1,
    },
    {
      name: "grandfather entry that is not a new table fails",
      input: { schemaSrc: schema(), migrations: [{ dir: "20260930000000_new", sql: `CREATE TABLE "Widget" (id int);${fullRls("Widget")}` }], exempt: {}, grandfathered: { Gone: "x" } },
      expect: 1,
    },
  ];
  let failed = 0;
  for (const c of cases) {
    // Hermetic: a case sees only the lists it names, never the real ones.
    const v = evaluate({ grandfathered: {}, ...c.input });
    const got = v.length === 0 ? 0 : 1;
    const pass = got === c.expect;
    if (!pass) failed++;
    console.log(`  [${pass ? "PASS" : "FAIL"}] ${c.name}${pass ? "" : ` — got ${JSON.stringify(v)}`}`);
  }
  if (failed) {
    console.log(`tenant-table-rls-guard self-test: ${failed} FAILED`);
    process.exit(1);
  }
  console.log(`tenant-table-rls-guard self-test: ${cases.length} passed`);
}

// ── main ─────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    let violations;
    try {
      const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
      violations = evaluate(readRepo(root));
    } catch (error) {
      console.error(`tenant-table-rls-guard: could not evaluate — ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
    if (violations.length > 0) {
      console.error("tenant-table-rls-guard: FAIL");
      for (const v of violations) console.error(`  - ${v}`);
      process.exit(1);
    }
    console.log("tenant-table-rls-guard: PASS — every businessId table is tenant-RLS'd or explicitly exempt");
  }
}
