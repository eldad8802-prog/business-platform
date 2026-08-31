/**
 * D2 / PRIVILEGED-WRITE-2 — PG17 lab provisioning (owner step).
 *
 * Creates ONLY what the ephemeral lab cannot inherit from the repo:
 *   - the env-neutral `app_admin` NOLOGIN group (created on real environments by
 *     the W2-GATE canonical migration, which `prisma db push` does not run);
 *   - three LOGIN roles that stand in for the three real credentials
 *     (tenant runtime / admin read / control plane);
 *   - the platform feature catalog + policy rows, which the foundation
 *     migration seeds and `db push` does not.
 *
 * It deliberately does NOT apply the PW-2 migration or grants — the battery
 * does that, so that apply → prove → rollback → re-apply is one auditable
 * sequence inside a single run.
 *
 * ZERO secrets, ZERO Neon, ZERO network. Synthetic CI-only credentials.
 * Never run against Preview or Production: the endpoint deny-list aborts.
 */
import { PrismaClient } from "@prisma/client";
import {
  CTL_PW,
  CTL_ROLE,
  ADMIN_PW,
  ADMIN_ROLE,
  RT_PW,
  RT_ROLE,
  assertEndpointSafety,
  FEATURE_KEYS,
} from "./shared.mjs";

async function main() {
  const OWNER_URL = process.env.DIRECT_URL;
  if (!OWNER_URL) throw new Error("DIRECT_URL missing");
  assertEndpointSafety(OWNER_URL, "DIRECT_URL");

  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  await owner.$queryRaw`SELECT 1`;

  const roleExists = async (name) =>
    Number(
      (
        await owner.$queryRawUnsafe(
          `SELECT count(*)::int AS c FROM pg_roles WHERE rolname='${name}'`
        )
      )[0].c
    ) > 0;

  // 1. Env-neutral admin group (mirrors the W2-GATE canonical migration).
  if (!(await roleExists("app_admin"))) {
    await owner.$executeRawUnsafe(
      `CREATE ROLE app_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`
    );
  }

  // 2. The three lab LOGIN roles. Create-once; never dropped/recreated.
  const logins = [
    [RT_ROLE, RT_PW],
    [ADMIN_ROLE, ADMIN_PW],
    [CTL_ROLE, CTL_PW],
  ];
  for (const [role, pw] of logins) {
    if (!(await roleExists(role))) {
      await owner.$executeRawUnsafe(
        `CREATE ROLE ${role} LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION INHERIT`
      );
    }
  }
  await owner.$executeRawUnsafe(`GRANT app_admin TO ${ADMIN_ROLE}`);

  // 3. Schema visibility + the pre-existing (non-PW-2) grants each credential
  //    already holds on the real environments. Everything PW-2 adds comes from
  //    scripts/security/d2-pw2-grants.sql, applied by the battery.
  for (const role of [RT_ROLE, ADMIN_ROLE]) {
    await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
  }
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO app_admin`);
  await owner.$executeRawUnsafe(`GRANT SELECT ON "User", "Business" TO ${RT_ROLE}`);
  // W2-GATE starter admin set (the parts this wave interacts with).
  await owner.$executeRawUnsafe(
    `GRANT SELECT ON "User", "Business", "PlatformFeaturePolicy" TO app_admin`
  );
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT ON "PlatformAuditEvent" TO app_admin`);
  await owner.$executeRawUnsafe(
    `GRANT USAGE, SELECT ON SEQUENCE "PlatformAuditEvent_id_seq" TO app_admin`
  );

  // 4. Feature catalog + global policies (foundation-migration seed, idempotent).
  for (const key of FEATURE_KEYS) {
    await owner.$executeRawUnsafe(
      `INSERT INTO "PlatformFeatureDefinition" ("key","displayName","category","description","defaultEnabled","mutable","createdAt")
       VALUES ('${key}','${key}','${key}','',true,true,CURRENT_TIMESTAMP)
       ON CONFLICT ("key") DO NOTHING`
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO "PlatformFeaturePolicy" ("featureKey","globalEnabled","emergencyDisabled","updatedAt")
       VALUES ('${key}',true,false,CURRENT_TIMESTAMP)
       ON CONFLICT ("featureKey") DO NOTHING`
    );
  }

  // 5. A prior-wave-EQUIVALENT policy on a real neighbour table. Without it the
  //    rollback proof ("PW-2 removes only its own additions") would compare 0
  //    against 0 and prove nothing — the same lesson as installing a
  //    pilot-equivalent parent policy in earlier waves.
  await owner.$executeRawUnsafe(`ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY`);
  await owner.$executeRawUnsafe(`ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY`);
  await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS p7w1_tenant ON "Customer"`);
  await owner.$executeRawUnsafe(
    `CREATE POLICY p7w1_tenant ON "Customer"
       USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
       WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`
  );
  await owner.$executeRawUnsafe(`GRANT SELECT ON "Customer" TO ${RT_ROLE}`);

  const catalog = Number(
    (
      await owner.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM "PlatformFeatureDefinition"`
      )
    )[0].c
  );
  if (catalog < FEATURE_KEYS.length) {
    throw new Error(`catalog seed incomplete: ${catalog}/${FEATURE_KEYS.length}`);
  }

  console.log(
    `[provision] roles=${RT_ROLE},${ADMIN_ROLE},${CTL_ROLE} (+app_admin group) catalog=${catalog} OK`
  );
  await owner.$disconnect();
}

main().catch((e) => {
  console.error("[provision] FAILED:", e);
  process.exit(1);
});
