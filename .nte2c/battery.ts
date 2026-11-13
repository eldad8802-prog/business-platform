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
 * Owner conditions 2026-11-13 (triggers on the SHARED tables approved in principle, on conditions):
 *   9. Only 'notifications_engine': 1,000-row insert / update / delete of other keys, three rounds, against the same
 *      statements with the trigger disabled — same rows, same timing, no write to the new table (xmin / ctid), no
 *      error; a statement over both keys records only the engine's row; the platform admin's real mutation service
 *      (control plane) on another feature; no plan / subscription model exists to touch.
 *  10. Policy edits never move firstActivatedAt; re-saves / updatedAt-only / actor-only edits write nothing.
 *  11. The worker's cutover rule (pushableCreatedAt) on the records the triggers write: history and OFF-period rows
 *      never pushable; a quiet-hours deferral survives policy edits and one OFF → ON.
 *  12. Concurrency — two sessions, explicit transactions held open: override ‖ policy (both orders), two overrides
 *      (same / different businesses), override ‖ worker observation (both orders), policy ‖ observation, and the
 *      only deadlock shape (one transaction writing both tables against another) resolved by Postgres (40P01).
 *  13. Failure injection: the trigger body raising blocks only the engine's own switches (cleanly); every other
 *      feature write succeeds.
 *  14. PR #959's emergency-switch function installed verbatim (.nte2c/pr959-emergency-switch.sql) and its logic applied
 *      to this key; PR #918's seed statements.
 *
 * env: OWNER_URL, CTL_URL, RUNTIME_URL, AUTH_URL, SUPER_URL (lab-side DDL only). Synthetic only. ZERO network.
 */
import fs from "node:fs";
import path from "node:path";

import { PrismaClient, Prisma } from "@prisma/client";

const MIGRATION = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261212090000_notification_engine_activation/migration.sql"), "utf8");

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const ctl = new PrismaClient({ datasourceUrl: process.env.CTL_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });
const auth = new PrismaClient({ datasourceUrl: process.env.AUTH_URL! });
// The lab superuser: ONLY for lab-side DDL the owner may not run (the failure-injection trap, installing PR #959's
// function as a fixture). Never used for an assertion about privileges.
const superC = new PrismaClient({ datasourceUrl: process.env.SUPER_URL! });

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

  {
  // ══ Owner conditions 2026-11-13 (triggers on the SHARED tables approved in principle, on conditions) ═══════════════
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const actSnap = async () => J(rows(await owner.$queryRawUnsafe(`SELECT "businessId", xmin::text AS x, ctid::text AS c FROM "NotificationEngineActivation" ORDER BY 1`)));
  const actCount = async () => Number(rows(await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "NotificationEngineActivation"`))[0].n);
  const effectiveOf = async (b: number) => rows(await owner.$queryRawUnsafe(`SELECT public.notification_engine_effective(a."state"::text, p."globalEnabled", p."emergencyDisabled") AS e
      FROM (SELECT 1) AS one LEFT JOIN "PlatformFeaturePolicy" p ON p."featureKey" = 'notifications_engine'
      LEFT JOIN "BusinessFeatureAccess" a ON a."businessId" = $1 AND a."featureKey" = 'notifications_engine'`, b))[0]?.e as boolean | null;
  const recOn = (r: Rec) => r !== null && (r.deact === null || ts(r.deact)! < ts(r.last)!);
  /** The record agrees with what SQL decides (an UNKNOWN effective state — catalog default — is the worker's to record). */
  const consistent = async (b: number) => {
    const e = await effectiveOf(b);
    const r = await rec(b);
    return { ok: e === null || e === recOn(r), detail: `effective=${e} record=${J(r)}` };
  };
  const ownerPolicy = (sets: string, at: string) => x(owner, null,
    `UPDATE "PlatformFeaturePolicy" SET ${sets}, "updatedAt" = '${at}'::timestamp(3) WHERE "featureKey" = 'notifications_engine'`);
  /**
   * Two sessions interleaved: `first` runs in an explicit transaction on c1 and HOLDS it open; `second` starts while
   * it is open; after holdMs we note whether `second` is still waiting (blocked on a lock), then `first` commits.
   */
  async function race(c1: PrismaClient, guc1: number | null, first: (tx: Tx) => Promise<unknown>, second: () => Promise<unknown>, holdMs = 700) {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let ready!: () => void;
    const isReady = new Promise<void>((r) => (ready = r));
    const p1 = c1.$transaction(async (tx) => {
      if (guc1 !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc1}', true)`);
      await first(tx);
      ready();
      await hold;
    }, { timeout: 60_000, maxWait: 20_000 }).then(() => "ok", (e: Error) => `ERR ${e.message}`);
    await Promise.race([isReady, p1]);
    let settled = false;
    const p2 = second().then((v) => { settled = true; return v; });
    await sleep(holdMs);
    const blocked = !settled;
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    return { r1, r2, blocked };
  }
  const ctlUpd = (tx: Tx, b: number, state: string, at: string) => tx.$executeRawUnsafe(
    `UPDATE "BusinessFeatureAccess" SET "state" = $2::"BusinessFeatureAccessState", "updatedAt" = $3::timestamp(3) WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, b, state, at);
  const ctlIns = (tx: Tx, b: number, state: string, at: string) => tx.$executeRawUnsafe(
    `INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'notifications_engine', $2::"BusinessFeatureAccessState", $3::timestamp(3))`, b, state, at);
  const obsQ = (b: number, on: boolean, at: string) => q(runtime, b,
    `SELECT "outcome", "first_at", "last_at", "prior_at", "deactivated_at" FROM public.notification_engine_observe($1::int, $2::boolean, $3::timestamp(3))`, b, on, at);

  // ── 9. only notifications_engine ─────────────────────────────────────────────────────────────────────────────────
  console.log("9. only featureKey 'notifications_engine': other keys keep the same rows, the same timings, no extra write, no error");
  const N = 1000;
  const keys = rows(await owner.$queryRawUnsafe(`SELECT "key" FROM "PlatformFeatureDefinition" WHERE "key" <> 'notifications_engine' ORDER BY "key"`)).map((r) => r.key as string);
  const range = async (tag: string) => {
    const ids = rows(await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name", "updatedAt") SELECT $1 || g, now() FROM generate_series(1, ${N}) g RETURNING "id"`, tag)).map((r) => Number(r.id));
    return { lo: Math.min(...ids), hi: Math.max(...ids) };
  };
  const S1 = await range("nte2c-bulk-on-");
  const S2 = await range("nte2c-bulk-off-");
  const tgOwner = rows(await owner.$queryRawUnsafe(`SELECT tableowner = current_user AS mine FROM pg_tables WHERE tablename = 'BusinessFeatureAccess'`))[0]?.mine === true;
  ok("lab precondition: the owner can disable the override trigger for the control run (it owns the table)", tgOwner);
  const bulk = async (s: { lo: number; hi: number }, key: string) => {
    const t: Record<string, number> = {};
    const errs: string[] = [];
    const w = `"featureKey" = '${key}' AND "businessId" BETWEEN ${s.lo} AND ${s.hi}`;
    const time = async (k: string, sql: string) => {
      const st = performance.now();
      await owner.$executeRawUnsafe(sql).catch((e: Error) => errs.push(`${k}: ${e.message.slice(0, 120)}`));
      t[k] = performance.now() - st;
    };
    await time("insert", `INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") SELECT "id", '${key}', 'ENABLED', now() FROM "Business" WHERE "id" BETWEEN ${s.lo} AND ${s.hi}`);
    await time("state", `UPDATE "BusinessFeatureAccess" SET "state" = 'DISABLED', "updatedAt" = now() WHERE ${w}`);
    await time("reason", `UPDATE "BusinessFeatureAccess" SET "reason" = 'lab bulk', "updatedByUserId" = NULL, "updatedAt" = now() WHERE ${w}`);
    await time("inherit", `UPDATE "BusinessFeatureAccess" SET "state" = 'INHERIT', "updatedAt" = now() WHERE ${w}`);
    const snap = J(rows(await owner.$queryRawUnsafe(`SELECT "businessId" - ${s.lo} AS i, "featureKey" AS k, "state"::text AS s, "reason" AS r FROM "BusinessFeatureAccess" WHERE ${w} ORDER BY 1`)));
    await time("delete", `DELETE FROM "BusinessFeatureAccess" WHERE ${w}`);
    return { t, snap, errs, total: Object.values(t).reduce((a, b) => a + b, 0) };
  };
  const TG = `"BusinessFeatureAccess_notification_engine_activation"`;
  const act0 = await actSnap();
  let withT = 0, withoutT = 0, sameRows = true, noErr = true;
  const perOp: Record<string, [number, number]> = {};
  for (let round = 0; round < 3; round++) {
    const key = keys[round % keys.length]!;
    const runOn = () => bulk(S1, key);
    const runOff = async () => {
      await owner.$executeRawUnsafe(`ALTER TABLE "BusinessFeatureAccess" DISABLE TRIGGER ${TG}`);
      try { return await bulk(S2, key); } finally { await owner.$executeRawUnsafe(`ALTER TABLE "BusinessFeatureAccess" ENABLE TRIGGER ${TG}`); }
    };
    // the middle round runs the trigger-less control first, so a warm cache favours neither side
    let a: Awaited<ReturnType<typeof bulk>>, b: Awaited<ReturnType<typeof bulk>>;
    if (round === 1) { b = await runOff(); a = await runOn(); } else { a = await runOn(); b = await runOff(); }
    withT += a.total; withoutT += b.total;
    sameRows &&= a.snap === b.snap;
    noErr &&= a.errs.length === 0 && b.errs.length === 0;
    for (const k of Object.keys(a.t)) perOp[k] = [(perOp[k]?.[0] ?? 0) + a.t[k]!, (perOp[k]?.[1] ?? 0) + b.t[k]!];
    if (a.errs.length || b.errs.length) console.log("    errors:", J([a.errs, b.errs]));
  }
  console.log(`    ${N} rows × 5 statements × 3 rounds — with the trigger ${withT.toFixed(0)} ms, without ${withoutT.toFixed(0)} ms; per statement (with / without): ` +
    Object.entries(perOp).map(([k, [a, b]]) => `${k} ${a.toFixed(0)}/${b.toFixed(0)}`).join(", "));
  ok(`bulk insert / state / reason / INHERIT / delete of ${N} rows of other keys: no error`, noErr);
  ok("…the same rows as the identical statements with the trigger disabled (state, reason, key — row for row)", sameRows);
  ok("…NO write to the activation table (every record's xmin / ctid unchanged, no row added)", (await actSnap()) === act0);
  ok("…the same timing: with the trigger ≤ 1.5 × without (+100 ms noise floor)", withT <= withoutT * 1.5 + 100, `${withT.toFixed(0)} vs ${withoutT.toFixed(0)} ms`);
  // A statement touching BOTH keys at once: the other key's row changes, only the engine row is recorded.
  const M = await biz("nte2c-mixed");
  await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, $2, 'DISABLED', now()), ($1, 'notifications_engine', 'DISABLED', now())`, M, keys[0]);
  const mixedBefore = await actCount();
  const mixed = await x(owner, null, `UPDATE "BusinessFeatureAccess" SET "state" = 'ENABLED', "updatedAt" = '2026-12-06 08:00:00' WHERE "businessId" = $1`, M);
  const mrows = rows(await owner.$queryRawUnsafe(`SELECT "featureKey" AS k, "state"::text AS s FROM "BusinessFeatureAccess" WHERE "businessId" = $1 ORDER BY 1`, M));
  ok("one statement over both keys: both rows updated, exactly ONE record (the engine's), no error",
    mixed === 2 && mrows.every((r) => r.s === "ENABLED") && (await actCount()) === mixedBefore + 1 && (await rec(M))?.src === "override", why(mixed) + J(mrows));
  // The existing admin mutation path itself (lib/services/platform-admin/update-business-feature-access.service.ts),
  // run as the control plane, on another feature: unchanged behaviour, no record.
  const U = Number(rows(await owner.$queryRawUnsafe(`INSERT INTO "User" ("email", "businessId", "updatedAt") VALUES ('nte2c-admin@lab.invalid', $1, now()) RETURNING "id"`, A))[0].id);
  process.env.CONTROL_PLANE_DATABASE_URL = process.env.CTL_URL;
  process.env.DATABASE_URL = process.env.RUNTIME_URL; // the tenant client the control-plane job's lifecycle check uses
  try {
    const cat = await import("../lib/services/feature-access/platform-feature-catalog");
    const gate = await import("../lib/services/feature-access/owner-gated-features");
    const svc = await import("../lib/services/platform-admin/update-business-feature-access.service");
    const key = keys.find((k) => cat.isPlatformFeatureKey(k) && cat.getPlatformFeatureCatalogEntry(k).mutable && !gate.refusedByOwnerGate(k, "ENABLED"));
    const AD = await biz("nte2c-admin-path");
    const before = await actSnap();
    const out: string[] = [];
    for (const state of ["ENABLED", "DISABLED", "INHERIT"] as const) {
      const r = await svc.updateBusinessFeatureAccess({ actorUserId: U, businessId: AD, featureKey: key!, state, reason: "lab: admin path regression" })
        .then(() => "ok", (e: Error) => `ERR ${e.message}`);
      out.push(r);
    }
    const row = rows(await owner.$queryRawUnsafe(`SELECT "state"::text AS s, "reason" AS r, "updatedByUserId" AS u FROM "BusinessFeatureAccess" WHERE "businessId" = $1 AND "featureKey" = $2`, AD, key));
    const audits = Number(rows(await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "PlatformAuditEvent" WHERE "targetId" = $1`, String(AD)))[0].n);
    ok(`the platform admin's own mutation service (control plane) on '${key}': ENABLED → DISABLED → INHERIT all succeed, row + 3 audit rows as before, no record`,
      out.every((r) => r === "ok") && row[0]?.s === "INHERIT" && row[0]?.u === U && audits === 3 && (await actSnap()) === before && (await rec(AD)) === null, J(out) + J(row) + audits);
  } catch (e) {
    ok("the platform admin's own mutation service loads and runs", false, e instanceof Error ? e.message.slice(0, 200) : String(e));
  }
  ok("there is no plan / subscription model in the schema to touch (PushSubscription is web push), and the migration names no other relation",
    !/model \w*Plan\w* \{|model (?!PushSubscription)\w*Subscription\w* \{/.test(fs.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8")) &&
    (MIGRATION.match(/"[A-Z][A-Za-z]*"/g) ?? []).every((n) => ['"Business"', '"BusinessFeatureAccess"', '"PlatformFeaturePolicy"', '"NotificationEngineActivation"'].includes(n)));

  // ── 10. policy edits never move a first activation; re-saves record nothing ─────────────────────────────────────
  console.log("10. a global policy edit never moves firstActivatedAt; re-saves / updatedAt-only edits write nothing");
  const firsts = async () => J(rows(await owner.$queryRawUnsafe(`SELECT "businessId", "firstActivatedAt" FROM "NotificationEngineActivation" ORDER BY 1`)));
  const f0 = await firsts();
  const s0 = await actSnap();
  await ownerPolicy(`"globalEnabled" = false`, "2026-12-07 08:00:00");            // a re-save of the current value
  await x(owner, null, `UPDATE "PlatformFeaturePolicy" SET "updatedAt" = '2026-12-07 08:05:00' WHERE "featureKey" = 'notifications_engine'`);
  await x(owner, null, `UPDATE "PlatformFeaturePolicy" SET "updatedByUserId" = ${U} WHERE "featureKey" = 'notifications_engine'`);
  await x(owner, null, `UPDATE "PlatformFeaturePolicy" SET "globalEnabled" = "globalEnabled", "emergencyDisabled" = "emergencyDisabled" WHERE "featureKey" = 'notifications_engine'`);
  ok("re-save, updatedAt-only, actor-only and same-value edits: not one record touched (xmin / ctid identical)", (await actSnap()) === s0);
  for (const [sets, at] of [[`"globalEnabled" = true`, "2026-12-07 09:00:00"], [`"emergencyDisabled" = true`, "2026-12-07 09:10:00"],
    [`"emergencyDisabled" = false`, "2026-12-07 09:20:00"], [`"globalEnabled" = false`, "2026-12-07 09:30:00"],
    [`"emergencyDisabled" = true, "globalEnabled" = true`, "2026-12-07 09:40:00"], [`"emergencyDisabled" = false, "globalEnabled" = false`, "2026-12-07 09:50:00"]] as const) {
    await ownerPolicy(sets, at);
  }
  ok("six real policy changes (globalEnabled / kill switch, alone and together): every business's firstActivatedAt identical", (await firsts()) === f0);

  // ── 11. OFF → ON never makes history pushable; a quiet-hours deferral survives (the worker's rule on these records)
  console.log("11. the cutover rule on the records the triggers write: history never pushable, quiet deferrals kept");
  // worker-decision.ts pushableCreatedAt (notify/3-engine and later) — mirrored here verbatim in substance.
  const pushable = (createdAt: string, r: Rec) => {
    if (!r || !recOn(r)) return false;
    const t = T(createdAt).getTime();
    if (t >= ts(r.last)!) return true;
    return r.deact !== null && t >= ts(r.prior)! && t < ts(r.deact)!;
  };
  const Q = await biz("nte2c-quiet");
  const h0 = "2026-12-10T07:00:00";   // created before the engine ever ran for Q (historical)
  await ctlInsert(Q, "ENABLED", "2026-12-10 08:00:00");
  const r1 = "2026-12-10T21:30:00";   // created ON, deferred by quiet hours to 07:00 the next day
  await ownerPolicy(`"globalEnabled" = true`, "2026-12-10 22:00:00");
  await ownerPolicy(`"globalEnabled" = false`, "2026-12-10 22:10:00");
  await x(owner, null, `UPDATE "PlatformFeaturePolicy" SET "updatedAt" = '2026-12-10 22:20:00' WHERE "featureKey" = 'notifications_engine'`);
  const q1 = await rec(Q);
  ok("ON: the historical row is not pushable, the quiet-deferred one is — and policy edits overnight did not touch it", !pushable(h0, q1) && pushable(r1, q1) && ts(q1?.first) === T("2026-12-10T08:00:00").getTime(), J(q1));
  await ctlState(Q, "DISABLED", "2026-12-10 23:00:00");
  const r2 = "2026-12-10T23:30:00";   // created while OFF
  const qOff = await rec(Q);
  ok("while OFF nothing is pushable (the worker holds; the record says OFF)", [h0, r1, r2].every((cr) => !pushable(cr, qOff)), J(qOff));
  await ctlState(Q, "ENABLED", "2026-12-11 06:00:00");
  const q2 = await rec(Q);
  ok("OFF → ON: the deferral from the last ON period survives; the row created while OFF and the history stay unpushable",
    pushable(r1, q2) && !pushable(r2, q2) && !pushable(h0, q2), J(q2));
  const r3 = "2026-12-11T06:10:00";
  await ownerPolicy(`"emergencyDisabled" = true`, "2026-12-11 06:30:00");
  await ownerPolicy(`"emergencyDisabled" = false`, "2026-12-11 06:45:00");
  const q3 = await rec(Q);
  ok("kill switch on / off: the deferral of the period it ended (06:00–06:30) survives; two toggles back is history; OFF rows never",
    pushable(r3, q3) && !pushable(r1, q3) && !pushable(r2, q3) && !pushable(h0, q3) && ts(q3?.first) === ts(q1?.first), J(q3));
  await ownerPolicy(`"emergencyDisabled" = false`, "2026-12-11 07:00:00");
  ok("…and a re-save of the lifted kill switch afterwards changes none of that", same(await rec(Q), q3));

  // ── 12. concurrency: two sessions racing ─────────────────────────────────────────────────────────────────────────
  console.log("12. concurrency — two sessions, explicit transactions held open, interleaved");
  // (a) override toggle vs policy toggle, the override's transaction first
  const R1 = await biz("nte2c-race-1");
  await ctlInsert(R1, "ENABLED", "2026-12-12 08:00:00");
  await ctlState(R1, "DISABLED", "2026-12-12 08:10:00");
  await ownerPolicy(`"emergencyDisabled" = true`, "2026-12-12 08:20:00");
  const a = await race(ctl, R1, (tx) => ctlUpd(tx, R1, "ENABLED", "2026-12-12 08:30:00"),
    () => ownerPolicy(`"emergencyDisabled" = false`, "2026-12-12 08:31:00"));
  const ca = await consistent(R1);
  ok(`override ON (tx open, kill switch on) ‖ kill switch lifted: both commit, the record ends ON = the effective state${a.blocked ? " (the policy write waited for the override)" : ""}`,
    a.r1 === "ok" && !isErr(a.r2) && ca.ok && recOn(await rec(R1)), J(a) + ca.detail);
  // (b) the policy's transaction first
  const R2 = await biz("nte2c-race-2");
  await ctlInsert(R2, "ENABLED", "2026-12-12 09:00:00");
  await ctlState(R2, "DISABLED", "2026-12-12 09:10:00");
  await ownerPolicy(`"emergencyDisabled" = true`, "2026-12-12 09:20:00");
  const b = await race(owner, null, (tx) => tx.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET "emergencyDisabled" = false, "updatedAt" = '2026-12-12 09:30:00' WHERE "featureKey" = 'notifications_engine'`),
    () => x(ctl, R2, `UPDATE "BusinessFeatureAccess" SET "state" = 'ENABLED', "updatedAt" = '2026-12-12 09:31:00' WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, R2));
  const cb = await consistent(R2);
  ok(`kill switch lifted (tx open) ‖ override ON: both commit, the record ends ON = the effective state${b.blocked ? " (the override waited for the policy)" : ""}`,
    b.r1 === "ok" && !isErr(b.r2) && cb.ok && recOn(await rec(R2)), J(b) + cb.detail);
  // (c) two override toggles of the same business; (d) of two businesses
  const R3 = await biz("nte2c-race-3");
  await ctlInsert(R3, "DISABLED", "2026-12-12 10:00:00");
  const c = await race(ctl, R3, (tx) => ctlUpd(tx, R3, "ENABLED", "2026-12-12 10:10:00"),
    () => x(ctl, R3, `UPDATE "BusinessFeatureAccess" SET "state" = 'DISABLED', "updatedAt" = '2026-12-12 10:11:00' WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, R3));
  const r3c = await rec(R3);
  ok("two toggles of one business (ON ‖ OFF): the second waits for the first (row lock), both commit; the record holds BOTH transitions and ends OFF",
    c.blocked && c.r1 === "ok" && c.r2 === 1 && ts(r3c?.last) === T("2026-12-12T10:10:00").getTime() && ts(r3c?.deact) === T("2026-12-12T10:11:00").getTime() && (await consistent(R3)).ok, J(c) + J(r3c));
  const R4 = await biz("nte2c-race-4");
  const R5 = await biz("nte2c-race-5");
  await ctlInsert(R4, "DISABLED", "2026-12-12 10:20:00");
  await ctlInsert(R5, "DISABLED", "2026-12-12 10:20:00");
  const d = await race(ctl, R4, (tx) => ctlUpd(tx, R4, "ENABLED", "2026-12-12 10:30:00"),
    () => x(ctl, R5, `UPDATE "BusinessFeatureAccess" SET "state" = 'ENABLED', "updatedAt" = '2026-12-12 10:30:00' WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, R5));
  ok("two toggles of two businesses: neither waits for the other; both recorded ON",
    !d.blocked && d.r1 === "ok" && d.r2 === 1 && recOn(await rec(R4)) && recOn(await rec(R5)), J(d));
  // (e) toggle vs the worker's observation: the override's transaction first (global-only business seen ON)
  await ownerPolicy(`"globalEnabled" = true`, "2026-12-12 11:00:00");
  const W1 = await biz("nte2c-race-w1");
  const w1a = await obsQ(W1, true, "2026-12-12 11:05:00");
  const e = await race(ctl, W1, (tx) => ctlIns(tx, W1, "DISABLED", "2026-12-12 11:10:00"), () => obsQ(W1, true, "2026-12-12 11:11:00"));
  const ce = await consistent(W1);
  ok(`override OFF (tx open) ‖ worker observes ON (decided before the override): the stale claim is refused, the record ends OFF${e.blocked ? " (the observation waited)" : ""}`,
    rows(w1a)[0]?.outcome === "activated" && e.r1 === "ok" && !isErr(e.r2) && ce.ok && !recOn(await rec(W1)), J(e) + ce.detail);
  // (f) the observation's transaction first
  const W2 = await biz("nte2c-race-w2");
  await obsQ(W2, true, "2026-12-12 11:20:00");
  const f = await race(runtime, W2, (tx) => tx.$queryRawUnsafe(`SELECT "outcome" FROM public.notification_engine_observe($1::int, true, '2026-12-12 11:25:00'::timestamp(3))`, W2),
    () => x(ctl, W2, `INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'notifications_engine', 'DISABLED', '2026-12-12 11:26:00')`, W2));
  const cf = await consistent(W2);
  ok("worker observes ON (tx open) ‖ override OFF: both commit, the record ends OFF at the override's moment",
    f.r1 === "ok" && f.r2 === 1 && cf.ok && ts((await rec(W2))?.deact) === T("2026-12-12T11:26:00").getTime(), J(f) + cf.detail);
  // (g) the policy vs the worker's observation (global-only business)
  const W3 = await biz("nte2c-race-w3");
  await obsQ(W3, true, "2026-12-12 11:30:00");
  const g = await race(owner, null, (tx) => tx.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET "globalEnabled" = false, "updatedAt" = '2026-12-12 11:40:00' WHERE "featureKey" = 'notifications_engine'`),
    () => obsQ(W3, true, "2026-12-12 11:41:00"));
  const cg = await consistent(W3);
  ok(`globalEnabled false (tx open) ‖ worker observes ON: the stale claim is refused, the record ends OFF${g.blocked ? " (the observation waited)" : ""}`,
    g.r1 === "ok" && !isErr(g.r2) && cg.ok && !recOn(await rec(W3)), J(g) + cg.detail);
  // (h) a deadlock is possible only for ONE transaction writing BOTH tables in the opposite order of another; Postgres
  // detects it (deadlock_timeout, 1 s) and aborts exactly one with 40P01 — a clean rollback the writer retries.
  const R6 = await biz("nte2c-race-6");
  await ctlInsert(R6, "ENABLED", "2026-12-12 12:00:00");
  let goA!: () => void;
  const gateA = new Promise<void>((r) => (goA = r));
  let aIn!: () => void;
  const aStarted = new Promise<void>((r) => (aIn = r));
  const tA = owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "BusinessFeatureAccess" SET "state" = 'DISABLED', "updatedAt" = '2026-12-12 12:10:00' WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, R6);
    aIn();
    await gateA;
    await tx.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET "updatedAt" = '2026-12-12 12:11:00' WHERE "featureKey" = 'notifications_engine'`);
  }, { timeout: 60_000 }).then(() => "ok", (er: Error) => `ERR ${er.message}`);
  await aStarted;
  const tB = owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET "globalEnabled" = true, "updatedAt" = '2026-12-12 12:12:00' WHERE "featureKey" = 'notifications_engine'`);
  }, { timeout: 60_000 }).then(() => "ok", (er: Error) => `ERR ${er.message}`);
  await sleep(400);
  goA();
  const [dA, dB] = await Promise.all([tA, tB]);
  const dl = [dA, dB].filter((v) => v !== "ok");
  console.log(`    deadlock probe: A=${dA.slice(0, 110)} | B=${dB.slice(0, 110)}`);
  ok("opposite-order writers of both tables: at most ONE aborted, by the deadlock detector (40P01 / write conflict), the other commits",
    dl.length <= 1 && dl.every((v) => /deadlock|write conflict|40P01|P2034/i.test(v)), J([dA, dB]));
  if (dl.length === 1) {
    const retry = dA !== "ok"
      ? await owner.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`UPDATE "BusinessFeatureAccess" SET "state" = 'DISABLED', "updatedAt" = '2026-12-12 12:20:00' WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, R6);
          await tx.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET "updatedAt" = '2026-12-12 12:21:00' WHERE "featureKey" = 'notifications_engine'`);
        }).then(() => "ok", (er: Error) => `ERR ${er.message}`)
      : await ownerPolicy(`"globalEnabled" = true`, "2026-12-12 12:20:00");
    ok("…the aborted writer left nothing behind and its retry succeeds", !isErr(retry), why(retry));
  }
  const c6 = await consistent(R6);
  ok("…and the record agrees with the final state", c6.ok, c6.detail);
  await ownerPolicy(`"globalEnabled" = false`, "2026-12-12 13:00:00");
  // every business the battery touched: no record contradicts what SQL decides; the CHECKs held throughout
  const all = rows(await owner.$queryRawUnsafe(`SELECT "businessId" AS b FROM "NotificationEngineActivation" ORDER BY 1`)).map((r) => Number(r.b));
  const bad: string[] = [];
  for (const id of all) { const cc = await consistent(id); if (!cc.ok) bad.push(`${id}: ${cc.detail}`); }
  ok(`after all the races: every one of the ${all.length} records agrees with the effective state SQL decides`, bad.length === 0, bad.join(" | ").slice(0, 400));

  // ── 13. failure: the trigger raising never blocks an unrelated feature write ─────────────────────────────────────
  console.log("13. failure injection — the engine's trigger cannot proceed / raises: only the engine's own switches fail, cleanly");
  {
    // (a) the trigger cannot get its lock in time (a long policy transaction holds key 0): lock_timeout on the writer
    const write = (featureCond: string, state: string) => ctl.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${B}', true)`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '300ms'`);
      return tx.$executeRawUnsafe(`UPDATE "BusinessFeatureAccess" SET "state" = '${state}'::"BusinessFeatureAccessState", "updatedAt" = now() WHERE "businessId" = $1 AND ${featureCond}`, B);
    }).then((n) => n, (er: Error) => `ERR ${er.message}`);
    const held = await race(owner, null, (tx) => tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('notification_engine_activation'), 0)::text`),
      async () => ({ other: await write(`"featureKey" <> 'notifications_engine'`, "ENABLED"), engine: await write(`"featureKey" = 'notifications_engine'`, "DISABLED") }), 2_000);
    const res = held.r2 as { other: unknown; engine: unknown };
    const bState = rows(await owner.$queryRawUnsafe(`SELECT "state"::text AS s FROM "BusinessFeatureAccess" WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, B))[0];
    ok("lock held elsewhere: another feature's write goes straight through; the engine's own switch fails cleanly on lock_timeout (55P03), rolled back whole",
      !isErr(res.other) && isErr(res.engine) && /55P03|lock timeout/i.test(res.engine as string) && bState?.s === "ENABLED", J(res).slice(0, 300));
  }
  // (b) the trigger body itself raises (installed by the lab superuser; restored from migration.sql afterwards)
  await superC.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.notification_engine_effective(p_state text, p_global boolean, p_emergency boolean)
    RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp
    AS $f$ BEGIN RAISE EXCEPTION 'lab trap: the engine trigger body was entered'; END $f$`);
  try {
    const trapAct = await actSnap();
    const t1 = await bulk(S1, keys[0]!);
    ok(`trap set: ${N}-row insert / updates / delete of another key all succeed (the trigger body is never entered for it)`, t1.errs.length === 0, J(t1.errs));
    const p1 = await x(owner, null, `UPDATE "PlatformFeaturePolicy" SET "globalEnabled" = "globalEnabled", "updatedAt" = now() WHERE "featureKey" <> 'notifications_engine'`);
    ok("…every other feature's policy row can be written", !isErr(p1) && Number(p1) >= 1, why(p1));
    const o1 = await x(ctl, B, `INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, $2, 'ENABLED', now())
      ON CONFLICT ("businessId", "featureKey") DO UPDATE SET "state" = 'DISABLED', "updatedAt" = now()`, B, keys[1] ?? keys[0]);
    ok("…the control plane's upsert of another feature succeeds", !isErr(o1), why(o1));
    const eng = await x(ctl, A, `UPDATE "BusinessFeatureAccess" SET "state" = 'DISABLED', "updatedAt" = now() WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, A);
    const engRow = rows(await owner.$queryRawUnsafe(`SELECT "state"::text AS s FROM "BusinessFeatureAccess" WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, A))[0];
    ok("…the engine's OWN switch fails loudly and is rolled back whole (override still ENABLED) — the admin sees the error and retries",
      isErr(eng) && /lab trap/.test(eng) && engRow?.s === "ENABLED", why(eng));
    const engPol = await x(owner, null, `UPDATE "PlatformFeaturePolicy" SET "emergencyDisabled" = true, "updatedAt" = now() WHERE "featureKey" = 'notifications_engine'`);
    const pol2 = rows(await owner.$queryRawUnsafe(`SELECT "emergencyDisabled" AS e FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine'`))[0];
    ok("…the engine's kill switch likewise (nothing half-written)", isErr(engPol) && pol2?.e === false, why(engPol));
    const re = await x(owner, null, `UPDATE "PlatformFeaturePolicy" SET "updatedAt" = now() WHERE "featureKey" = 'notifications_engine'`);
    ok("…an updatedAt-only edit of the engine's policy row still succeeds (returns before the body)", !isErr(re), why(re));
    ok("…and not one record was written meanwhile", (await actSnap()) === trapAct);
  } finally {
    const m = MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.notification_engine_effective[\s\S]*?\$fn\$;/);
    await superC.$executeRawUnsafe(m![0].replace(/;\s*$/, ""));
  }
  const restored = await x(ctl, A, `UPDATE "BusinessFeatureAccess" SET "state" = 'ENABLED', "updatedAt" = now() WHERE "businessId" = $1 AND "featureKey" = 'notifications_engine'`, A);
  ok("trap removed (the migration's own definition restored): the engine switch works again", !isErr(restored), why(restored));

  // ── 14. the emergency switch of PR #959 and the seed rows of PR #918 ─────────────────────────────────────────────
  console.log("14. PR #959 (platform_set_feature_emergency) and PR #918 (feature rows for other keys)");
  const pfe = fs.readFileSync(path.join(process.cwd(), ".nte2c/pr959-emergency-switch.sql"), "utf8");
  const createFn = pfe.slice(pfe.indexOf("CREATE FUNCTION public.platform_set_feature_emergency"), pfe.indexOf("REVOKE ALL ON FUNCTION public.platform_set_feature_emergency"));
  const doGrant = pfe.slice(pfe.indexOf("DO $do$"));
  await superC.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.platform_set_feature_emergency(text, boolean, integer, text, text, text)`);
  await superC.$executeRawUnsafe(createFn.trim().replace(/;\s*$/, ""));
  await superC.$executeRawUnsafe(`ALTER FUNCTION public.platform_set_feature_emergency(text, boolean, integer, text, text, text) OWNER TO ${process.env.OWNER_ROLE ?? "lab_owner"}`);
  await superC.$executeRawUnsafe(`REVOKE ALL ON FUNCTION public.platform_set_feature_emergency(text, boolean, integer, text, text, text) FROM PUBLIC`);
  await superC.$executeRawUnsafe(doGrant.trim().replace(/;\s*$/, ""));
  const intake = "acquisition_web_forms";
  await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
    VALUES ($1, 'lab', 'acquisition', 'lab', false, true, CURRENT_TIMESTAMP) ON CONFLICT ("key") DO NOTHING`, intake);
  await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt") VALUES ($1, true, false, CURRENT_TIMESTAMP) ON CONFLICT ("featureKey") DO NOTHING`, intake);
  const pfeAct = await actSnap();
  const on959 = await q(ctl, null, `SELECT * FROM public.platform_set_feature_emergency($1::text, true, $2::int, 'lab: emergency switch interplay'::text, NULL::text, NULL::text)`, intake, U);
  const off959 = await q(ctl, null, `SELECT * FROM public.platform_set_feature_emergency($1::text, false, $2::int, 'lab: emergency switch interplay'::text, NULL::text, NULL::text)`, intake, U);
  ok("#959's function, as the control plane, on an intake feature: on and off succeed, audit rows written, NO record touched",
    rows(on959)[0]?.is_on === true && rows(off959)[0]?.is_on === false && (await actSnap()) === pfeAct, why(on959) + why(off959));
  const engPolBefore = J(rows(await owner.$queryRawUnsafe(`SELECT "globalEnabled", "emergencyDisabled", "updatedAt" FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine'`)));
  const on959e = await q(ctl, null, `SELECT * FROM public.platform_set_feature_emergency('notifications_engine'::text, true, $1::int, 'lab: emergency switch interplay'::text, NULL::text, NULL::text)`, U);
  ok("#959 cannot switch notifications_engine at all (its allowlist: the seven intake sources) — 22023, nothing changed",
    isErr(on959e) && /not an intake source feature/.test(on959e) && engPolBefore === J(rows(await owner.$queryRawUnsafe(`SELECT "globalEnabled", "emergencyDisabled", "updatedAt" FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine'`))) && (await actSnap()) === pfeAct, why(on959e));
  // Its logic applied to notifications_engine (as a future allowlist entry would): same lock, FOR UPDATE, UPDATE of
  // emergencyDisabled stamped CURRENT_TIMESTAMP (session TimeZone UTC = Neon's default), audit row, one transaction.
  const killWith959Logic = (on: boolean) => owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(17991, hashtext('notifications_engine'))::text`);
    await tx.$queryRawUnsafe(`SELECT "emergencyDisabled" FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine' FOR UPDATE`);
    await tx.$executeRawUnsafe(`UPDATE "PlatformFeaturePolicy" SET "emergencyDisabled" = $1, "updatedByUserId" = $2, "updatedAt" = CURRENT_TIMESTAMP WHERE "featureKey" = 'notifications_engine'`, on, U);
    await tx.$executeRawUnsafe(`INSERT INTO "PlatformAuditEvent" ("actorUserId", "action", "targetType", "targetId", "metadata", "createdAt")
      VALUES ($1, 'PLATFORM_FEATURE_EMERGENCY_SET', 'PlatformFeature', 'notifications_engine', '{}'::jsonb, CURRENT_TIMESTAMP)`, U);
    return rows(await tx.$queryRawUnsafe(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) AS t`))[0].t as Date;
  }).then((t) => t, (er: Error) => `ERR ${er.message}`);
  // E9: switched ON a minute ago on the real clock (the battery's other stamps lie in the future and would clamp).
  const E9 = await biz("nte2c-959");
  await ctlInsert(E9, "ENABLED", new Date(Date.now() - 60_000).toISOString().replace("T", " ").replace("Z", ""));
  const e5 = await rec(E9);
  const t959on = await killWith959Logic(true);
  const e6 = await rec(E9);
  ok("#959's logic on notifications_engine, kill switch ON: the override-ENABLED business is deactivated at its CURRENT_TIMESTAMP stamp, source policy, first unchanged",
    t959on instanceof Date && ts(e6?.deact) === t959on.getTime() && e6?.src === "policy" && ts(e6?.first) === ts(e5?.first), J([t959on, e5, e6]));
  const t959off = await killWith959Logic(false);
  const e7 = await rec(E9);
  ok("…kill switch OFF: re-activated at its stamp, prior = the period it ended, first unchanged",
    t959off instanceof Date && ts(e7?.last) === Math.max(t959off.getTime(), ts(e6?.deact)! + 1) && ts(e7?.prior) === ts(e6?.last) && ts(e7?.first) === ts(e5?.first), J([t959off, e7]));
  const c9 = await consistent(E9);
  ok("…and the record agrees with the state (#959's own advisory lock 17991 and ours never meet: different keys)", c9.ok, c9.detail);
  // PR #918's statements verbatim (INSERT … ON CONFLICT DO NOTHING of definition + policy rows for two other keys)
  const s918 = await actSnap();
  const pr918 = [
    `INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt") VALUES ('z_report_upload', 'העלאת דוחות Z', 'revenue', 'lab', false, true, CURRENT_TIMESTAMP) ON CONFLICT ("key") DO NOTHING`,
    `INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt") VALUES ('settlement_report_upload', 'העלאת דוחות סליקה', 'revenue', 'lab', false, true, CURRENT_TIMESTAMP) ON CONFLICT ("key") DO NOTHING`,
    `INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt") VALUES ('z_report_upload', false, false, CURRENT_TIMESTAMP) ON CONFLICT ("featureKey") DO NOTHING`,
    `INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt") VALUES ('settlement_report_upload', false, false, CURRENT_TIMESTAMP) ON CONFLICT ("featureKey") DO NOTHING`,
  ];
  const r918: unknown[] = [];
  for (const s of pr918) r918.push(await x(owner, null, s));
  ok("#918's seed statements (two other keys' definition + policy rows): applied without error, NO record touched", r918.every((r) => !isErr(r)) && (await actSnap()) === s918, J(r918));

  }

  const pol = rows(await owner.$queryRawUnsafe(`SELECT "globalEnabled", "emergencyDisabled" FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine'`))[0];
  ok("the policy is back OFF (globalEnabled false, not emergency) after the battery", pol.globalEnabled === false && pol.emergencyDisabled === false, J(pol));

  console.log(`\nnotification engine activation battery: ${pass} PASS, ${failures.length} FAIL`);
  await Promise.all([owner.$disconnect(), ctl.$disconnect(), runtime.$disconnect(), auth.$disconnect(), superC.$disconnect()]);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
