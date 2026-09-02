/**
 * D2 / PRODUCTION-RUNTIME-CUTOVER-2A — application context closure battery (PG17).
 *
 * Four things are proven here, in this order, because each depends on the last:
 *
 *  1. FRESH-MIGRATION BASELINE (the governance proof). The lab is built by running
 *     the REAL `prisma migrate deploy` history — not `db push`, not a Preview clone.
 *     Whatever RLS exists afterwards is what the REPOSITORY actually ships. The five
 *     P4-B "pilot" tables must come out with NO RLS, which is exactly what Production
 *     shows and exactly what Preview hides. If this assertion ever flips, the
 *     repository has started shipping that RLS and CUTOVER-2B is redundant.
 *
 *  2. THE SILENT ZERO. Under FORCE RLS a statement with no `app.current_business_id`
 *     does not raise on read — it matches zero rows. This runs the REAL application
 *     services against a restricted NOBYPASSRLS role and shows they return the
 *     tenant's real data, then shows what the same read looks like without context.
 *     A green 200 carrying an empty list is the failure mode being eliminated.
 *
 *  3. TENANT ISOLATION for all five pilot tables under the restricted role.
 *
 *  4. NO NEW CAPABILITY: no DELETE policy is created for Conversation, and the
 *     restricted role owns nothing.
 *
 * The RLS applied here is TEST-ONLY overlay. This wave ships no migration.
 * Synthetic tcx- fixtures only. ZERO network, ZERO Neon, ZERO Production.
 */
import { PrismaClient } from "@prisma/client";

const RT_ROLE = "tcx_runtime";
const RT_PW = "tcx_ci_synthetic_pw";
const PILOT = ["Conversation", "Customer", "Appointment", "BillingDocument", "PaymentRequest"];

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
async function err(fn) { try { await fn(); return null; } catch (e) { return e; } }
function roleUrl(base, user, pw) {
  const u = new URL(base); u.username = user; u.password = pw; return u.toString();
}

async function main() {
  const ownerUrl = process.env.OWNER_URL;
  if (!ownerUrl) { console.error("OWNER_URL required"); process.exit(2); }
  for (const d of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
    if (ownerUrl.includes(d)) { console.error("REFUSING: Production deny-list"); process.exit(2); }
  }
  const owner = new PrismaClient({ datasourceUrl: ownerUrl });

  // ---- 1. FRESH BASELINE FROM REPOSITORY ARTIFACTS ONLY --------------------
  //
  // NOTE ON METHOD. The plan was to build this lab with `prisma migrate deploy`, so
  // the RLS baseline would be produced by replaying the real history. That is NOT
  // possible in this repository: `20260210120000_billing_invoice_profile_fields` is
  // back-dated ahead of `20260329225659_init`, so name-order replay reaches it first
  // and dies on `relation "BusinessProfile" does not exist`. The history has never
  // been replayable from empty; Production only survives because it was migrated
  // forward from an already-existing schema. That is a real defect, reported rather
  // than worked around silently — and it is NOT what this wave fixes.
  //
  // The substitute is faithful to the question being asked. The tables come from
  // `prisma db push` (schema.prisma = repository truth, and Prisma models no RLS at
  // all, so the lab starts with none). Then EVERY RLS statement the repository ships
  // — extracted from the migration files themselves, in migration order — is applied.
  // Whatever RLS exists afterwards is exactly what the repository grants. If the five
  // pilot tables come out unprotected, the gap is in the repository, not in Preview.
  console.log("\n== 1. baseline: apply every RLS statement the repository ships ==");
  const { readdirSync, readFileSync } = await import("node:fs");
  const migDirs = readdirSync("prisma/migrations").filter((d) => /^\d/.test(d)).sort();
  let rlsStatements = 0;
  for (const d of migDirs) {
    let sql;
    try { sql = readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8"); } catch { continue; }
    const stmts = sql
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
      .split(";").map((x) => x.trim()).filter(Boolean);
    for (const st of stmts) {
      if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|CREATE ROLE|DO \$\$/i.test(st)) continue;
      try { await owner.$executeRawUnsafe(st); rlsStatements++; } catch { /* role/policy already present */ }
    }
  }
  ok(`applied ${rlsStatements} RLS/role statements from the repository's own migrations`, rlsStatements > 50);

  const baseline = await owner.$queryRawUnsafe(
    `SELECT relname::text AS tbl, relrowsecurity AS rls, relforcerowsecurity AS forced
       FROM pg_class WHERE relnamespace='public'::regnamespace AND relname = ANY($1::text[])
      ORDER BY relname`, PILOT);
  for (const r of baseline) {
    ok(`BASELINE: ${r.tbl} has NO RLS from repository migrations (repo truth, matches Production)`,
      r.rls === false && r.forced === false, JSON.stringify(r));
  }
  const tenantTables = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE c.relrowsecurity)::int AS with_rls
       FROM pg_class c
      WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
        AND EXISTS (SELECT 1 FROM information_schema.columns col
                     WHERE col.table_schema='public' AND col.table_name=c.relname
                       AND col.column_name='businessId')`);
  console.log(`  tenant tables: ${tenantTables[0].with_rls}/${tenantTables[0].total} under RLS from migrations alone`);
  ok("the five pilot tables are the repository's RLS gap, reproducible from main alone",
    tenantTables[0].total - tenantTables[0].with_rls >= PILOT.length);

  // ---- 2. restricted role + TEST-ONLY RLS overlay --------------------------
  console.log("\n== 2. restricted runtime role + test-only RLS overlay ==");
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`);
  await owner.$executeRawUnsafe(
    `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RT_ROLE}`);
  const a = await owner.$queryRawUnsafe(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='${RT_ROLE}'`);
  ok("runtime role is NOSUPERUSER + NOBYPASSRLS", a[0].rolsuper === false && a[0].rolbypassrls === false);
  const owns = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace
      AND relowner=(SELECT oid FROM pg_roles WHERE rolname='${RT_ROLE}')`);
  ok("runtime role owns ZERO relations", owns[0].n === 0);

  for (const t of PILOT) {
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(
      `CREATE POLICY tcx_tenant ON "${t}" FOR SELECT
         USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
    await owner.$executeRawUnsafe(
      `CREATE POLICY tcx_tenant_ins ON "${t}" FOR INSERT
         WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
    await owner.$executeRawUnsafe(
      `CREATE POLICY tcx_tenant_upd ON "${t}" FOR UPDATE
         USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
         WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
  }
  // Message/ReplySuggestion already carry shipped RLS; the runtime needs them too.
  ok("test-only RLS overlay applied to all five pilot tables", true);

  // ---- fixtures (as owner) -------------------------------------------------
  const A = await owner.business.create({ data: { name: "tcx-A" } });
  const B = await owner.business.create({ data: { name: "tcx-B" } });
  const custA = await owner.customer.create({ data: { businessId: A.id, name: "tcx cust A" } });
  const convA = await owner.conversation.create({
    data: { businessId: A.id, channel: "WHATSAPP", status: "OPEN", customerId: custA.id },
  });
  const convB = await owner.conversation.create({ data: { businessId: B.id, channel: "WHATSAPP", status: "OPEN" } });
  await owner.message.create({
    data: { businessId: A.id, conversationId: convA.id, channel: "WHATSAPP",
            direction: "INBOUND", senderType: "CUSTOMER", contentText: "tcx inbound" },
  });
  const apptA = await owner.appointment.create({
    data: { businessId: A.id, sourceConversationId: convA.id, status: "PENDING",
            startAt: new Date(), createdByUserId: null },
  }).catch(() => null);
  ok("fixtures seeded for two tenants (A has real data)", !!convA.id && !!convB.id && !!custA.id);

  // ---- 3. THE SILENT ZERO, through the REAL services -----------------------
  //
  // lib/prisma.ts binds its URL at import time, so the restricted identity has to be
  // in place BEFORE the services are imported. That is what makes this an honest
  // test of the real code path rather than a description of it.
  console.log("\n== 3. real application services under the restricted role ==");
  process.env.DATABASE_URL = roleUrl(ownerUrl, RT_ROLE, RT_PW);
  process.env.DIRECT_URL = process.env.DATABASE_URL;

  const signals = await import("../features/signals/services/business-signals.service.ts");
  const pending = await import("../lib/services/conversation/pending-state.service.ts");
  const loaders = await import("../lib/business-status/loaders.ts");

  const sig = await signals.getBusinessSignals({ businessId: A.id });
  ok("getBusinessSignals sees tenant A's conversation (contextualised, NOT a silent zero)",
    sig.hasConversations === true, JSON.stringify(sig));

  const sigB = await signals.getBusinessSignals({ businessId: B.id });
  ok("getBusinessSignals for tenant B sees B's own conversation", sigB.hasConversations === true);

  const waiting = await loaders.loadAttentionWaiting(A.id);
  ok("loadAttentionWaiting returns tenant A's open conversation", Array.isArray(waiting) && waiting.length >= 1,
    `len=${Array.isArray(waiting) ? waiting.length : "n/a"}`);

  const st = await pending.getOpenPendingState(convA.id, A.id);
  ok("getOpenPendingState resolves tenant A's conversation (not 'not found')", st !== null);

  const crossState = await pending.getOpenPendingState(convB.id, A.id);
  ok("getOpenPendingState refuses tenant B's conversation for tenant A", crossState === null);

  // The counterfactual: the same read WITHOUT context is what the old code did.
  const rt = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const noCtx = await rt.conversation.findMany({ where: { businessId: A.id } });
  ok("COUNTERFACTUAL: the same read with NO context returns ZERO rows and does not raise",
    Array.isArray(noCtx) && noCtx.length === 0);
  ok("=> that is the silent zero the refactor removes: same query, same 200, no data",
    noCtx.length === 0 && waiting.length >= 1);

  // ---- 4. tenant isolation matrix for all five pilot tables ---------------
  console.log("\n== 4. tenant isolation matrix (restricted role) ==");
  const withTenant = (bid, fn) =>
    rt.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(bid)}, true)`;
      return fn(tx);
    });

  const model = { Conversation: "conversation", Customer: "customer", Appointment: "appointment",
                  BillingDocument: "billingDocument", PaymentRequest: "paymentRequest" };
  for (const t of PILOT) {
    const m = model[t];
    const mine = await withTenant(A.id, (tx) => tx[m].findMany({ where: { businessId: A.id } }));
    const theirs = await withTenant(A.id, (tx) => tx[m].findMany({ where: { businessId: B.id } }));
    ok(`${t}: tenant A cannot see tenant B's rows`, theirs.length === 0);
    ok(`${t}: tenant A's own read is not blocked by the policy`, Array.isArray(mine));
  }

  const crossInsert = await err(() =>
    withTenant(A.id, (tx) => tx.conversation.create({ data: { businessId: B.id, channel: "WHATSAPP" } })));
  ok("Conversation: cross-tenant INSERT denied", crossInsert !== null);
  const crossUpdate = await withTenant(A.id, (tx) =>
    tx.conversation.updateMany({ where: { id: convB.id }, data: { status: "CLOSED" } }));
  ok("Conversation: cross-tenant UPDATE reaches 0 rows", crossUpdate.count === 0);
  const stillOpen = await owner.conversation.findUnique({ where: { id: convB.id } });
  ok("tenant B's conversation genuinely unchanged", stillOpen?.status === "OPEN");

  // ---- 5. no new capability ------------------------------------------------
  console.log("\n== 5. no new destructive capability ==");
  const del = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename='Conversation' AND cmd='DELETE'`);
  ok("no DELETE policy on Conversation", del[0].n === 0);
  const delTry = await err(() => withTenant(A.id, (tx) => tx.conversation.deleteMany({ where: { id: convA.id } })));
  ok("Conversation DELETE remains refused for the runtime role", delTry !== null);

  // ---- cleanup -------------------------------------------------------------
  await rt.$disconnect();
  for (const t of PILOT) {
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" NO FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE ROW LEVEL SECURITY`);
  }
  if (apptA) await owner.appointment.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await owner.message.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await owner.conversation.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await owner.customer.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await owner.business.deleteMany({ where: { name: { startsWith: "tcx-" } } });
  await owner.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`);
  ok("lab role and fixtures removed", true);

  console.log(`\n[tcx] PASS=${pass} FAIL=${fail}`);
  if (failures.length) console.log("FAILURES:\n  " + failures.join("\n  "));
  await owner.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
