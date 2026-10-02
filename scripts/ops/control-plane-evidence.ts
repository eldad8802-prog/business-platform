/**
 * Control plane — Production evidence. Driven by .github/workflows/prod-control-plane-evidence.yml.
 *
 *   OWNER_DATABASE_URL=… RUNTIME_DATABASE_URL=… CONTROL_PLANE_DATABASE_URL=… node_modules/.bin/tsx \
 *     scripts/ops/control-plane-evidence.ts --phase verify|proof --allow-host ep-flat-brook-am4bhq1y
 *
 * verify  (BEFORE the Vercel flag; proves the DB identity and its boundaries)
 *   CATALOG   owner session, READ ONLY: exact effective privileges of app_ctlplane_prod, app_runtime_prod,
 *             app_admin on the feature/audit tables; memberships; the PW-2 policies.
 *   POSITIVE  as app_ctlplane_prod, the exact Prisma calls updateBusinessFeatureAccess makes, against the
 *             QA sandbox tenant (38): target check, read, update-by-count (0), insert, update (1), policy
 *             read, audit append — then a deliberate ROLLBACK. Proves identity, connectivity, grants and
 *             RLS together, and that mutation + audit roll back together. Nothing persists.
 *   NEGATIVE  as app_ctlplane_prod and as app_runtime_prod, each attempt in its own transaction that is
 *             always rolled back: every write outside the capability must fail with 42501 (privilege or
 *             row-level security). Runtime reads and the runtime's audit append must still work.
 *   AFTER     owner, READ ONLY: zero override rows for 38, zero probe audit rows — nothing persisted.
 * proof   (AFTER the owner's two UI changes on business 38: knowledge_derivation DISABLED, then INHERIT)
 *   owner, READ ONLY: exactly one override row in the whole table (38, INHERIT, actor 9); exactly two
 *   PLATFORM_FEATURE_ACCESS_UPDATED events (INHERIT→DISABLED, DISABLED→INHERIT, actor 9, effective false,
 *   affectedRows 1); businesses 3 and 9 untouched; the feature policy unchanged; the admin's MFA
 *   last-verified time; runtime tenant reads see 38's row only inside 38.
 * Output: codes, counts, booleans, timestamps. Never a URL, password, name or free text.
 * Exit: 0 PASS · 1 FAIL · 3 REFUSED · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, enforceReadOnly, RefusedError, verifyReadOnly, verifyRuntimeIdentity } from "./runtime-rls-evidence";

const QA = 38;
const ADMIN_USER = 9;
const FEATURE = "knowledge_derivation";
const PROBE_ACTION = "CONTROL_PLANE_PROBE_ROLLED_BACK";
const SYSTEM_BUSINESS = "__PLATFORM_SYSTEM__";
class Rollback extends Error { constructor() { super("deliberate rollback"); this.name = "Rollback"; } }

type Attempt = { name: string; expect: "deny" | "allow"; got: string; ok: boolean };
const codeOf = (e: unknown) => {
  const m = (e as { meta?: { code?: string; message?: string } }).meta;
  const msg = `${m?.message ?? ""} ${(e as Error)?.message ?? ""}`;
  if (m?.code === "42501" || /permission denied|row-level security|42501/i.test(msg)) return "42501";
  return m?.code ?? (e as { code?: string }).code ?? "error";
};

/** Run `sql` in its own transaction (GUC optional) that is ALWAYS rolled back; classify the outcome. */
async function attempt(db: PrismaClient, name: string, expect: "deny" | "allow", sql: string, guc: number | null): Promise<Attempt> {
  let got = "allowed";
  try {
    await db.$transaction(async (tx) => {
      if (guc !== null) await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(guc));
      await tx.$queryRawUnsafe(sql);
      throw new Rollback();
    });
  } catch (e) {
    got = e instanceof Rollback ? "allowed" : codeOf(e);
  }
  return { name, expect, got, ok: expect === "deny" ? got === "42501" : got === "allowed" };
}

async function privileges(owner: PrismaClient, role: string) {
  const t = async (table: string, p: string) =>
    (await owner.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT has_table_privilege($1, $2, $3) AS ok`, role, `public."${table}"`, p))[0].ok;
  const out: Record<string, string> = {};
  for (const table of ["BusinessFeatureAccess", "PlatformFeaturePolicy", "PlatformFeatureDefinition", "PlatformAuditEvent", "Business"]) {
    let s = "";
    for (const [p, a] of [["SELECT", "r"], ["INSERT", "a"], ["UPDATE", "w"], ["DELETE", "d"], ["TRUNCATE", "D"]]) if (await t(table, p)) s += a;
    out[table] = s || "-";
  }
  const [seq] = await owner.$queryRawUnsafe<{ u: boolean }[]>(`SELECT has_sequence_privilege($1, 'public."BusinessFeatureAccess_id_seq"', 'USAGE') AS u`, role);
  out["BusinessFeatureAccess_id_seq USAGE"] = seq.u ? "yes" : "no";
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const phase = arg("--phase");
  const allowHost = arg("--allow-host") ?? null;
  if (phase !== "verify" && phase !== "proof") { console.error("usage: --phase verify|proof --allow-host <host>"); process.exit(2); }
  let owner: PrismaClient | undefined, runtime: PrismaClient | undefined, ctl: PrismaClient | undefined;
  try {
    owner = new PrismaClient({ datasourceUrl: assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost) });
    runtime = new PrismaClient({ datasourceUrl: assertSafeUrl("RUNTIME_DATABASE_URL", process.env.RUNTIME_DATABASE_URL, allowHost) });
    await enforceReadOnly(owner, "owner");
    const rt = await verifyRuntimeIdentity(runtime, "app_runtime_prod");
    const failures: string[] = [];
    const n = async (sql: string, ...p: unknown[]) => Number((await owner!.$queryRawUnsafe<{ n: number }[]>(sql, ...p))[0].n);

    if (phase === "verify") {
      ctl = new PrismaClient({ datasourceUrl: assertSafeUrl("CONTROL_PLANE_DATABASE_URL", process.env.CONTROL_PLANE_DATABASE_URL, allowHost) });

      // CATALOG
      const catalog = {
        app_ctlplane_prod: await privileges(owner, "app_ctlplane_prod"),
        app_runtime_prod: await privileges(owner, "app_runtime_prod"),
        app_admin: await privileges(owner, "app_admin"),
      };
      const members = (await owner.$queryRawUnsafe<{ m: string }[]>(
        `SELECT m.rolname::text AS m FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE g.rolname = 'app_ctlplane' ORDER BY 1`)).map((r) => r.m);
      const adminLoginMembers = await n(`SELECT count(*)::int AS n FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
        WHERE g.rolname = 'app_admin' AND m.rolcanlogin AND m.rolname <> 'neondb_owner'`);
      const want = {
        app_ctlplane_prod: { BusinessFeatureAccess: "ra", PlatformFeaturePolicy: "r", PlatformFeatureDefinition: "-", PlatformAuditEvent: "a", Business: "-", "BusinessFeatureAccess_id_seq USAGE": "yes" },
        app_runtime_prod: { BusinessFeatureAccess: "r", PlatformFeaturePolicy: "r", PlatformFeatureDefinition: "r", PlatformAuditEvent: "ra", Business: "-", "BusinessFeatureAccess_id_seq USAGE": "no" },
        app_admin: { BusinessFeatureAccess: "-", PlatformFeaturePolicy: "-", PlatformFeatureDefinition: "-", PlatformAuditEvent: "-", Business: "-", "BusinessFeatureAccess_id_seq USAGE": "no" },
      } as const;
      // Table-level UPDATE on BFA is column-scoped for the control plane (has_table_privilege reports it false); checked below.
      for (const role of Object.keys(want) as (keyof typeof want)[]) {
        for (const [k, v] of Object.entries(want[role])) if ((catalog[role] as Record<string, string>)[k] !== v) failures.push(`catalog ${role}.${k}=${(catalog[role] as Record<string, string>)[k]} want ${v}`);
      }
      const [cols] = await owner.$queryRawUnsafe<Record<string, boolean>[]>(
        `SELECT has_column_privilege('app_ctlplane_prod', 'public."BusinessFeatureAccess"', 'state', 'UPDATE') AS "updState",
                has_column_privilege('app_ctlplane_prod', 'public."BusinessFeatureAccess"', 'featureKey', 'UPDATE') AS "updFeatureKey",
                has_column_privilege('app_ctlplane_prod', 'public."BusinessFeatureAccess"', 'businessId', 'UPDATE') AS "updBusinessId",
                has_column_privilege('app_ctlplane_prod', 'public."Business"', 'name', 'SELECT') AS "selBusinessName",
                has_column_privilege('app_ctlplane_prod', 'public."Business"', 'deletedAt', 'SELECT') AS "selBusinessDeletedAt"`);
      if (!cols.updState || cols.updFeatureKey || cols.updBusinessId || !cols.selBusinessName || cols.selBusinessDeletedAt) failures.push("catalog: column privileges not as designed");
      if (JSON.stringify(members) !== JSON.stringify(["app_ctlplane_prod", "neondb_owner"])) failures.push(`catalog: app_ctlplane members ${members.join(",")}`);
      if (adminLoginMembers !== 0) failures.push("catalog: app_admin has a LOGIN member");
      const beforeRows = await n(`SELECT count(*)::int AS n FROM "BusinessFeatureAccess"`);
      const beforeAudit = await n(`SELECT count(*)::int AS n FROM "PlatformAuditEvent"`);

      // IDENTITY
      const [who] = await ctl.$queryRawUnsafe<{ u: string; s: boolean; b: boolean; m: boolean; d: string }[]>(
        `SELECT current_database() AS d, current_user AS u, r.rolsuper AS s, r.rolbypassrls AS b, pg_has_role(current_user, 'app_ctlplane', 'MEMBER') AS m FROM pg_roles r WHERE r.rolname = current_user`);
      const [ownerDb] = await owner.$queryRawUnsafe<{ d: string }[]>(`SELECT current_database() AS d`);
      if (who.u !== "app_ctlplane_prod" || who.s || who.b || !who.m) failures.push("identity: control-plane login is not the designed role");
      if (who.d !== ownerDb.d) failures.push("identity: control-plane session is not on the owner database");

      // POSITIVE — the service's exact calls, then a deliberate rollback.
      const steps: Record<string, number | string | boolean | null> = {};
      try {
        await ctl.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.current_business_id', ${String(QA)}, true)`;
          const biz = await tx.business.findFirst({ where: { id: QA, name: { not: SYSTEM_BUSINESS } }, select: { id: true, name: true } });
          steps.targetFound = biz?.id === QA;
          const cur = await tx.businessFeatureAccess.findUnique({ where: { businessId_featureKey: { businessId: QA, featureKey: FEATURE } }, select: { state: true } });
          steps.stateBefore = cur?.state ?? "none";
          steps.updateWhenAbsent = (await tx.businessFeatureAccess.updateMany({ where: { businessId: QA, featureKey: FEATURE }, data: { state: "DISABLED", reason: "control-plane probe (rolled back)", updatedByUserId: ADMIN_USER } })).count;
          steps.insert = (await tx.businessFeatureAccess.createMany({ data: [{ businessId: QA, featureKey: FEATURE, state: "DISABLED", reason: "control-plane probe (rolled back)", updatedByUserId: ADMIN_USER }] })).count;
          steps.updateWhenPresent = (await tx.businessFeatureAccess.updateMany({ where: { businessId: QA, featureKey: FEATURE }, data: { state: "INHERIT", reason: "control-plane probe (rolled back)", updatedByUserId: ADMIN_USER } })).count;
          const pol = await tx.platformFeaturePolicy.findUnique({ where: { featureKey: FEATURE }, select: { globalEnabled: true, emergencyDisabled: true } });
          steps.policyReadable = pol !== null;
          steps.stateAfter = (await tx.businessFeatureAccess.findUnique({ where: { businessId_featureKey: { businessId: QA, featureKey: FEATURE } }, select: { state: true } }))?.state ?? "none";
          steps.auditAppend = (await tx.platformAuditEvent.createMany({ data: { actorUserId: ADMIN_USER, action: PROBE_ACTION, targetType: "BUSINESS", targetId: String(QA), metadata: { probe: true } } })).count;
          throw new Rollback();
        }, { timeout: 20_000 });
      } catch (e) {
        steps.rolledBack = e instanceof Rollback;
        if (!(e instanceof Rollback)) steps.error = codeOf(e);
      }
      const positiveOk = steps.targetFound === true && steps.updateWhenAbsent === 0 && steps.insert === 1 && steps.updateWhenPresent === 1 &&
        steps.policyReadable === true && steps.stateAfter === "INHERIT" && steps.auditAppend === 1 && steps.rolledBack === true;
      if (!positiveOk) failures.push("positive: the control-plane path did not complete as designed");

      // NEGATIVE — control plane
      const ctlAttempts = [
        await attempt(ctl, "ctl INSERT foreign business (GUC=38, row=39)", "deny", `INSERT INTO "BusinessFeatureAccess" ("businessId","featureKey","state","updatedAt") VALUES (39,'${FEATURE}','DISABLED',now())`, QA),
        await attempt(ctl, "ctl INSERT with no tenant GUC", "deny", `INSERT INTO "BusinessFeatureAccess" ("businessId","featureKey","state","updatedAt") VALUES (${QA},'${FEATURE}','DISABLED',now())`, null),
        await attempt(ctl, "ctl DELETE override", "deny", `DELETE FROM "BusinessFeatureAccess" WHERE "businessId" = ${QA}`, QA),
        await attempt(ctl, "ctl UPDATE featureKey", "deny", `UPDATE "BusinessFeatureAccess" SET "featureKey" = 'billing' WHERE false`, QA),
        await attempt(ctl, "ctl UPDATE businessId", "deny", `UPDATE "BusinessFeatureAccess" SET "businessId" = 39 WHERE false`, QA),
        await attempt(ctl, "ctl SELECT audit trail", "deny", `SELECT count(*) FROM "PlatformAuditEvent"`, null),
        await attempt(ctl, "ctl UPDATE audit trail", "deny", `UPDATE "PlatformAuditEvent" SET action = action WHERE false`, null),
        await attempt(ctl, "ctl DELETE audit trail", "deny", `DELETE FROM "PlatformAuditEvent" WHERE false`, null),
        await attempt(ctl, "ctl SELECT Business.deletedAt", "deny", `SELECT "deletedAt" FROM "Business" LIMIT 1`, null),
        await attempt(ctl, "ctl UPDATE feature policy", "deny", `UPDATE "PlatformFeaturePolicy" SET "globalEnabled" = "globalEnabled" WHERE false`, null),
        await attempt(ctl, "ctl INSERT feature definition", "deny", `INSERT INTO "PlatformFeatureDefinition" (key) VALUES ('__probe__')`, null),
        await attempt(ctl, "ctl SELECT a tenant table", "deny", `SELECT 1 FROM "KnowledgeMeasure" LIMIT 1`, QA),
        await attempt(ctl, "ctl SELECT User", "deny", `SELECT 1 FROM "User" LIMIT 1`, null),
        await attempt(ctl, "ctl CREATE TABLE", "deny", `CREATE TABLE ctl_probe_denied (x int)`, null),
        await attempt(ctl, "ctl SET ROLE app_runtime", "deny", `SET LOCAL ROLE app_runtime`, null),
      ];
      // NEGATIVE + REGRESSION — tenant runtime
      const rtAttempts = [
        await attempt(runtime, "runtime INSERT override", "deny", `INSERT INTO "BusinessFeatureAccess" ("businessId","featureKey","state","updatedAt") VALUES (${QA},'${FEATURE}','ENABLED',now())`, QA),
        await attempt(runtime, "runtime UPDATE override", "deny", `UPDATE "BusinessFeatureAccess" SET state = 'ENABLED' WHERE false`, QA),
        await attempt(runtime, "runtime DELETE override", "deny", `DELETE FROM "BusinessFeatureAccess" WHERE false`, QA),
        await attempt(runtime, "runtime UPDATE feature policy (global enable)", "deny", `UPDATE "PlatformFeaturePolicy" SET "globalEnabled" = true WHERE false`, null),
        await attempt(runtime, "runtime INSERT feature definition", "deny", `INSERT INTO "PlatformFeatureDefinition" (key) VALUES ('__probe__')`, null),
        await attempt(runtime, "runtime UPDATE audit trail", "deny", `UPDATE "PlatformAuditEvent" SET action = action WHERE false`, null),
        await attempt(runtime, "runtime DELETE audit trail", "deny", `DELETE FROM "PlatformAuditEvent" WHERE false`, null),
        await attempt(runtime, "runtime SET ROLE app_ctlplane", "deny", `SET LOCAL ROLE app_ctlplane`, null),
        await attempt(runtime, "runtime reads own overrides (regression)", "allow", `SELECT count(*) FROM "BusinessFeatureAccess"`, QA),
        await attempt(runtime, "runtime reads feature policy (regression)", "allow", `SELECT count(*) FROM "PlatformFeaturePolicy"`, null),
        await attempt(runtime, "runtime reads feature definitions (regression)", "allow", `SELECT count(*) FROM "PlatformFeatureDefinition"`, null),
        await attempt(runtime, "runtime appends admin audit (regression, rolled back)", "allow", `INSERT INTO "PlatformAuditEvent" (action) VALUES ('${PROBE_ACTION}')`, null),
        await attempt(runtime, "runtime reads admin audit (regression)", "allow", `SELECT count(*) FROM "PlatformAuditEvent" WHERE false`, null),
      ];
      for (const a of [...ctlAttempts, ...rtAttempts]) if (!a.ok) failures.push(`attempt: ${a.name} → ${a.got} (expected ${a.expect})`);

      // AFTER — nothing persisted.
      const afterRows = await n(`SELECT count(*)::int AS n FROM "BusinessFeatureAccess"`);
      const afterAudit = await n(`SELECT count(*)::int AS n FROM "PlatformAuditEvent"`);
      const probeRows = await n(`SELECT count(*)::int AS n FROM "PlatformAuditEvent" WHERE action = $1`, PROBE_ACTION);
      const qaRows = await n(`SELECT count(*)::int AS n FROM "BusinessFeatureAccess" WHERE "businessId" = $1`, QA);
      // The audit may legitimately grow from real admin browsing during the run; the probe rows must not exist.
      if (afterRows !== beforeRows || qaRows !== 0 || probeRows !== 0) failures.push("after: something persisted");
      await verifyReadOnly(owner, "owner");
      console.log(JSON.stringify({ phase, runtime: rt, controlPlane: who, catalog, columnPrivileges: cols, controlPlaneMembers: members, adminLoginMembers,
        positive: steps, controlPlaneAttempts: ctlAttempts, runtimeAttempts: rtAttempts,
        persisted: { overridesBefore: beforeRows, overridesAfter: afterRows, qaOverrides: qaRows, probeAuditRows: probeRows, auditDelta: afterAudit - beforeAudit },
        failures, pass: failures.length === 0 }, null, 1));
      process.exitCode = failures.length === 0 ? 0 : 1;
      return;
    }

    // ---- proof ----
    const rows = await owner.$queryRawUnsafe<{ b: number; f: string; s: string; by: number | null }[]>(
      `SELECT "businessId" AS b, "featureKey" AS f, state::text AS s, "updatedByUserId" AS by FROM "BusinessFeatureAccess" ORDER BY id`);
    const events = await owner.$queryRawUnsafe<{ actor: number | null; target: string | null; meta: Record<string, unknown> | null; at: Date }[]>(
      `SELECT "actorUserId" AS actor, "targetId" AS target, metadata AS meta, "createdAt" AS at FROM "PlatformAuditEvent"
        WHERE action = 'PLATFORM_FEATURE_ACCESS_UPDATED' ORDER BY id`);
    const [policy] = await owner.$queryRawUnsafe<{ d: boolean; g: boolean; e: boolean }[]>(
      `SELECT d."defaultEnabled" AS d, p."globalEnabled" AS g, p."emergencyDisabled" AS e FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d.key WHERE d.key = $1`, FEATURE);
    const [mfa] = await owner.$queryRawUnsafe<{ v: Date | null }[]>(`SELECT "lastVerifiedAt" AS v FROM "PlatformAdminMfa" WHERE "userId" = $1`, ADMIN_USER);
    const seen = async (b: number) => runtime!.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
      return Number((await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "BusinessFeatureAccess"`))[0].n);
    });
    const visible = { [QA]: await seen(QA), 3: await seen(3), 9: await seen(9) };
    const noContext = Number((await runtime.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "BusinessFeatureAccess"`))[0].n);
    const transitions = events.map((e) => ({ actor: e.actor, target: e.target, feature: e.meta?.featureKey, from: e.meta?.oldState, to: e.meta?.newState,
      effectiveAfter: e.meta?.effectiveAllowedAfter, affectedRows: e.meta?.affectedRows, at: e.at }));
    const wantT = [["INHERIT", "DISABLED"], ["DISABLED", "INHERIT"]];
    if (rows.length !== 1 || rows[0].b !== QA || rows[0].f !== FEATURE || rows[0].s !== "INHERIT" || rows[0].by !== ADMIN_USER) failures.push("proof: override table is not exactly the one QA row");
    if (transitions.length !== 2 || transitions.some((t, i) => t.actor !== ADMIN_USER || t.target !== String(QA) || t.feature !== FEATURE ||
        t.from !== wantT[i][0] || t.to !== wantT[i][1] || t.effectiveAfter !== false || t.affectedRows !== 1)) failures.push("proof: audit events are not exactly the two expected transitions");
    if (!policy || policy.d || policy.g || policy.e) failures.push("proof: feature policy changed");
    if (visible[QA] !== 1 || visible[3] !== 0 || visible[9] !== 0 || noContext !== 0) failures.push("proof: runtime tenant visibility not as expected");
    await verifyReadOnly(owner, "owner");
    console.log(JSON.stringify({ phase, runtime: rt, overrides: rows, transitions, policy, adminMfaLastVerifiedAt: mfa?.v ?? null,
      runtimeVisibleOverrides: { byTenant: visible, noContext }, failures, pass: failures.length === 0 }, null, 1));
    process.exitCode = failures.length === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${e.message}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? e.name : "unknown"} ${codeOf(e)}`); process.exitCode = 1; }
  } finally {
    await owner?.$disconnect(); await runtime?.$disconnect(); await ctl?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/control-plane-evidence.ts")) void main();
