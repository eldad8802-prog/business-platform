/**
 * Platform-admin READ plane — Production proof AS the admin login (app_admin_prod), READ-ONLY.
 * Driven only by .github/workflows/prod-admin-read-evidence.yml (environment production-db, owner approval).
 *
 *   OWNER_DATABASE_URL=… ADMIN_DATABASE_URL=… node_modules/.bin/tsx scripts/ops/admin-read-evidence.ts \
 *     --allow-host ep-flat-brook-am4bhq1y
 *
 * Proves, after migration 20261024090000 and the login provisioning, BEFORE ADMIN_DATABASE_URL goes to Vercel:
 *   1. identity   the connection is exactly app_admin_prod: NOSUPERUSER, NOBYPASSRLS, member of app_admin;
 *   2. read-only  both sessions are read-only by Postgres (SET SESSION CHARACTERISTICS … READ ONLY, verified);
 *   3. reach      cross-tenant counts seen by the admin login EQUAL the owner's (row_security off) on Business,
 *                 Document, BusinessProfile and Conversation — the p7adm_read path works, nothing is zeroed;
 *   4. refusals   reading User.password, AuthSession.secretHash, Document.ocrText or PlatformAdminPasskey as the
 *                 admin login fails with 42501;
 *   5. services   the real admin services (home, business list + search + filters, business detail of the QA
 *                 tenant, attention, usage, overview, audit list) run to completion as the admin login.
 *
 * Output: booleans and check names only — never a count, a name, an email or a row. Exit 0 PASS · 1 FAIL ·
 * 3 REFUSED · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, enforceReadOnly, QA_BUSINESS_ID, RefusedError } from "./runtime-rls-evidence";

const EXPECTED_LOGIN = "app_admin_prod";

type Check = { name: string; ok: boolean };

async function denied(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    const err = e as { meta?: { code?: string }; message?: string };
    return err.meta?.code === "42501" || /42501|permission denied/i.test(err.message ?? "");
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--allow-host");
  const allowHost = i >= 0 ? argv[i + 1] : null;
  let owner: PrismaClient | undefined;
  let admin: PrismaClient | undefined;
  const checks: Check[] = [];
  try {
    const ownerUrl = assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost);
    const adminUrl = assertSafeUrl("ADMIN_DATABASE_URL", process.env.ADMIN_DATABASE_URL, allowHost);
    if (new URL(adminUrl).username !== EXPECTED_LOGIN) throw new RefusedError(`ADMIN_DATABASE_URL must authenticate as ${EXPECTED_LOGIN}`);
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    admin = new PrismaClient({ datasourceUrl: adminUrl });
    await enforceReadOnly(owner, "owner");
    await enforceReadOnly(admin, "admin");
    checks.push({ name: "2 both sessions read-only by Postgres", ok: true });

    const [id] = await admin.$queryRawUnsafe<Array<{ usr: string; sup: boolean; byp: boolean; member: boolean }>>(
      `SELECT current_user AS usr, r.rolsuper AS sup, r.rolbypassrls AS byp, pg_has_role(current_user, 'app_admin', 'MEMBER') AS member
         FROM pg_roles r WHERE r.rolname = current_user`
    );
    if (id.usr !== EXPECTED_LOGIN) throw new RefusedError(`connected as an unexpected role — refusing`);
    checks.push({ name: "1 identity is app_admin_prod, NOSUPERUSER, NOBYPASSRLS, member of app_admin", ok: !id.sup && !id.byp && id.member });

    const ownerCount = async (table: string) => {
      const rows = await owner!.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL row_security = off");
        return tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table}"`);
      });
      return rows[0].n;
    };
    const adminCount = async (table: string) =>
      (await admin!.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count("id")::int AS n FROM "${table}"`))[0].n;
    for (const t of ["Business", "Document", "BusinessProfile", "Conversation"]) {
      checks.push({ name: `3 admin sees every ${t} row (equals the owner's count)`, ok: (await adminCount(t)) === (await ownerCount(t)) });
    }

    checks.push({ name: "4 User.password is refused", ok: await denied(() => admin!.$queryRawUnsafe(`SELECT "password" FROM "User" LIMIT 1`)) });
    checks.push({ name: "4 AuthSession.secretHash is refused", ok: await denied(() => admin!.$queryRawUnsafe(`SELECT "secretHash" FROM "AuthSession" LIMIT 1`)) });
    checks.push({ name: "4 Document.ocrText is refused", ok: await denied(() => admin!.$queryRawUnsafe(`SELECT "ocrText" FROM "Document" LIMIT 1`)) });
    checks.push({ name: "4 PlatformAdminPasskey is refused", ok: await denied(() => admin!.$queryRawUnsafe(`SELECT 1 FROM "PlatformAdminPasskey" LIMIT 1`)) });

    // The real services, as the admin login. They read only (the role holds no write privilege anywhere).
    process.env.ADMIN_DATABASE_URL = adminUrl;
    const run = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        checks.push({ name: `5 ${name} runs as the admin login`, ok: true });
      } catch {
        checks.push({ name: `5 ${name} runs as the admin login`, ok: false });
      }
    };
    const { getPlatformAdminHome } = await import("../../lib/services/platform-admin/platform-home.service");
    const { listPlatformBusinesses } = await import("../../lib/services/platform-admin/platform-businesses.service");
    const { getPlatformAdminBusinessDetail } = await import("../../lib/services/platform-admin/platform-business-detail.service");
    const { getPlatformAdminAttention } = await import("../../lib/services/platform-admin/platform-attention.service");
    const { getPlatformUsageOverview } = await import("../../lib/services/platform-admin/platform-usage-overview.service");
    const { getPlatformAdminOverview } = await import("../../lib/services/platform-admin/platform-overview.service");
    const { listPlatformAuditEvents } = await import("../../lib/services/platform-admin/platform-audit-list.service");
    const base = { page: 1, limit: 20, sort: "createdAt" as const, order: "desc" as const, q: null };
    await run("home", () => getPlatformAdminHome());
    for (const filter of ["all", "new", "inactive", "no_onboarding"] as const) {
      await run(`business list (${filter})`, () => listPlatformBusinesses({ ...base, filter }));
    }
    await run("business search", () => listPlatformBusinesses({ ...base, q: "a", filter: "all" }));
    await run("business detail (QA tenant)", () => getPlatformAdminBusinessDetail(QA_BUSINESS_ID));
    await run("attention", () => getPlatformAdminAttention());
    await run("usage overview", () => getPlatformUsageOverview());
    await run("overview", () => getPlatformAdminOverview());
    await run("audit list", () => listPlatformAuditEvents({ page: 1, limit: 10, kind: "all" }));
    const { getPrismaAdmin } = await import("../../lib/prisma-admin");
    await getPrismaAdmin().$disconnect();

    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
    console.log(`\nADMIN READ PLANE: ${failed.length === 0 ? "PASS" : "FAIL"} (${checks.length - failed.length}/${checks.length})`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${e.message}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? e.name : "unknown"}`); process.exitCode = 1; }
  } finally {
    await owner?.$disconnect();
    await admin?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/admin-read-evidence.ts")) void main();
