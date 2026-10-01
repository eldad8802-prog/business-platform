/**
 * PR #594 — functional privilege battery on the Production-topology lab
 * (.c594/lab.sh, #594 applied by `prisma migrate deploy`).
 *
 * It proves the privilege model by USING it, through the real application code
 * where it exists, as three distinct identities:
 *   owner    lab_owner        (the migration role; fixtures only)
 *   runtime  app_runtime_prod (LOGIN member of the NOLOGIN group app_runtime)
 *   ctl      app_ctlplane_lab (LOGIN member of app_ctlplane — what the separately
 *                              gated login provisioning would create)
 *
 *   1. the REAL control-plane write path (updateBusinessFeatureAccess) succeeds
 *      with exactly #594's grants: DISABLED, then INHERIT, audit appended;
 *   2. the REAL runtime paths still work: feature resolution (SELECT), admin
 *      audit append (createMany → INS only), its own-tenant reads;
 *   3. every write #594 removes from the runtime is now refused, and every
 *      authority the control plane must NOT have is refused (DEL, key rewrites,
 *      foreign tenant, no tenant context, audit read / rewrite, catalog writes,
 *      DDL, role escalation, other Business columns);
 *   4. RLS still pins both identities to the transaction's tenant;
 *   5. deleting a User referenced by the admin audit still works for the runtime
 *      (the FK's SET NULL runs as the table owner — no UPD needed).
 *
 * env: OWNER_URL, RUNTIME_URL, CTL_URL. Synthetic only. ZERO network.
 */
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.OWNER_URL!;
const RUNTIME_URL = process.env.RUNTIME_URL!;
const CTL_URL = process.env.CTL_URL!;
// The application reads these at first use.
process.env.DATABASE_URL = RUNTIME_URL;
process.env.DIRECT_URL = RUNTIME_URL;
process.env.CONTROL_PLANE_DATABASE_URL = CTL_URL;

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
async function outcome(fn: () => Promise<unknown>): Promise<"ok" | string> {
  try { await fn(); return "ok"; } catch (e) {
    const err = e as { code?: string; meta?: { code?: string }; message?: string };
    return `${err.meta?.code ?? err.code ?? ""} ${(err.message ?? "").split("\n").pop()}`.trim();
  }
}
const denied = (r: string) => r !== "ok" && /permission denied|42501|row-level security|violates row-level/i.test(r);

const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
const runtime = new PrismaClient({ datasourceUrl: RUNTIME_URL });
const ctl = new PrismaClient({ datasourceUrl: CTL_URL });

/** Run SQL as a client inside a transaction with the tenant GUC set (or not). */
async function as(client: PrismaClient, businessId: number | null, sql: string) {
  return client.$transaction(async (tx) => {
    if (businessId !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${businessId}', true)`);
    return tx.$queryRawUnsafe(sql);
  });
}

async function main() {
  const who = async (c: PrismaClient) =>
    ((await c.$queryRawUnsafe(`SELECT current_user::text AS u, rolsuper s, rolbypassrls b FROM pg_roles WHERE rolname = current_user`)) as Array<{ u: string; s: boolean; b: boolean }>)[0];
  const rt = await who(runtime);
  const cp = await who(ctl);
  console.log(`  runtime=${rt.u} ctl=${cp.u}`);
  ok("identities cannot bypass RLS (NOSUPERUSER, NOBYPASSRLS)", !rt.s && !rt.b && !cp.s && !cp.b);

  // ── fixtures (owner) ────────────────────────────────────────────────────────
  const tag = `c594-${Date.now()}`;
  const A = await owner.business.create({ data: { name: `${tag}-A` } });
  const B = await owner.business.create({ data: { name: `${tag}-B` } });
  const admin = await owner.user.create({ data: { email: `${tag}-admin@lab.test`, password: "x", businessId: A.id, role: "USER" } });
  const doomed = await owner.user.create({ data: { email: `${tag}-doomed@lab.test`, password: "x", businessId: A.id, role: "USER" } });
  await owner.businessFeatureAccess.create({ data: { businessId: B.id, featureKey: "knowledge_derivation", state: "DISABLED", reason: "B override (fixture)", updatedByUserId: admin.id } });

  // ── 1. the REAL control-plane write path ─────────────────────────────────────
  console.log("\n-- control plane: the real service, exactly #594's grants --");
  const { updateBusinessFeatureAccess } = await import("../lib/services/platform-admin/update-business-feature-access.service");
  const r1 = await outcome(() => updateBusinessFeatureAccess({ actorUserId: admin.id, businessId: A.id, featureKey: "knowledge_derivation", state: "DISABLED", reason: "c594 lab mechanism proof" }));
  const rowA = await owner.businessFeatureAccess.findFirst({ where: { businessId: A.id, featureKey: "knowledge_derivation" } });
  ok("updateBusinessFeatureAccess → DISABLED succeeds as the control plane (INS + column-scoped UPD + audit INS)", r1 === "ok" && rowA?.state === "DISABLED", r1);
  const r2 = await outcome(() => updateBusinessFeatureAccess({ actorUserId: admin.id, businessId: A.id, featureKey: "knowledge_derivation", state: "INHERIT", reason: "c594 lab mechanism proof back" }));
  const rowA2 = await owner.businessFeatureAccess.findFirst({ where: { businessId: A.id, featureKey: "knowledge_derivation" } });
  ok("… then → INHERIT succeeds (an UPD of the four allowed columns)", r2 === "ok" && rowA2?.state === "INHERIT", r2);
  const audits = await owner.platformAuditEvent.count({ where: { targetId: String(A.id) } });
  ok("… and both changes appended an admin audit row", audits >= 2, String(audits));

  // ── 2. what the control plane must NOT be able to do ──────────────────────────
  console.log("\n-- control plane: refused authority --");
  const ctlDeny: Array<[string, number | null, string]> = [
    ["DEL an override", A.id, `DELETE FROM "BusinessFeatureAccess" WHERE "businessId" = ${A.id}`],
    ["rewrite businessId", A.id, `UPDATE "BusinessFeatureAccess" SET "businessId" = ${B.id} WHERE "businessId" = ${A.id}`],
    ["rewrite featureKey", A.id, `UPDATE "BusinessFeatureAccess" SET "featureKey" = 'billing' WHERE "businessId" = ${A.id}`],
    ["INS for a foreign tenant (GUC = A, row = B)", A.id, `INSERT INTO "BusinessFeatureAccess" ("businessId","featureKey","state","updatedAt") VALUES (${B.id},'billing','DISABLED',now())`],
    ["INS with no tenant context", null, `INSERT INTO "BusinessFeatureAccess" ("businessId","featureKey","state","updatedAt") VALUES (${A.id},'billing','DISABLED',now())`],
    ["read the admin audit", null, `SELECT count(*)::int FROM "PlatformAuditEvent"`],
    ["rewrite the admin audit", null, `UPDATE "PlatformAuditEvent" SET action = action`],
    ["flip a global feature policy", null, `UPDATE "PlatformFeaturePolicy" SET "emergencyDisabled" = "emergencyDisabled"`],
    ["add a feature definition", null, `INSERT INTO "PlatformFeatureDefinition" (key, "displayName", category) VALUES ('__c594__','x','x')`],
    ["read a non-granted Business column", null, `SELECT "createdAt" FROM "Business" LIMIT 1`],
    ["DDL in schema public", null, `CREATE TABLE c594_probe (id int)`],
    ["assume the runtime role", null, `SET ROLE app_runtime`],
    ["assume the owner role", null, `SET ROLE lab_owner`],
    ["truncate overrides", A.id, `TRUNCATE "BusinessFeatureAccess"`],
  ];
  for (const [name, biz, sql] of ctlDeny) {
    const r = await outcome(() => as(ctl, biz, sql));
    ok(`ctl: ${name} → refused`, denied(r), r);
  }
  const ctlUpdForeign = await outcome(() => as(ctl, A.id, `UPDATE "BusinessFeatureAccess" SET reason = 'x' WHERE "businessId" = ${B.id}`));
  const bRow = await owner.businessFeatureAccess.findFirst({ where: { businessId: B.id } });
  ok("ctl: UPD of a foreign tenant's override (GUC = A) touches nothing (RLS)", ctlUpdForeign === "ok" && bRow?.reason === "B override (fixture)", ctlUpdForeign);
  const ctlSeeB = (await as(ctl, A.id, `SELECT count(*)::int AS n FROM "BusinessFeatureAccess" WHERE "businessId" = ${B.id}`)) as Array<{ n: number }>;
  ok("ctl: cannot read a foreign tenant's override (RLS)", ctlSeeB[0].n === 0);
  const ctlNames = (await as(ctl, null, `SELECT count(*)::int AS n FROM "Business" WHERE id IN (${A.id}, ${B.id})`)) as Array<{ n: number }>;
  ok("ctl: reads Business (id, name) — the target check (Business has no RLS: names of every business are readable to this role)", ctlNames[0].n === 2);

  // ── 3. the runtime after #594 ────────────────────────────────────────────────
  console.log("\n-- runtime: what still works --");
  const { runWithTenantContext } = await import("../lib/tenant/context");
  const { resolveFeatureAccess } = await import("../lib/services/feature-access/resolve-feature-access");
  const res = await outcome(() => runWithTenantContext({ businessId: B.id }, () => resolveFeatureAccess(B.id, "knowledge_derivation")));
  const resolved = res === "ok" ? await runWithTenantContext({ businessId: B.id }, () => resolveFeatureAccess(B.id, "knowledge_derivation")) : null;
  ok("runtime: feature resolution (SELECT on the three feature tables) still works and honours B's override", res === "ok" && (resolved as { allowed?: boolean } | null)?.allowed === false &&
      (resolved as { businessOverride?: string } | null)?.businessOverride === "DISABLED", `${res} ${JSON.stringify(resolved)}`);
  const { logPlatformAuditEvent, createPlatformAuditEventTx } = await import("../lib/services/platform-admin/platform-audit.service");
  const before = await owner.platformAuditEvent.count();
  const appendR = await outcome(() => createPlatformAuditEventTx(runtime, { actorUserId: admin.id, action: "C594_LAB_PROBE", targetType: "BUSINESS", targetId: String(A.id) }));
  await logPlatformAuditEvent({ actorUserId: admin.id, action: "C594_LAB_PROBE_2", targetType: "BUSINESS", targetId: String(A.id) });
  ok("runtime: the admin audit append (createMany → INS only) still works", appendR === "ok" && (await owner.platformAuditEvent.count()) === before + 2, appendR);
  const rtOwn = (await as(runtime, B.id, `SELECT count(*)::int AS n FROM "BusinessFeatureAccess"`)) as Array<{ n: number }>;
  const rtNone = (await as(runtime, null, `SELECT count(*)::int AS n FROM "BusinessFeatureAccess"`)) as Array<{ n: number }>;
  const rtCross = (await as(runtime, A.id, `SELECT count(*)::int AS n FROM "BusinessFeatureAccess" WHERE "businessId" = ${B.id}`)) as Array<{ n: number }>;
  ok("runtime: reads its own tenant's override; none without a tenant; none of another tenant (FORCE RLS intact)",
    rtOwn[0].n === 1 && rtNone[0].n === 0 && rtCross[0].n === 0, JSON.stringify([rtOwn[0].n, rtNone[0].n, rtCross[0].n]));

  console.log("\n-- runtime: what #594 takes away --");
  const policySnapshot = JSON.stringify(await owner.platformFeaturePolicy.findMany({ orderBy: { featureKey: "asc" } }));
  const overrideSnapshot = JSON.stringify(await owner.businessFeatureAccess.findMany({ orderBy: { id: "asc" } }));
  const rtDeny: Array<[string, number | null, string]> = [
    ["INS an override (would bypass the audited control plane)", B.id, `INSERT INTO "BusinessFeatureAccess" ("businessId","featureKey","state","updatedAt") VALUES (${B.id},'billing','ENABLED',now())`],
    ["UPD an override", B.id, `UPDATE "BusinessFeatureAccess" SET state = 'ENABLED'`],
    ["DEL an override", B.id, `DELETE FROM "BusinessFeatureAccess"`],
    ["flip a global feature policy (no RLS on that table)", null, `UPDATE "PlatformFeaturePolicy" SET "globalEnabled" = true`],
    ["add a feature definition", null, `INSERT INTO "PlatformFeatureDefinition" (key, "displayName", category) VALUES ('__c594_rt__','x','x')`],
    ["rewrite the admin audit", null, `UPDATE "PlatformAuditEvent" SET action = 'x'`],
    ["delete the admin audit", null, `DELETE FROM "PlatformAuditEvent"`],
    ["draw from the override id sequence", null, `SELECT nextval('"BusinessFeatureAccess_id_seq"')`],
  ];
  for (const [name, biz, sql] of rtDeny) {
    const r = await outcome(() => as(runtime, biz, sql));
    ok(`runtime: ${name} → refused`, denied(r), r);
  }
  ok("runtime: global feature policies and overrides are byte-identical after the refused attempts",
    JSON.stringify(await owner.platformFeaturePolicy.findMany({ orderBy: { featureKey: "asc" } })) === policySnapshot &&
      JSON.stringify(await owner.businessFeatureAccess.findMany({ orderBy: { id: "asc" } })) === overrideSnapshot);

  // ── 4. erasure-shaped delete: FK SET NULL needs no UPD for the caller ────────
  console.log("\n-- account deletion shape --");
  await createPlatformAuditEventTx(owner, { actorUserId: doomed.id, action: "C594_DOOMED", targetType: "USER", targetId: String(doomed.id) });
  const del = await outcome(() => as(runtime, null, `DELETE FROM "User" WHERE id = ${doomed.id}`));
  const nulled = await owner.platformAuditEvent.count({ where: { action: "C594_DOOMED", targetId: String(doomed.id), actorUserId: null } });
  ok("runtime deletes a User referenced by the admin audit → the FK's SET NULL runs as the owner (no UPD privilege needed)",
    del === "ok" && nulled === 1, del);

  console.log(`\n[c594] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { console.log("FAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
  console.log("ALL CHECKS PASS");
  await Promise.all([owner.$disconnect(), runtime.$disconnect(), ctl.$disconnect()]);
}

main().catch((e) => { console.error("battery crashed:", e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : e); process.exit(1); });
