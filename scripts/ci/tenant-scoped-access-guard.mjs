#!/usr/bin/env node
/**
 * One rule: application code does not touch a FORCE-RLS tenant table on the
 * bare Prisma client.
 *
 * WHY A STATIC GUARD AT ALL
 *
 * This defect class has now been found five times, and every instance looked
 * fine in review and in tests. It cannot be caught by an ordinary integration
 * test, because a test that establishes a tenant context — as most do, in order
 * to create their own fixtures — makes the unscoped call work. The failure only
 * appears in the posture of a real request: a governed role, no ambient
 * context. That posture is expensive to reproduce everywhere, and cheap to
 * check for here.
 *
 * WHAT IT CHECKS
 *
 * The tables are not listed by hand: they are read from the migrations that put
 * them under FORCE ROW LEVEL SECURITY, so a new tenant table is covered the day
 * its migration lands. Any `prisma.<thatModel>.<op>(` in app/ or lib/ is a
 * violation unless its file is allowed below.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 *
 * Whether a call is *inside* a tenant transaction. A grep cannot see that, and
 * a rule that guesses would either miss the real cases or bury the next person
 * in false positives. `tx.<model>` reads are invisible to this guard by
 * construction, which is exactly the intent: the fix for a violation is to go
 * through a transaction client, and then this guard stops seeing it.
 *
 * THE ALLOWLIST IS NOT A PARKING SPACE
 *
 * Each entry names code that must see across tenants or runs before one exists.
 * Adding a file here is a decision about the architecture, not a way to quiet a
 * failure — which is why each entry carries the reason it is exempt.
 *
 * Run: node scripts/ci/tenant-scoped-access-guard.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Files permitted to reach tenant tables on the bare client, and why.
 * Paths are repository-relative, with forward slashes.
 */
const ALLOWLIST = new Map([
  [
    "lib/services/platform-admin/platform-business-detail.service.ts",
    "platform-admin reads ACROSS tenants by design; its boundary is the admin " +
      "identity and its p7adm_read policies, not a tenant GUC",
  ],
]);

/** Directories whose contents are not application runtime code. */
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__tests__"]);
const SKIP_FILE = /\.test\.|\.spec\.|\.d\.ts$/;

function forcedRlsTables(root) {
  const tables = new Set();
  const dir = join(root, "prisma/migrations");
  for (const entry of readdirSync(dir)) {
    let sql = "";
    try {
      sql = readFileSync(join(dir, entry, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    for (const m of sql.matchAll(/ALTER TABLE "(\w+)"\s+FORCE ROW LEVEL SECURITY/gi)) {
      tables.add(m[1]);
    }
  }
  return tables;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry) && !SKIP_FILE.test(entry)) out.push(full);
  }
  return out;
}

function main() {
  const root = process.argv[2] ?? ".";
  const tables = forcedRlsTables(root);
  const models = new Map(
    [...tables].map((t) => [t.charAt(0).toLowerCase() + t.slice(1), t])
  );

  const files = [...walk(join(root, "app")), ...walk(join(root, "lib"))];
  const violations = [];
  const allowedHits = [];

  for (const file of files) {
    const rel = file.replace(/\\/g, "/").replace(new RegExp(`^${root.replace(/\\/g, "/")}/`), "");
    const src = readFileSync(file, "utf8");
    if (!/\bprisma\./.test(src)) continue;

    src.split(/\r?\n/).forEach((line, i) => {
      // `prisma.model.op(` but never `tx.model.op(` or `something.prisma.x`.
      const m = line.match(/(?<![\w.])prisma\.(\w+)\.(\w+)\(/);
      if (!m || !models.has(m[1])) return;
      const hit = { file: rel, line: i + 1, table: models.get(m[1]), op: m[2] };
      if (ALLOWLIST.has(rel)) allowedHits.push(hit);
      else violations.push(hit);
    });
  }

  console.log(`FORCE-RLS tables declared by migrations: ${tables.size}`);
  console.log(`application files scanned: ${files.length}`);

  const staleAllow = [];
  for (const [file, reason] of ALLOWLIST) {
    const n = allowedHits.filter((h) => h.file === file).length;
    console.log(`  allowed: ${file} (${n} call sites) — ${reason}`);
    // sec/A: an exemption that no longer exempts anything is removed, not kept "just in case"
    // (platform-business-detail loses its bare-client reads when T-07 moves it to getPrismaAdmin()).
    if (n === 0) staleAllow.push(file);
  }
  if (staleAllow.length > 0) {
    for (const f of staleAllow) console.log(`  [FAIL] STALE ALLOWLIST ENTRY ${f}: 0 call sites — delete the entry`);
    console.log("\nTENANT-SCOPED ACCESS GUARD: FAIL");
    process.exit(1);
  }

  if (violations.length > 0) {
    console.log(`\n${violations.length} unscoped tenant-table access site(s):\n`);
    for (const v of violations) {
      console.log(`  ${v.file}:${v.line}  prisma.${v.table.charAt(0).toLowerCase()}${v.table.slice(1)}.${v.op}()`);
    }
    console.log(
      "\nUnder FORCE RLS a read like this returns NOTHING rather than failing, and\n" +
        "a write is refused. Route it through the canonical tenant transaction\n" +
        "(tenantTx / billingTenantTx / withTenantTransaction) so the statement\n" +
        "carries `app.current_business_id`.\n" +
        "\nIf the code genuinely must see across tenants, add it to the allowlist in\n" +
        "this guard WITH its reason — that is an architectural decision, not a way\n" +
        "to make the check pass."
    );
    console.log("\nTENANT-SCOPED ACCESS GUARD: FAIL");
    process.exit(1);
  }

  console.log("\nTENANT-SCOPED ACCESS GUARD: PASS");
}

main();
