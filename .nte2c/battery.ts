/**
 * Notification engine activation — what migration 20261212090000_notification_engine_activation does, measured with
 * the real role topology on a Production-shaped database (.nte2c/lab.sh <db> --with-nte2c, which chains the
 * follow-up lab .nte2/lab.sh --with-nte2):
 *   owner    (lab_owner: the migration role, BYPASSRLS like Production's; fixtures and the global policy),
 *   ctlplane (nte2c_ctl_login: NOSUPERUSER NOBYPASSRLS, member of app_ctlplane — the platform admin's switch),
 *   runtime  (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the worker),
 *   auth     (te_auth_login: NOSUPERUSER NOBYPASSRLS, member of app_auth).
 *
 *   1. Backfill (NTE2C_SEED rows written before the release): exactly the ENABLED override got a record, dated at
 *      the release (never the override's earlier updatedAt), source 'migration'; DISABLED / INHERIT none.
 *   2. Catalog: RLS enabled + forced, one policy (FOR SELECT, tenant setting); app_runtime SELECT only; PUBLIC,
 *      app_ctlplane, app_auth nothing; functions definer / invoker as designed, search_path pinned; EXECUTE.
 *   3. RLS + grants in action: the runtime reads its own business's record only (none without a tenant); cannot
 *      write or remove a row; the control plane cannot read or write the table; nobody but the owner runs the helpers.
 *   4. Trigger on the override, written by the control plane: first activation at the stamped moment; OFF; ON again
 *      (prior = the period that ended); re-saves, a reason edit, an earlier stamp (clamped), a statement without a
 *      stamp (statement time); INHERIT decided OFF only while globalEnabled is false (otherwise unknown → no write).
 *   5. Trigger on the global policy: a re-save / an updatedAt-only edit / a globalEnabled flip moves NOBODY's record;
 *      the kill switch deactivates and re-activates exactly the override-ENABLED businesses at its moment; first
 *      activations never move.
 *   6. notification_engine_observe as the runtime: its own tenant only (another business / no tenant → 42501);
 *      global-only business: first seen ON recorded once (source worker), seen OFF recorded; a claim the override
 *      contradicts is refused; another role cannot EXECUTE it.
 *   7. CHECKs (moment order, source token); erasure: a business deleted takes its record (cascade).
 *   8. Backward compatibility: overrides of other features and the existing notification rows are untouched; the
 *      control plane's mutation statements (insert, state / reason / updatedAt) keep working.
 *
 * env: OWNER_URL, CTL_URL, RUNTIME_URL, AUTH_URL. Synthetic only. ZERO network.
 */
import { PrismaClient, Prisma } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const ctl = new PrismaClient({ datasourceUrl: process.env.CTL_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });
const auth = new PrismaClient({ datasourceUrl: process.env.AUTH_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;
async function inTx<T>(client: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }).catch((e: Error) => `ERR ${e.message}`);
}
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const J = (v: unknown) => JSON.stringify(v, (_k, y) => (typeof y === "bigint" ? Number(y) : y));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const isErr = (r: unknown): r is string => typeof r === "string" && r.startsWith("ERR ");
const why = (r: unknown) => (isErr(r) ? r.slice(0, 240) : J(r).slice(0, 240));
const denied = (r: unknown) => isErr(r) && /permission denied|row-level security|42501/i.test(r);

const T = (s: string) => new Date(`${s}Z`);
const ts = (d: unknown) => (d instanceof Date ? d.getTime() : null);
type Rec = { first: Date; last: Date; prior: Date; deact: Date | null; src: string; upd: Date } | null;
async function rec(b: number): Promise<Rec> {
  const r = rows(await owner.$queryRawUnsafe(`SELECT "firstActivatedAt" AS first, "lastActivatedAt" AS last, "priorActivatedAt" AS prior,
    "lastDeactivatedAt" AS deact, "lastSource" AS src, "updatedAt" AS upd FROM "NotificationEngineActivation" WHERE "businessId" = $1`, b));
  return r.length ? (r[0] as unknown as NonNullable<Rec>) : null;
}
const same = (a: Rec, b: Rec) => J(a && { ...a, upd: 0 }) === J(b && { ...b, upd: 0 });

async function main() {
  const mk = async (sql: string, ...args: unknown[]) => Number(rows(await owner.$queryRawUnsafe(sql, ...args))[0].id);
  const biz = (name: string) => mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
  const policy = (sets: string, at: string) =>
    owner.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET ${sets}, "updatedAt" = $1::timestamp(3) WHERE "featureKey" = 'notifications_engine'`, at);
  // The platform admin's mutation, as the control plane executes it: in the target business's tenant transaction.
  const ctlInsert = (b: number, state: string, at: string) => x(ctl, b,
    `INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'notifications_engine', $2::"BusinessFeatureAccessState", $3::timestamp(3))`, b, state, at);
  const ctlState = (b: number, state: string, at: string) => x(ctl, b,
    `UPDATE "BusinessFeatureAccess" SET "state" = $2::"BusinessFeatureAccessState", "updatedAt" = $3::timestamp(3) WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, b, state, at);

  // ── 1. backfill ────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("1. backfill of overrides written before the release");
  const seed = rows(await owner.$queryRawUnsafe(`SELECT b."name", e."firstActivatedAt" AS first, e."lastSource" AS src,
      (SELECT started_at AT TIME ZONE 'UTC' FROM "_prisma_migrations" WHERE migration_name = '20261212090000_notification_engine_activation') AS rel
    FROM "Business" b LEFT JOIN "NotificationEngineActivation" e ON e."businessId" = b."id" WHERE b."name" LIKE 'nte2c-seed-%' ORDER BY b."name"`));
  const byName = Object.fromEntries(seed.map((r) => [r.name as string, r]));
  if (seed.length === 3) {
    const on = byName["nte2c-seed-on"];
    ok("the ENABLED override got a record, source 'migration'", on.first instanceof Date && on.src === "migration", J(on));
    ok("…dated at the release, never the override's earlier updatedAt (2026-11-01): nothing owed before is pushed",
      ts(on.first)! >= ts(on.rel)! - 60_000 && ts(on.first)! > T("2026-11-01T08:00:00").getTime(), J(on));
    ok("DISABLED and INHERIT overrides got none", byName["nte2c-seed-off"].first === null && byName["nte2c-seed-inherit"].first === null, J(seed));
  } else {
    ok("the seed is present (NTE2C_SEED=.nte2c/seed.sql)", false, J(seed));
  }

  // ── 2. catalog ─────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("2. catalog: RLS, policies, privileges, functions");
  const cat = rows(await owner.$queryRawUnsafe(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polcmd = 'r' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.current_business_id%') AS sel
    FROM pg_class c WHERE c.relname = 'NotificationEngineActivation'`))[0];
  ok("RLS enabled + forced; exactly one policy, FOR SELECT on the tenant setting (no write / delete policy)",
    cat.rls === true && cat.force === true && cat.policies === 1 && cat.sel === 1, J(cat));
  const priv = rows(await owner.$queryRawUnsafe(`SELECT r.rolname,
      has_table_privilege(r.rolname, '"NotificationEngineActivation"', 'SELECT') AS s,
      has_table_privilege(r.rolname, '"NotificationEngineActivation"', 'INSERT') AS i,
      has_table_privilege(r.rolname, '"NotificationEngineActivation"', 'UPDATE') AS u,
      has_table_privilege(r.rolname, '"NotificationEngineActivation"', 'DELETE') AS d,
      has_table_privilege(r.rolname, '"NotificationEngineActivation"', 'TRUNCATE') AS t
    FROM pg_roles r WHERE r.rolname IN ('app_runtime', 'app_runtime_prod', 'app_ctlplane', 'nte2c_ctl_login', 'app_auth', 'te_auth_login') ORDER BY 1`));
  const p = Object.fromEntries(priv.map((r) => [r.rolname as string, r]));
  ok("app_runtime (and its login): SELECT only", ["app_runtime", "app_runtime_prod"].every((k) => p[k]?.s === true && !p[k].i && !p[k].u && !p[k].d && !p[k].t), J(priv));
  ok("app_ctlplane / app_auth (and their logins): nothing", ["app_ctlplane", "nte2c_ctl_login", "app_auth", "te_auth_login"].every((k) => p[k] && !p[k].s && !p[k].i && !p[k].u && !p[k].d && !p[k].t), J(priv));
  const fns = rows(await owner.$queryRawUnsafe(`SELECT p.proname, p.prosecdef AS def, p.proconfig::text AS cfg,
      has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS rt, has_function_privilege('app_auth', p.oid, 'EXECUTE') AS au,
      has_function_privilege('app_ctlplane', p.oid, 'EXECUTE') AS cp
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'notification\\_engine\\_%' ORDER BY 1`));
  const f = Object.fromEntries(fns.map((r) => [r.proname as string, r]));
  const defs = ["notification_engine_observe", "notification_engine_override_changed", "notification_engine_policy_changed"];
  ok("five functions; the trigger functions and observe are SECURITY DEFINER, the helpers INVOKER; all search_path pinned",
    fns.length === 5 && fns.every((r) => r.cfg === "{\"search_path=pg_catalog, public, pg_temp\"}" && r.def === defs.includes(r.proname as string)), J(fns));
  ok("EXECUTE: observe for app_runtime only; nobody else runs any of them",
    f.notification_engine_observe?.rt === true && fns.every((r) => !r.au && !r.cp) && fns.filter((r) => r.rt).length === 1, J(fns));

  // ── fixtures ───────────────────────────────────────────────────────────────────────────────────────────────────
  const A = await biz("nte2c-A");
  const B = await biz("nte2c-B");
  const G = await biz("nte2c-G"); // global-only
  const K = await biz("nte2c-K"); // a second override-ENABLED business for the kill switch

  // ── 4. the override trigger, as the control plane ──────────────────────────────────────────────────────────────
  console.log("4. trigger on the per-business override (written by the control plane)");
  const i1 = await ctlInsert(A, "ENABLED", "2026-12-01 10:00:00");
  const r1 = await rec(A);
  ok("the control plane switches A ON: first = last = prior = the stamped moment, source override",
    !isErr(i1) && ts(r1?.first) === T("2026-12-01T10:00:00").getTime() && ts(r1?.last) === ts(r1?.first) && ts(r1?.prior) === ts(r1?.first) && r1?.deact === null && r1?.src === "override", why(i1) + J(r1));
  await ctlState(A, "ENABLED", "2026-12-01 11:00:00");
  ok("a re-save (ENABLED again) changes nothing", same(await rec(A), r1));
  const reason = await x(ctl, A, `UPDATE "BusinessFeatureAccess" SET "reason" = 'lab', "updatedAt" = '2026-12-01 11:30:00' WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, A);
  ok("a reason edit (no state in the statement) does not fire", !isErr(reason) && same(await rec(A), r1), why(reason));
  await ctlState(A, "DISABLED", "2026-12-01 12:00:00");
  const r2 = await rec(A);
  ok("OFF: lastDeactivatedAt = the stamped moment, first unchanged", ts(r2?.deact) === T("2026-12-01T12:00:00").getTime() && ts(r2?.first) === ts(r1?.first), J(r2));
  await ctlState(A, "DISABLED", "2026-12-01 12:30:00");
  ok("OFF re-saved: nothing", same(await rec(A), r2));
  await ctlState(A, "ENABLED", "2026-12-01 13:00:00");
  const r3 = await rec(A);
  ok("ON again: last = 13:00, prior = 10:00 (the period 12:00 ended), first unchanged",
    ts(r3?.last) === T("2026-12-01T13:00:00").getTime() && ts(r3?.prior) === T("2026-12-01T10:00:00").getTime() && ts(r3?.first) === ts(r1?.first) && ts(r3?.deact) === ts(r2?.deact), J(r3));
  await ctlState(A, "DISABLED", "2026-12-01 09:00:00"); // an earlier stamp than the activation
  const r4 = await rec(A);
  ok("an OFF stamped before the activation is clamped to it (moments only move forward)", ts(r4?.deact) === ts(r3?.last), J(r4));
  await ctlState(A, "ENABLED", "2026-12-01 09:30:00");
  const r5 = await rec(A);
  ok("an ON stamped before the deactivation lands 1 ms after it", ts(r5?.last) === ts(r4?.deact)! + 1 && ts(r5?.prior) === ts(r3?.last), J(r5));
  const Y = await biz("nte2c-Y");
  await ctlInsert(Y, "ENABLED", "2026-01-01 08:00:00");
  const beforeStmt = Date.now();
  await owner.$executeRawUnsafe(`UPDATE "BusinessFeatureAccess" SET "state" = 'DISABLED' WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, Y);
  const r6 = await rec(Y);
  ok("a statement that does not stamp updatedAt is recorded at the statement time", ts(r6?.deact)! >= beforeStmt - 5_000 && ts(r6?.deact)! <= Date.now() + 5_000, J(r6));
  // INHERIT: OFF only while globalEnabled is false; otherwise the catalog default decides (unknown: no write)
  await ctlInsert(B, "ENABLED", "2026-12-02 08:00:00");
  await ctlState(B, "INHERIT", "2026-12-02 09:00:00");
  const rb1 = await rec(B);
  ok("INHERIT with globalEnabled false: decided OFF, recorded", ts(rb1?.deact) === T("2026-12-02T09:00:00").getTime(), J(rb1));
  await ctlState(B, "ENABLED", "2026-12-02 10:00:00");
  await policy(`"globalEnabled" = true`, "2026-12-02 10:30:00");
  const rb2 = await rec(B);
  await ctlState(B, "INHERIT", "2026-12-02 11:00:00");
  ok("INHERIT with globalEnabled true: unknown to SQL (catalog default) — the trigger writes nothing", same(await rec(B), rb2), J(await rec(B)));
  await policy(`"globalEnabled" = false`, "2026-12-02 11:30:00");
  const rb3 = await rec(B);
  ok("…and globalEnabled back to false decides it OFF at the policy's moment", ts(rb3?.deact) === T("2026-12-02T11:30:00").getTime() && rb3?.src === "policy", J(rb3));
  await ctlState(B, "ENABLED", "2026-12-02 12:00:00");
  const direct = await x(ctl, A, `UPDATE "NotificationEngineActivation" SET "firstActivatedAt" = '2020-01-01' WHERE "businessId" = $1`, A);
  ok("the control plane cannot write the table itself", denied(direct), why(direct));

  // ── 5. the global policy trigger ───────────────────────────────────────────────────────────────────────────────
  console.log("5. trigger on the global policy (kill switch)");
  await ctlInsert(K, "ENABLED", "2026-12-03 08:00:00");
  await ctlState(A, "ENABLED", "2026-12-03 08:00:00");
  const [a0, k0, b0] = [await rec(A), await rec(K), await rec(B)];
  await policy(`"globalEnabled" = false`, "2026-12-03 09:00:00"); // a re-save
  await owner.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET "updatedAt" = '2026-12-03 09:05:00' WHERE "featureKey" = 'notifications_engine'`);
  await policy(`"globalEnabled" = true`, "2026-12-03 09:10:00");
  await policy(`"globalEnabled" = false`, "2026-12-03 09:20:00");
  ok("policy re-save / updatedAt-only edit / globalEnabled flips: NO record moves (override-ENABLED businesses stay ON)",
    same(await rec(A), a0) && same(await rec(K), k0) && same(await rec(B), b0), J([await rec(A), a0]));
  await policy(`"emergencyDisabled" = true`, "2026-12-03 10:00:00");
  const [a1, k1] = [await rec(A), await rec(K)];
  ok("kill switch ON: every override-ENABLED business deactivated at its moment (source policy), first unchanged",
    [a1, k1].every((r) => ts(r?.deact) === T("2026-12-03T10:00:00").getTime() && r?.src === "policy") && ts(a1?.first) === ts(a0?.first) && ts(k1?.first) === ts(k0?.first), J([a1, k1]));
  await policy(`"emergencyDisabled" = true, "globalEnabled" = true`, "2026-12-03 10:10:00");
  ok("while the kill switch is on, another policy change re-decides OFF: nothing moves", same(await rec(A), a1) && same(await rec(K), k1));
  await policy(`"globalEnabled" = false`, "2026-12-03 10:15:00");
  await policy(`"emergencyDisabled" = false`, "2026-12-03 10:30:00");
  const [a2, k2] = [await rec(A), await rec(K)];
  ok("kill switch lifted: re-activated at its moment, prior = the period the kill switch ended",
    [a2, k2].every((r) => ts(r?.last) === T("2026-12-03T10:30:00").getTime()) && ts(a2?.prior) === ts(a0?.last) && ts(k2?.prior) === ts(k0?.last) && ts(a2?.first) === ts(a0?.first), J([a2, k2]));
  const noOverride = await biz("nte2c-none");
  await policy(`"emergencyDisabled" = true`, "2026-12-03 11:00:00");
  await policy(`"emergencyDisabled" = false`, "2026-12-03 11:30:00");
  ok("a business never activated gets no record from the kill switch", (await rec(noOverride)) === null);

  // ── 6. observe as the runtime ─────────────────────────────────────────────────────────────────────────────────
  console.log("6. notification_engine_observe as the runtime");
  const obs = (guc: number | null, b: number, on: boolean, at: string) =>
    q(runtime, guc, `SELECT "outcome", "first_at", "last_at", "prior_at", "deactivated_at" FROM public.notification_engine_observe($1::int, $2::boolean, $3::timestamp(3))`, b, on, at);
  const wrong = await obs(A, G, true, "2026-12-04 08:00:00");
  ok("another business's id → refused (42501), nothing written", isErr(wrong) && /only the business of this tenant context|42501/.test(wrong) && (await rec(G)) === null, why(wrong));
  const none = await obs(null, G, true, "2026-12-04 08:00:00");
  ok("no tenant context → refused", isErr(none) && (await rec(G)) === null, why(none));
  await policy(`"globalEnabled" = true`, "2026-12-04 07:00:00");
  const g1 = await obs(G, G, true, "2026-12-04 08:00:00");
  ok("global-only (no override, globalEnabled true — unknown to SQL): first seen ON recorded, source worker",
    rows(g1)[0]?.outcome === "activated" && ts(rows(g1)[0]?.first_at) === T("2026-12-04T08:00:00").getTime() && (await rec(G))?.src === "worker", why(g1));
  const gRec = await rec(G);
  const g2 = await obs(G, G, true, "2026-12-04 09:00:00");
  await policy(`"emergencyDisabled" = false`, "2026-12-04 09:30:00"); // a re-save
  const g3 = await obs(G, G, true, "2026-12-04 10:00:00");
  ok("…recorded ONCE: later observations and policy re-saves do not move it", rows(g2)[0]?.outcome === "unchanged" && rows(g3)[0]?.outcome === "unchanged" && same(await rec(G), gRec), why(g3));
  const g4 = await obs(G, G, false, "2026-12-04 11:00:00");
  ok("seen OFF: deactivation recorded", rows(g4)[0]?.outcome === "deactivated" && ts(rows(g4)[0]?.deactivated_at) === T("2026-12-04T11:00:00").getTime(), why(g4));
  const g5 = await obs(G, G, true, "2026-12-04 12:00:00");
  ok("seen ON again: re-activation, first unchanged", rows(g5)[0]?.outcome === "reactivated" && ts(rows(g5)[0]?.first_at) === ts(gRec?.first), why(g5));
  await policy(`"globalEnabled" = false`, "2026-12-04 13:00:00");
  ok("globalEnabled false decides the global-only business OFF (policy trigger)", ts((await rec(G))?.deact) === T("2026-12-04T13:00:00").getTime());
  const c1 = await obs(G, G, true, "2026-12-04 14:00:00");
  ok("a claim of ON that globalEnabled false contradicts → refused, nothing written", rows(c1)[0]?.outcome === "refused" && ts((await rec(G))?.deact) === T("2026-12-04T13:00:00").getTime(), why(c1));
  const aNow = await rec(A);
  const c2 = await obs(A, A, false, "2026-12-04 14:00:00");
  ok("a claim of OFF that A's ENABLED override contradicts → refused", rows(c2)[0]?.outcome === "refused" && same(await rec(A), aNow), why(c2));
  const authObs = await q(auth, G, `SELECT * FROM public.notification_engine_observe($1::int, true, '2026-12-04 15:00:00')`, G);
  ok("another role (app_auth) cannot EXECUTE it", denied(authObs), why(authObs));
  const helper = await q(runtime, A, `SELECT public.notification_engine_record($1::int, true, '2030-01-01'::timestamp(3), 'worker') AS r`, A);
  ok("the runtime cannot run the internal helper", denied(helper), why(helper));

  // ── 3. RLS + grants in action ──────────────────────────────────────────────────────────────────────────────────
  console.log("3. RLS and privileges in action");
  const own = await q(runtime, A, `SELECT "businessId" FROM "NotificationEngineActivation"`);
  ok("the runtime in A's tenant reads exactly A's record", !isErr(own) && rows(own).length === 1 && rows(own)[0].businessId === A, why(own));
  const noTenant = await q(runtime, null, `SELECT count(*)::int AS n FROM "NotificationEngineActivation"`);
  ok("without a tenant context: zero rows (fail closed)", !isErr(noTenant) && rows(noTenant)[0].n === 0, why(noTenant));
  for (const [label, sql] of [
    ["INSERT", `INSERT INTO "NotificationEngineActivation" ("businessId", "firstActivatedAt", "lastActivatedAt", "priorActivatedAt", "lastSource") VALUES (${A}, now(), now(), now(), 'worker')`],
    ["UPDATE", `UPDATE "NotificationEngineActivation" SET "firstActivatedAt" = '2020-01-01' WHERE "businessId" = ${A}`],
    ["DELETE", `DELETE FROM "NotificationEngineActivation" WHERE "businessId" = ${A}`],
  ] as const) {
    const r = await x(runtime, A, sql);
    ok(`the runtime cannot ${label} (its own business included)`, denied(r), why(r));
  }
  const ctlRead = await q(ctl, A, `SELECT count(*) FROM "NotificationEngineActivation"`);
  ok("the control plane cannot read it", denied(ctlRead), why(ctlRead));
  ok("A's record is intact after all that", same(await rec(A), aNow));

  // ── 7. CHECKs and erasure ──────────────────────────────────────────────────────────────────────────────────────
  console.log("7. CHECKs and erasure");
  const Z = await biz("nte2c-Z");
  const badOrder = await owner.$executeRawUnsafe(`INSERT INTO "NotificationEngineActivation" ("businessId", "firstActivatedAt", "lastActivatedAt", "priorActivatedAt", "lastSource")
    VALUES ($1, '2026-12-05', '2026-12-04', '2026-12-05', 'worker')`, Z).then(() => "ok").catch((e: Error) => `ERR ${e.message}`);
  ok("CHECK: lastActivatedAt before firstActivatedAt is refused", isErr(badOrder) && /NotificationEngineActivation_order/.test(badOrder), why(badOrder));
  const badPrior = await owner.$executeRawUnsafe(`INSERT INTO "NotificationEngineActivation" ("businessId", "firstActivatedAt", "lastActivatedAt", "priorActivatedAt", "lastSource")
    VALUES ($1, '2026-12-04', '2026-12-05', '2026-12-04', 'worker')`, Z).then(() => "ok").catch((e: Error) => `ERR ${e.message}`);
  ok("CHECK: a re-activation without a deactivation is refused", isErr(badPrior) && /NotificationEngineActivation_order/.test(badPrior), why(badPrior));
  const badSrc = await owner.$executeRawUnsafe(`INSERT INTO "NotificationEngineActivation" ("businessId", "firstActivatedAt", "lastActivatedAt", "priorActivatedAt", "lastSource")
    VALUES ($1, '2026-12-04', '2026-12-04', '2026-12-04', 'admin')`, Z).then(() => "ok").catch((e: Error) => `ERR ${e.message}`);
  ok("CHECK: an unknown source token is refused", isErr(badSrc) && /NotificationEngineActivation_source/.test(badSrc), why(badSrc));
  await ctlInsert(Z, "ENABLED", "2026-12-05 08:00:00");
  ok("Z switched ON has a record", (await rec(Z)) !== null);
  await owner.$executeRawUnsafe(`DELETE FROM "BusinessFeatureAccess" WHERE "businessId" = $1`, Z);
  await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE "id" = $1`, Z);
  ok("a business deleted takes its record (ON DELETE CASCADE)", (await rec(Z)) === null);

  // ── 8. backward compatibility ──────────────────────────────────────────────────────────────────────────────────
  console.log("8. backward compatibility");
  const before = rows(await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "NotificationEngineActivation"`))[0].n;
  const otherKey = rows(await owner.$queryRawUnsafe(`SELECT "key" FROM "PlatformFeatureDefinition" WHERE "key" <> 'notifications_engine' ORDER BY "key" LIMIT 1`))[0]?.key as string;
  const o1 = await x(ctl, B, `INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, $2, 'ENABLED', now())`, B, otherKey);
  const o2 = await x(ctl, B, `UPDATE "BusinessFeatureAccess" SET "state" = 'DISABLED', "reason" = 'lab', "updatedByUserId" = NULL, "updatedAt" = now() WHERE "businessId" = $1 AND "featureKey" = $2`, B, otherKey);
  const after = rows(await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "NotificationEngineActivation"`))[0].n;
  ok("the control plane's mutation statements on another feature still work and write no record", !isErr(o1) && !isErr(o2) && before === after, why(o1) + why(o2));
  const seeded = rows(await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "NotificationDelivery" d JOIN "Notification" n ON n."id" = d."notificationId"
    WHERE n."dedupeKey" = 'seed:inventory:critical:item:1' AND d."status" = 'PENDING' AND d."channel" = 'PUSH'`))[0]?.n;
  ok("the existing notification rows are untouched (the seeded PENDING push is still PENDING)", seeded === 1, String(seeded));
  const pol = rows(await owner.$queryRawUnsafe(`SELECT "globalEnabled", "emergencyDisabled" FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine'`))[0];
  ok("the policy is back OFF (globalEnabled false, not emergency) after the battery", pol.globalEnabled === false && pol.emergencyDisabled === false, J(pol));

  console.log(`\nnotification engine activation battery: ${pass} PASS, ${failures.length} FAIL`);
  await Promise.all([owner.$disconnect(), ctl.$disconnect(), runtime.$disconnect(), auth.$disconnect()]);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
