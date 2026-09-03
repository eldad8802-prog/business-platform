/**
 * Import & Export Center / I-6 — bulk-import execution battery (PG17).
 *
 * Proves, against a real PostgreSQL with a NON-BYPASS runtime role and the
 * CANONICAL RLS taken verbatim from the shipped migration:
 *
 *   1. a replay creates no second Supplier            (no uniqueness backs it)
 *   2. a replay creates no second InventoryItem AND
 *      no second INITIAL_STOCK movement               (the stock ledger)
 *   3. a business record cannot commit without its marker
 *   4. a marker cannot commit when the business write rolls back
 *   5. a failed row leaves the run resumable, and the retry completes it
 *   6. ImportRun / ImportRunRow are invisible across tenants under FORCE RLS
 *   7. a marker cannot be rewritten — there is no UPDATE path at all
 *
 * 3 and 4 are proven the way they would actually fail in production: the
 * runtime role loses INSERT on the target table mid-flight, so the domain write
 * throws inside the transaction that already inserted the marker. Nothing is
 * mocked, and the assertion is over what is in the tables afterwards.
 *
 * Everything runs through the REAL preview and executor. No re-implementation
 * of the flow, because a re-implementation would prove the re-implementation.
 *
 * Synthetic i6-* fixtures only. ZERO Neon, ZERO secrets, ZERO production data.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const RT_ROLE = "i6_runtime";
const RT_PW = "i6_ci_synthetic_pw";
const MARK = "i6-";

let pass = 0,
  fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

/** The RLS + grants section of the SHIPPED migration, executed verbatim. */
const MIGRATION =
  "prisma/migrations/20260903090000_import_run_execution_ledger/migration.sql";

function csv(headers, rows) {
  return Buffer.from(
    "﻿" + [headers, ...rows].map((r) => r.join(",")).join("\r\n"),
    "utf8"
  );
}

/** index -> field label, which is exactly what the mapping type is. */
function mappingFor(headers) {
  const m = {};
  headers.forEach((h, i) => {
    m[i] = h;
  });
  return m;
}

async function main() {
  const OWNER_URL = process.env.DIRECT_URL;
  if (!OWNER_URL) throw new Error("DIRECT_URL missing");
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  await owner.$queryRaw`SELECT 1`;

  /* ── Phase 1: runtime role + the canonical policies ──────────────────── */

  const exists =
    Number(
      (
        await owner.$queryRawUnsafe(
          `SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${RT_ROLE}'`
        )
      )[0].c
    ) > 0;
  if (!exists) {
    await owner.$executeRawUnsafe(
      `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`
    );
  }
  // The migration grants to the group role `app_runtime`; create it and make
  // the lab login a member, exactly as the real environments are wired.
  const groupExists =
    Number(
      (
        await owner.$queryRawUnsafe(
          `SELECT count(*)::int AS c FROM pg_roles WHERE rolname='app_runtime'`
        )
      )[0].c
    ) > 0;
  if (!groupExists) {
    await owner.$executeRawUnsafe(`CREATE ROLE app_runtime NOLOGIN`);
  }
  // WITH INHERIT TRUE is load-bearing on PostgreSQL 16+. A membership captures
  // its inherit flag at GRANT time from the member's rolinherit, and a later
  // ALTER ROLE ... INHERIT does NOT revise it — so a role created NOINHERIT and
  // fixed up afterwards silently holds none of the group's privileges. Stated
  // explicitly here, and re-granted so a role left over from an earlier run is
  // corrected rather than inherited broken.
  await owner.$executeRawUnsafe(`ALTER ROLE ${RT_ROLE} INHERIT`);
  await owner.$executeRawUnsafe(
    `GRANT app_runtime TO ${RT_ROLE} WITH INHERIT TRUE`
  );

  // Without schema USAGE every table privilege below is inert: the role holds
  // the grant and still gets "permission denied for schema public".
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO app_runtime`);

  const TOUCHED = [
    "Business",
    "User",
    "Customer",
    "Supplier",
    "Lead",
    "InventoryItem",
    "InventoryMovement",
    "Conversation",
  ];
  for (const t of TOUCHED) {
    await owner
      .$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON "${t}" TO ${RT_ROLE}`)
      .catch(() => {});
    await owner
      .$executeRawUnsafe(
        `GRANT USAGE, SELECT ON SEQUENCE "${t}_id_seq" TO ${RT_ROLE}`
      )
      .catch(() => {});
  }

  // The shipped RLS, applied from the migration file itself so this battery can
  // never drift from what actually ships. `prisma db push` creates the tables
  // but does not run migration SQL, so the policy section is replayed here.
  const sql = readFileSync(MIGRATION, "utf8");
  const rlsSection = sql.slice(sql.indexOf('ALTER TABLE "ImportRun" ENABLE'));
  for (const stmt of splitSql(rlsSection)) {
    await owner.$executeRawUnsafe(stmt);
  }
  ok("phase 1: canonical RLS from the shipped migration applied", true);

  const forced = await owner.$queryRawUnsafe(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('ImportRun','ImportRunRow')`
  );
  ok(
    "ImportRun and ImportRunRow have RLS ENABLED and FORCED",
    forced.length === 2 &&
      forced.every((r) => r.relrowsecurity && r.relforcerowsecurity),
    JSON.stringify(forced)
  );

  /* ── Phase 2: two tenants ────────────────────────────────────────────── */

  // Remove fixtures from a previous run so the battery is re-runnable. Scoped
  // STRICTLY to the i6- marker and cascaded through Business, so it can never
  // reach a row this battery did not create.
  const stale = await owner.business.findMany({
    where: { name: { startsWith: MARK } },
    select: { id: true },
  });
  if (stale.length > 0) {
    const ids = stale.map((b) => b.id);
    await owner.importRunRow.deleteMany({
      where: { run: { businessId: { in: ids } } },
    });
    await owner.importRun.deleteMany({ where: { businessId: { in: ids } } });
    await owner.inventoryMovement.deleteMany({ where: { businessId: { in: ids } } });
    await owner.business.deleteMany({ where: { id: { in: ids } } });
    console.log(`  (purged ${stale.length} fixture tenants from a previous run)`);
  }

  const bizA = await owner.business.create({ data: { name: `${MARK}A` } });
  const bizB = await owner.business.create({ data: { name: `${MARK}B` } });
  const userA = await owner.user.create({
    data: {
      email: `${MARK}a@example.test`,
      password: "x",
      name: `${MARK}A`,
      businessId: bizA.id,
    },
  });
  ok("phase 2: two synthetic tenants created", !!bizA.id && !!bizB.id);

  /* ── Phase 3: run the REAL flow as the non-bypass runtime role ───────── */

  const RUNTIME_URL = OWNER_URL.replace(
    /\/\/[^@]+@/,
    `//${RT_ROLE}:${RT_PW}@`
  );
  process.env.DATABASE_URL = RUNTIME_URL;

  const { buildImportPreview } = await import(
    "@/lib/data-transfer/import/preview/preview-orchestrator"
  );
  const { executeImport } = await import(
    "@/lib/data-transfer/import/execute/import-executor"
  );
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");

  /** Preview then execute, through the real code path. */
  async function runImport(domainId, headers, rows, businessId = bizA.id) {
    const bytes = csv(headers, rows);
    const mapping = mappingFor(headers);
    const base = {
      businessId,
      userId: userA.id,
      domainId,
      filename: `${MARK}${domainId}.csv`,
      bytes,
      sheetName: null,
      mapping,
    };
    const preview = await buildImportPreview(base);
    if (!preview.ok) throw new Error(`preview failed: ${preview.code}`);
    const result = await executeImport({
      ...base,
      decisions: preview.decisions,
      previewToken: preview.previewToken,
    });
    return { preview, result };
  }

  /**
   * Resubmit an EXACT earlier request: same bytes, same mapping, same decisions,
   * same token. This is what a retried POST or a double-click actually sends,
   * and it is the path the ImportRun identity exists to make safe.
   */
  async function replayExact(domainId, headers, rows, previous, businessId = bizA.id) {
    return executeImport({
      businessId,
      userId: userA.id,
      domainId,
      filename: `${MARK}${domainId}.csv`,
      bytes: csv(headers, rows),
      sheetName: null,
      mapping: mappingFor(headers),
      decisions: previous.preview.decisions,
      previewToken: previous.preview.previewToken,
    });
  }

  /* --- 1. Supplier replay ------------------------------------------------ */

  const supHeaders = ["שם ספק", "מספר עוסק / ח.פ.", "טלפון"];
  const supRows = [[`${MARK}ספק א`, "512345678", "0501111111"]];

  const first = await runImport("suppliers", supHeaders, supRows);
  ok(
    "supplier import creates the record",
    first.result.ok && first.result.counts.createdCount === 1,
    JSON.stringify(first.result)
  );

  // (a) THE replay: the identical request, resubmitted. Same bytes, same
  // mapping, same decisions, same token — a lost response or a double-click.
  const exact = await replayExact("suppliers", supHeaders, supRows, first);
  ok(
    "PROOF 1a: resubmitting the identical request resolves to the SAME run",
    exact.ok &&
      exact.alreadyExecuted === true &&
      exact.importRunId === first.result.importRunId,
    JSON.stringify(exact)
  );

  // (b) The same FILE re-imported after the world changed. The supplier now
  // exists, so the preview's default flips to SKIP and this is a different run
  // by identity — which is correct, and must still not duplicate anything.
  const replay = await runImport("suppliers", supHeaders, supRows);
  ok(
    "re-importing the same file after the record exists defaults to SKIP",
    replay.result.ok && replay.result.counts.createdCount === 0,
    JSON.stringify(replay.result)
  );

  const supCount = await owner.supplier.count({
    where: { businessId: bizA.id, name: `${MARK}ספק א` },
  });
  ok(
    "PROOF 1: neither path duplicates the Supplier",
    supCount === 1,
    `suppliers=${supCount}`
  );

  /* --- 2. Inventory replay, including the stock movement ---------------- */

  const invHeaders = ["שם פריט", "יחידת מידה", "מק״ט", "כמות במלאי"];
  const invRows = [[`${MARK}פריט א`, "יחידה", `${MARK}SKU1`, "7"]];

  const inv1 = await runImport("inventory", invHeaders, invRows);
  ok(
    "inventory import creates the item",
    inv1.result.ok && inv1.result.counts.createdCount === 1,
    JSON.stringify(inv1.result)
  );

  const invExact = await replayExact("inventory", invHeaders, invRows, inv1);
  ok(
    "PROOF 2c: resubmitting the identical inventory request resolves to the SAME run",
    invExact.ok &&
      invExact.alreadyExecuted === true &&
      invExact.importRunId === inv1.result.importRunId,
    JSON.stringify(invExact)
  );

  await runImport("inventory", invHeaders, invRows);
  const itemCount = await owner.inventoryItem.count({
    where: { businessId: bizA.id, sku: `${MARK}SKU1` },
  });
  const item = await owner.inventoryItem.findFirst({
    where: { businessId: bizA.id, sku: `${MARK}SKU1` },
  });
  const moveCount = item
    ? await owner.inventoryMovement.count({
        where: { itemId: item.id, reason: "INITIAL_STOCK" },
      })
    : -1;
  ok(
    "PROOF 2a: a replay does NOT duplicate the InventoryItem",
    itemCount === 1,
    `items=${itemCount}`
  );
  ok(
    "PROOF 2b: a replay does NOT duplicate the INITIAL_STOCK movement",
    moveCount === 1,
    `movements=${moveCount}`
  );
  ok(
    "the stock quantity is what the file said, not double",
    item?.currentQuantity === 7,
    `quantity=${item?.currentQuantity}`
  );

  /* --- 3 & 4. atomicity, proven by taking the write privilege away ------ */

  await owner.$executeRawUnsafe(`REVOKE INSERT ON "Supplier" FROM ${RT_ROLE}`);
  await owner.$executeRawUnsafe(
    `REVOKE INSERT ON "Supplier" FROM app_runtime`
  );

  const denied = await runImport("suppliers", supHeaders, [
    [`${MARK}ספק ב`, "587654321", "0502222222"],
  ]);
  const deniedRunId = denied.result.ok ? denied.result.importRunId : null;
  const orphanSuppliers = await owner.supplier.count({
    where: { businessId: bizA.id, name: `${MARK}ספק ב` },
  });
  const orphanMarkers = deniedRunId
    ? await owner.importRunRow.count({ where: { importRunId: deniedRunId } })
    : -1;

  ok(
    "PROOF 3: the business record did not commit when the write failed",
    orphanSuppliers === 0,
    `suppliers=${orphanSuppliers}`
  );
  ok(
    "PROOF 4: no marker survived the rolled-back write",
    orphanMarkers === 0,
    `markers=${orphanMarkers}`
  );

  const deniedRun = deniedRunId
    ? await owner.importRun.findUnique({ where: { id: deniedRunId } })
    : null;
  ok(
    "PROOF 5a: the run stays EXECUTING, so the row is still retryable",
    deniedRun?.status === "EXECUTING",
    `status=${deniedRun?.status}`
  );

  /* --- 5. the retry completes the run ----------------------------------- */

  await owner.$executeRawUnsafe(`GRANT INSERT ON "Supplier" TO ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT INSERT ON "Supplier" TO app_runtime`);

  const retried = await runImport("suppliers", supHeaders, [
    [`${MARK}ספק ב`, "587654321", "0502222222"],
  ]);
  const afterRetry = await owner.supplier.count({
    where: { businessId: bizA.id, name: `${MARK}ספק ב` },
  });
  ok(
    "PROOF 5b: retrying the same request completes it, creating exactly one record",
    afterRetry === 1 &&
      retried.result.ok &&
      retried.result.importRunId === deniedRunId,
    `suppliers=${afterRetry} runId=${retried.result.ok ? retried.result.importRunId : "?"}`
  );
  const retriedRun = await owner.importRun.findUnique({
    where: { id: deniedRunId },
  });
  ok(
    "the resumed run terminalizes with its true counts",
    retriedRun?.status === "COMPLETED" && retriedRun?.createdCount === 1,
    `status=${retriedRun?.status} created=${retriedRun?.createdCount}`
  );

  /* --- 6. cross-tenant invisibility under FORCE RLS --------------------- */

  const seenFromB = await runWithTenantContext({ businessId: bizB.id }, () =>
    withTenantTransaction(async (tx) => ({
      runs: await tx.importRun.count(),
      rows: await tx.importRunRow.count(),
    }))
  );
  ok(
    "PROOF 6a: tenant B sees ZERO of tenant A's import runs",
    seenFromB.runs === 0,
    `runs=${seenFromB.runs}`
  );
  ok(
    "PROOF 6b: tenant B sees ZERO of tenant A's row markers",
    seenFromB.rows === 0,
    `rows=${seenFromB.rows}`
  );

  const seenFromA = await runWithTenantContext({ businessId: bizA.id }, () =>
    withTenantTransaction(async (tx) => tx.importRun.count())
  );
  ok(
    "tenant A still sees its own runs (the policy is scoped, not blanket)",
    seenFromA >= 3,
    `runs=${seenFromA}`
  );

  const crossWrite = await runWithTenantContext({ businessId: bizB.id }, () =>
    withTenantTransaction((tx) =>
      tx.importRun.create({
        data: {
          businessId: bizA.id,
          userId: userA.id,
          domain: "suppliers",
          contentHash: `${MARK}x`,
          mappingHash: `${MARK}x`,
          decisionsHash: `${MARK}x`,
          sheetName: null,
          totalRows: 1,
        },
      })
    )
  ).then(
    () => "COMMITTED",
    (e) => e?.code ?? e?.name ?? "THREW"
  );
  ok(
    "PROOF 6c: tenant B cannot INSERT a run belonging to tenant A",
    crossWrite !== "COMMITTED",
    `outcome=${crossWrite}`
  );

  /* --- 7. the marker is immutable --------------------------------------- */

  const updateDenied = await runWithTenantContext(
    { businessId: bizA.id },
    () =>
      withTenantTransaction((tx) =>
        tx.importRunRow.updateMany({
          where: { importRunId: first.result.importRunId },
          data: { status: "FAILED" },
        })
      )
  ).then(
    (r) => (r.count === 0 ? "NO_ROWS" : "UPDATED"),
    (e) => e?.code ?? e?.name ?? "THREW"
  );
  ok(
    "PROOF 7: a committed marker cannot be rewritten",
    updateDenied !== "UPDATED",
    `outcome=${updateDenied}`
  );

  /* --- 8. the privilege matches the policy ------------------------------ */

  // Asserted against the DATABASE, not against the migration text. The
  // migration never granted UPDATE on the marker table, and the table still
  // arrived holding it, because ALTER DEFAULT PRIVILEGES grants app_runtime
  // a,r,w,d on every new relation. The migration now revokes it explicitly;
  // this proves the revoke actually took.
  const markerUpdate = await owner.$queryRawUnsafe(
    `SELECT has_table_privilege('app_runtime', '"ImportRunRow"', 'UPDATE') AS granted`
  );
  ok(
    "PROOF 8: the runtime role holds NO UPDATE privilege on the row marker",
    markerUpdate[0].granted === false,
    `has_table_privilege=${markerUpdate[0].granted}`
  );

  const runUpdate = await owner.$queryRawUnsafe(
    `SELECT has_table_privilege('app_runtime', '"ImportRun"', 'UPDATE') AS granted`
  );
  ok(
    "and DOES hold it on the run, which terminalization needs",
    runUpdate[0].granted === true,
    `has_table_privilege=${runUpdate[0].granted}`
  );

  /* ── cleanup ─────────────────────────────────────────────────────────── */

  await owner.$disconnect();

  console.log("");
  console.log(`[I-6 BATTERY] PASS=${pass} FAIL=${fail}`);
  if (failures.length) console.log("  failed: " + failures.join(", "));
  process.exit(fail === 0 ? 0 : 1);
}

/** Split SQL on `;` at end of line, keeping DO $$ ... $$ blocks whole. */
function splitSql(sql) {
  const out = [];
  let buf = "";
  let inDollar = false;
  for (const line of sql.split(/\r?\n/)) {
    if (/^\s*--/.test(line) || line.trim() === "") {
      if (!inDollar) continue;
    }
    if (/\$\$/.test(line)) inDollar = !inDollar || !/\$\$;?\s*$/.test(line);
    buf += line + "\n";
    if (!inDollar && /;\s*$/.test(line)) {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
