/**
 * Account-recovery local E2E lab (adapted from .open-signup/setup-lab.ts; + migration 20261017090000 verbatim). Mirrors .authfix/auth-plane-write-battery.ts's lab block (the CI
 * auth-plane-write workflow): schema via `db push`, then the SHIPPED E4 / session contract /
 * user-agent / sec_c / B4 / M1 / TE migrations verbatim, LOGIN members of app_auth and app_runtime.
 * Additionally the runtime gets table-level DML on the db-push estate BEFORE E4 runs (E4 then narrows
 * User/Business exactly as shipped), so the app can serve /setup and /app on the tenant plane.
 *
 *   OWNER_URL=postgresql://authfix_owner:...@127.0.0.1:55507/open_signup_e2e npx tsx .open-signup/setup-lab.ts
 * Synthetic only. Local only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.OWNER_URL!;
if (!OWNER_URL || !/127\.0\.0\.1|localhost/.test(OWNER_URL)) throw new Error("local OWNER_URL required");
const ROOT = join(__dirname, "..");
const MIG = (n: string) => join(ROOT, "prisma/migrations", n, "migration.sql");

function dollarTagAt(src: string, i: number): string | null {
  if (src[i] !== "$") return null;
  let j = i + 1;
  while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
  if (src[j] !== "$") return null;
  return src.slice(i, j + 1);
}
function statements(sql: string): string[] {
  const src = sql.replace(/--.*$/gm, "");
  const out: string[] = [];
  let buf = "";
  let i = 0;
  while (i < src.length) {
    const tag = dollarTagAt(src, i);
    if (tag !== null) {
      const close = src.indexOf(tag, i + tag.length);
      const end = close === -1 ? src.length : close + tag.length;
      buf += src.slice(i, end);
      i = end;
      continue;
    }
    if (src[i] === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      i++;
      continue;
    }
    buf += src[i];
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL, log: ["error"] });
  // db push modelled AuthEmailToken / User.emailVerifiedAt without the migration: remove them first.
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "AuthEmailToken" CASCADE`);
  await owner.$executeRawUnsafe(`ALTER TABLE "User" DROP COLUMN IF EXISTS "emailVerifiedAt"`);
  for (const sql of [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_auth') THEN CREATE ROLE app_auth NOLOGIN; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime NOLOGIN; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aete2e_auth_login') THEN CREATE ROLE aete2e_auth_login LOGIN PASSWORD 'aete2e_synthetic_auth_pw' IN ROLE app_auth; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='aete2e_runtime_login') THEN CREATE ROLE aete2e_runtime_login LOGIN PASSWORD 'aete2e_synthetic_runtime_pw' IN ROLE app_runtime; END IF; END $$`,
    `GRANT USAGE ON SCHEMA public TO app_auth`,
    `GRANT USAGE ON SCHEMA public TO app_runtime`,
    // Runtime: DML on the whole db-push estate (Production's runtime holds DML on tenant tables);
    // E4 below then revokes / narrows User + Business exactly as shipped.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."User", public."Business" TO app_auth`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_auth`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."AuthSession", public."AuthSessionSecret" TO app_auth`,
  ]) {
    await owner.$executeRawUnsafe(sql);
  }
  for (const f of [
    "20260908180000_d2_user_business_privilege_narrowing",
    "20260908200000_auth_session_privilege_contract",
    "20260913120000_authsession_user_agent",
  ]) {
    for (const s of statements(readFileSync(MIG(f), "utf8"))) await owner.$executeRawUnsafe(s);
  }
  for (const sql of [
    `ALTER TABLE "BusinessProfile" DROP COLUMN IF EXISTS "onboardingCompletedAt", DROP COLUMN IF EXISTS "onboardingGoal", DROP COLUMN IF EXISTS "onboardingGoalSource"`,
    `ALTER TABLE "User" DROP COLUMN IF EXISTS "termsAcceptedAt", DROP COLUMN IF EXISTS "termsVersion", DROP COLUMN IF EXISTS "signupAttribution"`,
  ]) {
    await owner.$executeRawUnsafe(sql);
  }
  for (const f of [
    "20260926110300_sec_c_explicit_identity_grants",
    "20261006090000_business_tenant_write_rls",
    "20261011090000_onboarding_setup_state",
    "20261011090100_signup_consent_business_rename",
    "20261011090200_user_email_casefold_unique",
  ]) {
    for (const s of statements(readFileSync(MIG(f), "utf8"))) await owner.$executeRawUnsafe(s);
  }
  // TransactionalEmail + auth email tokens are applied verbatim with psql -f by lab.sh (after this script).
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "TransactionalEmail" CASCADE`);
  // M1 re-added BusinessProfile columns; make sure the runtime can use them (column adds inherit table grants).
  const rls = await owner.$queryRawUnsafe<Array<{ relname: string; r: boolean; f: boolean }>>(
    `SELECT relname, relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('Business','TransactionalEmail') ORDER BY 1`
  );
  console.log("RLS:", JSON.stringify(rls));
  console.log("LAB READY");
  await owner.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
