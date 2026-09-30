/**
 * Platform-admin forensic — Production, SCRIPT-ONLY, READ-ONLY. Ids, roles, booleans, timestamps and
 * counts only: never an email address, a name, a password hash, an MFA seed, a recovery hash or a token.
 *
 *   OWNER_DATABASE_URL=… node_modules/.bin/tsx scripts/ops/platform-admin-forensic-evidence.ts \
 *     --allow-host ep-flat-brook-am4bhq1y [--user 9] [--recent-hours 72]
 *
 * Answers: who holds PLATFORM_ADMIN today; the current state of the documented admin (user 9) — role,
 * business membership (system business or a real one), lifecycle, login/session history; its MFA
 * enrollment timeline; every platform-admin audit action by actor (counts, first, last); and which
 * accounts signed in recently (to identify the account the owner is using now, without any address).
 * The session is READ ONLY by Postgres, verified before and after.
 *
 * Exit: 0 printed · 1 failed · 3 REFUSED (precondition) · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, enforceReadOnly, RefusedError, verifyReadOnly } from "./runtime-rls-evidence";

const SYSTEM_BUSINESS = "__PLATFORM_SYSTEM__";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const allowHost = arg("--allow-host") ?? null;
  const userId = Number(arg("--user") ?? "9");
  const recentHours = Number(arg("--recent-hours") ?? "72");
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(recentHours) || recentHours <= 0 || recentHours > 720) {
    console.error("usage: --allow-host <host> [--user <id>] [--recent-hours <1..720>]");
    process.exit(2);
  }
  let db: PrismaClient | undefined;
  try {
    db = new PrismaClient({ datasourceUrl: assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost) });
    await enforceReadOnly(db, "owner");
    const q = <T>(sql: string, ...p: unknown[]) => db!.$queryRawUnsafe<T[]>(sql, ...p);

    const system = await q<{ id: number }>(`SELECT id FROM "Business" WHERE name = $1 ORDER BY id`, SYSTEM_BUSINESS);
    const systemIds = system.map((s) => s.id);

    // Who holds the role today.
    const admins = await q<Record<string, unknown>>(
      `SELECT u.id, u."businessId", (b.name = $1) AS "businessIsSystem", u."createdAt", u."updatedAt", u."lastLoginAt", u."loginCount"
         FROM "User" u JOIN "Business" b ON b.id = u."businessId" WHERE u.role::text = 'PLATFORM_ADMIN' ORDER BY u.id`, SYSTEM_BUSINESS);

    // The documented admin, as it is now.
    const [target] = await q<Record<string, unknown>>(
      `SELECT u.id, u.role::text AS role, u."businessId", (b.name = $2) AS "businessIsSystem",
              (b."deletionRequestedAt" IS NULL AND b."deletedAt" IS NULL) AS "businessActive",
              (SELECT count(*)::int FROM "User" o WHERE o."businessId" = u."businessId") AS "usersInItsBusiness",
              (u.email = lower(btrim(u.email))) AS "emailIsFolded",
              u."createdAt", u."updatedAt", u."lastLoginAt", u."loginCount", u."tokenVersion"
         FROM "User" u JOIN "Business" b ON b.id = u."businessId" WHERE u.id = $1`, userId, SYSTEM_BUSINESS);

    const mfa = await q<Record<string, unknown>>(
      `SELECT "userId", "enrolledAt", "lastVerifiedAt", cardinality("recoveryCodeHashes") AS "recoveryCodesRemaining",
              "recoveryCodesGeneratedAt", "createdAt", "updatedAt" FROM "PlatformAdminMfa" ORDER BY "userId"`);

    const audit = await q<Record<string, unknown>>(
      `SELECT "actorUserId", action, count(*)::int AS n, min("createdAt") AS first, max("createdAt") AS last
         FROM "PlatformAuditEvent" GROUP BY 1, 2 ORDER BY 1, 2`);

    const sessions = await q<Record<string, unknown>>(
      `SELECT count(*)::int AS total, min("createdAt") AS first, max("createdAt") AS "lastIssued", max("lastUsedAt") AS "lastUsed",
              count(*) FILTER (WHERE "revokedAt" IS NULL AND "absoluteExpiresAt" > now())::int AS active
         FROM "AuthSession" WHERE "userId" = $1`, userId);

    // Which accounts signed in recently — ids only — to identify the account in use now.
    const recent = await q<Record<string, unknown>>(
      `SELECT s."userId", u.role::text AS role, u."businessId", (b.name = $2) AS "businessIsSystem",
              count(*)::int AS sessions, max(s."createdAt") AS "lastIssued", max(s."lastUsedAt") AS "lastUsed"
         FROM "AuthSession" s JOIN "User" u ON u.id = s."userId" JOIN "Business" b ON b.id = u."businessId"
        WHERE s."createdAt" > now() - make_interval(hours => $1) GROUP BY 1, 2, 3, 4 ORDER BY 1`, recentHours, SYSTEM_BUSINESS);

    // Accounts attached to the two businesses in question (ids and roles only).
    const members = await q<Record<string, unknown>>(
      `SELECT u."businessId", u.id, u.role::text AS role, u."lastLoginAt" FROM "User" u WHERE u."businessId" IN (3, 9) ORDER BY 1, 2`);

    await verifyReadOnly(db, "owner");
    const out = {
      systemBusinessIds: systemIds,
      platformAdminsNow: admins,
      documentedAdmin: target ?? { id: userId, exists: false },
      platformAdminMfa: mfa,
      platformAuditByActor: audit,
      documentedAdminSessions: sessions[0],
      recentSignIns: { hours: recentHours, accounts: recent },
      membersOfBusinesses3and9: members,
    };
    console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 1));
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${e.message}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? e.name : "unknown"} ${(e as { code?: string })?.code ?? ""}`); process.exitCode = 1; }
  } finally {
    await db?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/platform-admin-forensic-evidence.ts")) void main();
