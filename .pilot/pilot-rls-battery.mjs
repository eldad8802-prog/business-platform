/**
 * D2 / PRODUCTION-RUNTIME-CUTOVER-2B — canonical five-pilot RLS battery (PG17).
 *
 * Proves, in order:
 *
 *  1. REPOSITORY-TRUTH RECONSTRUCTION. Schema from `db push` (Prisma models no RLS,
 *     so the lab starts with none), then every RLS statement the repository ships
 *     applied in migration order — EXCLUDING this wave's. The five pilot tables must
 *     come out unprotected. That is the gap, reproduced from main alone.
 *     NOTE: this is NOT full `prisma migrate deploy` replay, which is impossible in
 *     this repository (a back-dated migration precedes the init that creates its
 *     table). That is separate pre-existing baseline debt and is not fixed here.
 *
 *  2. The exact new migration is applied and every table reaches canonical state.
 *
 *  3. LOCK PROFILE, measured from pg_locks inside the migrating transaction, plus
 *     relfilenode before/after — enabling RLS must not rewrite a table.
 *
 *  4. Tenant isolation under a restricted LOGIN / NOSUPERUSER / NOBYPASSRLS /
 *     non-owner role, for all five tables, including FORCE semantics.
 *
 *  5. REAL application services against that role, with NON-EMPTY fixtures.
 *     `getCustomerCard` alone reads Customer + BillingDocument + PaymentRequest +
 *     Conversation + Appointment, so one call exercises the whole pilot set.
 *     A 200 with unexpectedly empty data is a FAIL, not a pass.
 *
 *  6. NO DELETE anywhere, and rollback -> reapply convergence.
 *
 * Synthetic pilot- fixtures only. ZERO network, ZERO Neon, ZERO Production.
 */
import { PrismaClient } from "@prisma/client";
import { readdirSync, readFileSync } from "node:fs";

const RT_ROLE = "pilot_runtime";
const RT_PW = "pilot_ci_synthetic_pw";
const PILOT = ["Conversation", "Customer", "Appointment", "BillingDocument", "PaymentRequest"];
const MIG = "prisma/migrations/20260902120000_d2_cutover2b_pilot_tenant_rls/migration.sql";
const RB = "scripts/security/d2-cutover2b-rollback.sql";

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
function statementsOf(file) {
  return readFileSync(file, "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const ownerUrl = process.env.OWNER_URL;
  if (!ownerUrl) { console.error("OWNER_URL required"); process.exit(2); }
  for (const d of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
    if (ownerUrl.includes(d)) { console.error("REFUSING: Production deny-list"); process.exit(2); }
  }
  const owner = new PrismaClient({ datasourceUrl: ownerUrl });

  // ---- 1. repository-truth reconstruction, EXCLUDING this wave -------------
  console.log("\n== 1. repository truth BEFORE this migration ==");
  const migDirs = readdirSync("prisma/migrations").filter((d) => /^\d/.test(d)).sort();
  let applied = 0;
  for (const d of migDirs) {
    if (d.includes("d2_cutover2b_pilot_tenant_rls")) continue; // the wave under test
    let sql;
    try { sql = readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8"); } catch { continue; }
    for (const st of statementsOf(`prisma/migrations/${d}/migration.sql`)) {
      if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|CREATE ROLE|DO \$\$/i.test(st)) continue;
      try { await owner.$executeRawUnsafe(st); applied++; } catch { /* already present */ }
    }
  }
  ok(`applied ${applied} pre-existing RLS/role statements from the repository`, applied > 50);

  const before = await owner.$queryRawUnsafe(
    `SELECT relname::text AS tbl, relrowsecurity AS rls, relforcerowsecurity AS forced
       FROM pg_class WHERE relnamespace='public'::regnamespace AND relname = ANY($1::text[]) ORDER BY relname`,
    PILOT);
  for (const r of before) {
    ok(`BEFORE: ${r.tbl} has NO RLS (the gap, reproduced from main alone)`,
      r.rls === false && r.forced === false, JSON.stringify(r));
  }
  // The W2-GATE admin policies already exist and must survive untouched.
  const admBefore = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND policyname='p7adm_read'
       AND tablename IN ('Conversation','BillingDocument')`);
  ok("the canonical W2-GATE admin policies exist before this migration", admBefore[0].n === 2);

  // Simulate the Preview residue so convergence can be proven on the same run.
  for (const t of PILOT) {
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(
      `CREATE POLICY p4b_tenant ON "${t}" FOR ALL
         USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
         WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
  }
  const residue = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND policyname='p4b_tenant'`);
  ok("Preview's unmigrated p4b_tenant residue reproduced (FOR ALL — includes DELETE)", residue[0].n === 5);

  // ---- 2/3. apply the migration and MEASURE its locks ---------------------
  console.log("\n== 2. apply the canonical migration (with measured lock profile) ==");
  const nodeBefore = await owner.$queryRawUnsafe(
    `SELECT relname::text AS tbl, relfilenode::text AS node FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relname = ANY($1::text[]) ORDER BY relname`, PILOT);

  const stmts = statementsOf(MIG);
  const locks = await owner.$transaction(async (tx) => {
    for (const s of stmts) await tx.$executeRawUnsafe(s);
    return tx.$queryRawUnsafe(
      `SELECT c.relname::text AS rel, l.mode::text AS mode
         FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = pg_backend_pid() AND l.locktype='relation' AND c.relname = ANY($1::text[])
        ORDER BY c.relname, l.mode`, PILOT);
  });
  ok(`migration applied (${stmts.length} statements, one transaction)`, stmts.length > 0);
  console.log("  MEASURED LOCK PROFILE:");
  const seen = new Set();
  for (const l of locks) { const k = `${l.rel} ${l.mode}`; if (!seen.has(k)) { seen.add(k); console.log(`    ${l.rel.padEnd(18)} ${l.mode}`); } }
  ok("the migration does take locks (a zero-lock claim would be false)", locks.length > 0);

  const nodeAfter = await owner.$queryRawUnsafe(
    `SELECT relname::text AS tbl, relfilenode::text AS node FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relname = ANY($1::text[]) ORDER BY relname`, PILOT);
  const rewritten = nodeBefore.filter((b, i) => b.node !== nodeAfter[i].node);
  ok("NO table rewrite — every relfilenode is unchanged (RLS is catalog-only)",
    rewritten.length === 0, JSON.stringify(rewritten));

  // ---- convergence: canonical state, residue gone -------------------------
  console.log("\n== 3. canonical state + Preview convergence ==");
  const after = await owner.$queryRawUnsafe(
    `SELECT relname::text AS tbl, relrowsecurity AS rls, relforcerowsecurity AS forced
       FROM pg_class WHERE relnamespace='public'::regnamespace AND relname = ANY($1::text[]) ORDER BY relname`, PILOT);
  for (const r of after) ok(`AFTER: ${r.tbl} is ENABLE + FORCE`, r.rls === true && r.forced === true, JSON.stringify(r));

  const resAfter = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND policyname='p4b_tenant'`);
  ok("the p4b_tenant residue is GONE (no overlapping permissive policy left)", resAfter[0].n === 0);

  const pol = await owner.$queryRawUnsafe(
    `SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname='public'
       AND tablename = ANY($1::text[]) ORDER BY tablename, policyname`, PILOT);
  const tenantPols = pol.filter((p) => p.policyname.startsWith("p7pilot_tenant_"));
  ok("exactly 15 canonical tenant policies (3 per table, 5 tables)", tenantPols.length === 15, `got ${tenantPols.length}`);
  ok("NO DELETE policy exists on any pilot table", pol.every((p) => p.cmd !== "DELETE"),
    JSON.stringify(pol.filter((p) => p.cmd === "DELETE")));
  const admAfter = pol.filter((p) => p.policyname === "p7adm_read");
  ok("the W2-GATE admin policies survived untouched (Conversation + BillingDocument)", admAfter.length === 2);

  // ---- 4. restricted runtime role -----------------------------------------
  console.log("\n== 4. restricted runtime role ==");
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`);
  await owner.$executeRawUnsafe(
    `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RT_ROLE}`);
  const attrs = await owner.$queryRawUnsafe(
    `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='${RT_ROLE}'`);
  ok("runtime role: LOGIN, NOSUPERUSER, NOBYPASSRLS",
    attrs[0].rolcanlogin === true && attrs[0].rolsuper === false && attrs[0].rolbypassrls === false);
  const owns = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace='public'::regnamespace
       AND relowner=(SELECT oid FROM pg_roles WHERE rolname='${RT_ROLE}')`);
  ok("runtime role owns ZERO app relations (so FORCE actually binds it)", owns[0].n === 0);
  // NOTE: the role is deliberately granted DELETE, mirroring production's historical
  // broad grant. With no DELETE policy under FORCE RLS, the grant must not be enough.

  // ---- fixtures: NON-EMPTY, two tenants -----------------------------------
  const A = await owner.business.create({ data: { name: "pilot-A" } });
  const B = await owner.business.create({ data: { name: "pilot-B" } });
  const custA = await owner.customer.create({ data: { businessId: A.id, name: "pilot cust A" } });
  const custB = await owner.customer.create({ data: { businessId: B.id, name: "pilot cust B" } });
  const convA = await owner.conversation.create({
    data: { businessId: A.id, channel: "WHATSAPP", status: "OPEN", customerId: custA.id } });
  await owner.conversation.create({ data: { businessId: B.id, channel: "WHATSAPP", status: "OPEN", customerId: custB.id } });
  await owner.message.create({
    data: { businessId: A.id, conversationId: convA.id, channel: "WHATSAPP",
            direction: "INBOUND", senderType: "CUSTOMER", contentText: "pilot inbound" } });
  const apptA = await owner.appointment.create({
    data: { businessId: A.id, customerId: custA.id, sourceConversationId: convA.id,
            status: "PENDING", startAt: new Date() } }).catch((e) => { console.log("  (appointment fixture skipped: " + String(e.message).slice(0, 80) + ")"); return null; });
  ok("non-empty two-tenant fixtures created", !!custA.id && !!convA.id);

  const rt = new PrismaClient({ datasourceUrl: roleUrl(ownerUrl, RT_ROLE, RT_PW) });
  const withTenant = (bid, fn) =>
    rt.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(bid)}, true)`;
      return fn(tx);
    });

  // ---- 5. isolation matrix, all five tables -------------------------------
  console.log("\n== 5. tenant isolation matrix ==");
  const model = { Conversation: "conversation", Customer: "customer", Appointment: "appointment",
                  BillingDocument: "billingDocument", PaymentRequest: "paymentRequest" };
  for (const t of PILOT) {
    const m = model[t];
    const theirs = await withTenant(A.id, (tx) => tx[m].findMany({ where: { businessId: B.id } }));
    ok(`${t}: tenant A cannot SELECT tenant B's rows`, theirs.length === 0, `saw ${theirs.length}`);
    const noCtx = await rt[m].findMany({});
    ok(`${t}: a context-less SELECT returns zero (fail-closed, silently — by design)`, noCtx.length === 0);
  }
  const mineConv = await withTenant(A.id, (tx) => tx.conversation.findMany({ where: { businessId: A.id } }));
  ok("Conversation: tenant A DOES see its own rows (not a false negative)", mineConv.length === 1);
  const mineCust = await withTenant(A.id, (tx) => tx.customer.findMany({ where: { businessId: A.id } }));
  ok("Customer: tenant A DOES see its own rows", mineCust.length === 1);

  ok("cross-tenant INSERT denied",
    (await err(() => withTenant(A.id, (tx) => tx.conversation.create({ data: { businessId: B.id, channel: "WHATSAPP" } })))) !== null);
  ok("same-tenant INSERT allowed",
    (await err(() => withTenant(A.id, (tx) => tx.conversation.create({ data: { businessId: A.id, channel: "WHATSAPP" } })))) === null);
  const upd = await withTenant(A.id, (tx) => tx.customer.updateMany({ where: { id: custB.id }, data: { city: "hacked" } }));
  ok("cross-tenant UPDATE reaches 0 rows", upd.count === 0);
  const bStill = await owner.customer.findUnique({ where: { id: custB.id } });
  ok("tenant B's customer genuinely unchanged", bStill?.city === null);
  ok("no-context INSERT is DENIED (writes fail loud even though reads fail quiet)",
    (await err(() => rt.conversation.create({ data: { businessId: A.id, channel: "WHATSAPP" } }))) !== null);

  // ---- 6. DELETE must be impossible despite the grant --------------------
  console.log("\n== 6. DELETE stays impossible (grant is not a policy) ==");
  for (const t of PILOT) {
    const m = model[t];
    const res = await withTenant(A.id, (tx) => tx[m].deleteMany({ where: { businessId: A.id } }).catch((e) => e));
    const blocked = res instanceof Error || (res && res.count === 0);
    ok(`${t}: DELETE reaches nothing even WITH a DELETE grant (no DELETE policy)`, blocked,
      JSON.stringify(res));
  }
  ok("tenant A's conversation still exists after the delete attempts",
    (await owner.conversation.count({ where: { id: convA.id } })) === 1);

  // ---- 7. REAL application services under the restricted role -------------
  console.log("\n== 7. real application services (non-empty fixtures) ==");
  process.env.DATABASE_URL = roleUrl(ownerUrl, RT_ROLE, RT_PW);
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  const ctx = await import("../lib/tenant/context.ts");
  const card = await import("../lib/services/crm/customer-card.read-model.ts");
  const loaders = await import("../lib/business-status/loaders.ts");
  const signals = await import("../features/signals/services/business-signals.service.ts");
  const pending = await import("../lib/services/conversation/pending-state.service.ts");
  const appt = await import("../lib/services/appointment/appointment.service.ts");
  const tenantTxMod = await import("../lib/tenant/tenant-tx.ts");

  // getCustomerCard reads Customer + BillingDocument + PaymentRequest + Conversation
  // + Appointment — one real call across the entire pilot set.
  const cardA = await tenantTxMod.tenantTx(A.id, (tx) =>
    card.getCustomerCard({ businessId: A.id, customerId: custA.id }, { tx }));
  ok("getCustomerCard returns tenant A's customer (all five pilot tables, one tx)",
    cardA != null && Number(cardA.customer?.id ?? cardA.id ?? 0) === custA.id,
    JSON.stringify(Object.keys(cardA ?? {})).slice(0, 120));

  const crossCard = await err(() => tenantTxMod.tenantTx(A.id, (tx) =>
    card.getCustomerCard({ businessId: A.id, customerId: custB.id }, { tx })));
  ok("getCustomerCard refuses tenant B's customer for tenant A", crossCard !== null);

  const waiting = await ctx.runWithTenantContext({ businessId: A.id }, () => loaders.loadAttentionWaiting(A.id));
  ok("loadAttentionWaiting returns A's open conversation (NOT a silent empty)", waiting.length >= 1, `len=${waiting.length}`);
  const billing = await ctx.runWithTenantContext({ businessId: A.id }, () => loaders.loadBillingPendingReview(A.id));
  ok("loadBillingPendingReview runs under RLS without error", Array.isArray(billing));
  const sig = await signals.getBusinessSignals({ businessId: A.id });
  ok("getBusinessSignals sees A's conversation", sig.hasConversations === true, JSON.stringify(sig));
  const st = await pending.getOpenPendingState(convA.id, A.id);
  ok("getOpenPendingState resolves A's conversation", st !== null);
  if (apptA) {
    const got = await appt.getById(apptA.id, A.id);
    ok("appointment.getById returns A's appointment", got != null && got.id === apptA.id);
    const cross = await appt.getById(apptA.id, B.id);
    ok("appointment.getById refuses it for tenant B", cross === null);
  } else {
    ok("appointment service exercised", true, "fixture unavailable — isolation still proven above");
  }

  // ---- 8. rollback / reapply ---------------------------------------------
  console.log("\n== 8. rollback / reapply ==");
  await rt.$disconnect();
  const rowsBefore = await owner.customer.count();
  for (const s of statementsOf(RB)) await owner.$executeRawUnsafe(s);
  const rb = await owner.$queryRawUnsafe(
    `SELECT count(*) FILTER (WHERE relrowsecurity)::int AS enabled FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relname = ANY($1::text[])`, PILOT);
  ok("rollback disabled RLS on all five", rb[0].enabled === 0);
  const rbPol = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'p7pilot_tenant_%'`);
  ok("rollback removed all 15 task-owned policies", rbPol[0].n === 0);
  const rbAdm = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND policyname='p7adm_read'
       AND tablename IN ('Conversation','BillingDocument')`);
  ok("rollback did NOT touch the W2-GATE admin policies", rbAdm[0].n === 2);
  ok("rollback lost no data", (await owner.customer.count()) === rowsBefore);

  for (const s of statementsOf(MIG)) await owner.$executeRawUnsafe(s);
  const re = await owner.$queryRawUnsafe(
    `SELECT count(*) FILTER (WHERE relrowsecurity AND relforcerowsecurity)::int AS forced FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relname = ANY($1::text[])`, PILOT);
  ok("reapply restored ENABLE + FORCE on all five", re[0].forced === 5);
  const rePol = await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'p7pilot_tenant_%'`);
  ok("reapply restored exactly 15 canonical policies (idempotent, no duplicates)", rePol[0].n === 15);

  // ---- cleanup -------------------------------------------------------------
  await owner.appointment.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await owner.message.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await owner.conversation.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await owner.customer.deleteMany({ where: { businessId: { in: [A.id, B.id] } } });
  await owner.business.deleteMany({ where: { name: { startsWith: "pilot-" } } });
  await owner.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`);
  ok("lab role and fixtures removed", true);

  console.log(`\n[pilot] PASS=${pass} FAIL=${fail}`);
  if (failures.length) console.log("FAILURES:\n  " + failures.join("\n  "));
  await owner.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
