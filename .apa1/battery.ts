/**
 * Admin Control Center A1 / migration 20261024090000_platform_admin_a1 — battery AS THE REAL ROLES.
 *
 *   OWNER_URL=… ADMIN_URL=… RUNTIME_URL=… AUTH_URL=… node_modules/.bin/tsx .apa1/battery.ts
 *
 *   OWNER_URL    the migration owner (BYPASSRLS) — seeds synthetic rows only
 *   ADMIN_URL    a LOGIN member of app_admin   (Production: app_admin_prod)
 *   RUNTIME_URL  a LOGIN member of app_runtime (Production: app_runtime_prod)
 *   AUTH_URL     a LOGIN member of app_auth    (Production: app_auth_prod)
 *
 * Proves, on a database that has the migration applied:
 *   A. identity   the admin login is NOSUPERUSER, NOBYPASSRLS, member of app_admin;
 *   B. privileges every column the console reads is granted; no secret, content or money column, no
 *                 write, no passkey access, no schema CREATE is held by the admin plane;
 *   C. behaviour  forbidden reads/writes really fail (42501); cross-tenant reads see every tenant;
 *                 the runtime with no tenant context still sees ZERO rows (the defect A1 removes);
 *   D. services   the real admin services run unchanged against the admin login and return the seeded
 *                 truth — this is what proves the column grants fit Prisma's actual queries;
 *   E. passkeys   only app_auth may read/add/change the mutable columns; nobody may delete; the
 *                 runtime and the admin plane may not touch the table at all.
 *
 * Synthetic data only. Exit 0 = every check passed. Prints check names and booleans only.
 */
import { PrismaClient } from "@prisma/client";

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok, detail });
};

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}

const OWNER_URL = need("OWNER_URL");
const ADMIN_URL = need("ADMIN_URL");
const RUNTIME_URL = need("RUNTIME_URL");
const AUTH_URL = need("AUTH_URL");

const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
const admin = new PrismaClient({ datasourceUrl: ADMIN_URL });
const runtime = new PrismaClient({ datasourceUrl: RUNTIME_URL });
const auth = new PrismaClient({ datasourceUrl: AUTH_URL });

async function sqlState(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const err = e as { code?: string; meta?: { code?: string }; message?: string };
    const m = /(?:code|SqlState\(E?)\W*([0-9A-Z]{5})/.exec(err.message ?? "");
    return err.meta?.code ?? m?.[1] ?? err.code ?? "ERR";
  }
}
const denied = (state: string | null) => state === "42501";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

type Seed = { a: number; b: number; system: number; userA: number; userB: number };

async function seed(): Promise<Seed> {
  const tag = `apa1-${now.getTime()}`;
  const system = await owner.business.create({ data: { name: "__PLATFORM_SYSTEM__" } }).catch(async () =>
    owner.business.findFirstOrThrow({ where: { name: "__PLATFORM_SYSTEM__" } })
  );
  const a = await owner.business.create({ data: { name: `Lab Alpha ${tag}`, createdAt: daysAgo(1) } });
  const b = await owner.business.create({ data: { name: `Lab Beta ${tag}`, createdAt: daysAgo(40) } });
  const userA = await owner.user.create({
    data: { email: `alpha-${tag}@lab.invalid`, password: "x-hash", businessId: a.id, lastLoginAt: daysAgo(0) },
  });
  const userB = await owner.user.create({
    data: { email: `beta-${tag}@lab.invalid`, password: "x-hash", businessId: b.id },
  });
  await owner.businessProfile.create({ data: { businessId: a.id, onboardingCompletedAt: daysAgo(1) } });
  await owner.document.createMany({
    data: [
      { businessId: a.id, fileUrl: "lab://a1", source: "upload", mimeType: "application/pdf", status: "needs_review", ocrText: "secret text" },
      { businessId: a.id, fileUrl: "lab://a2", source: "upload", mimeType: "application/pdf", status: "processed" },
      { businessId: b.id, fileUrl: "lab://b1", source: "email", mimeType: "image/png", status: "needs_review" },
    ],
  });
  await owner.billingDocument.create({ data: { businessId: b.id, documentType: "TAX_INVOICE", status: "ISSUED", issuedAt: daysAgo(30) } });
  await owner.conversation.createMany({
    data: [
      { businessId: a.id, channel: "WHATSAPP", status: "OPEN", unansweredInboundCount: 2, lastMessageAt: daysAgo(0) },
      { businessId: b.id, channel: "WHATSAPP" },
    ],
  });
  const expires = new Date(now.getTime() + 30 * DAY);
  await owner.authSession.createMany({
    data: [
      { userId: userA.id, secretHash: "lab-secret-hash-a", tokenVersionAtIssue: 0, createdAt: daysAgo(1), lastUsedAt: new Date(now.getTime() - 60_000), idleExpiresAt: expires, absoluteExpiresAt: expires },
      { userId: userB.id, secretHash: "lab-secret-hash-b", tokenVersionAtIssue: 0, createdAt: daysAgo(40), lastUsedAt: daysAgo(20), idleExpiresAt: expires, absoluteExpiresAt: expires },
    ],
  });
  await owner.productUsageEvent.createMany({
    data: [
      { businessId: a.id, userId: userA.id, featureKey: "documents.upload", action: "completed", source: "lab" },
      { businessId: a.id, userId: userA.id, featureKey: "auth.login", action: "completed", source: "lab" },
      { businessId: b.id, userId: userB.id, featureKey: "auth.login", action: "completed", source: "lab" },
    ],
  });
  await owner.platformAuditEvent.createMany({
    data: [
      { actorUserId: userA.id, action: "PLATFORM_FEATURE_ACCESS_UPDATED", targetType: "BUSINESS", targetId: String(b.id) },
      { actorUserId: userA.id, action: "PLATFORM_ADMIN_HOME_VIEWED", targetType: "SYSTEM" },
    ],
  });
  return { a: a.id, b: b.id, system: system.id, userA: userA.id, userB: userB.id };
}

async function privilegeMatrix() {
  const role = (await admin.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`))[0].u;
  const has = async (sql: string, ...args: unknown[]) =>
    (await owner.$queryRawUnsafe<{ ok: boolean }[]>(sql, ...args))[0].ok;
  const col = (t: string, c: string, p = "SELECT") =>
    has(`SELECT has_column_privilege($1, $2, $3, $4) AS ok`, role, `public."${t}"`, c, p);
  const tbl = (t: string, p: string) => has(`SELECT has_table_privilege($1, $2, $3) AS ok`, role, `public."${t}"`, p);

  const [attrs] = await owner.$queryRawUnsafe<{ sup: boolean; bypass: boolean; member: boolean }[]>(
    `SELECT rolsuper AS sup, rolbypassrls AS bypass, pg_has_role(oid, 'app_admin', 'MEMBER') AS member FROM pg_roles WHERE rolname = $1`,
    role
  );
  check("A1 admin login is NOSUPERUSER", attrs.sup === false);
  check("A2 admin login is NOBYPASSRLS", attrs.bypass === false);
  check("A3 admin login is a member of app_admin", attrs.member === true);

  const allowed: Array<[string, string]> = [
    ["Business", "id"], ["Business", "name"], ["Business", "archivedAt"], ["Business", "deletionRequestedAt"], ["Business", "deletedAt"], ["Business", "createdAt"],
    ["User", "id"], ["User", "email"], ["User", "name"], ["User", "businessId"], ["User", "lastLoginAt"], ["User", "loginCount"], ["User", "emailVerifiedAt"], ["User", "createdAt"],
    ["BusinessProfile", "businessId"], ["BusinessProfile", "onboardingCompletedAt"],
    ["AuthSession", "userId"], ["AuthSession", "lastUsedAt"],
    ["EmailConnection", "status"], ["EmailConnection", "emailAddress"], ["EmailConnection", "lastSyncedAt"],
    ["Document", "status"], ["Document", "source"], ["Document", "createdAt"],
    ["BillingDocument", "status"], ["BillingDocument", "pdfRenderStatus"],
    ["Conversation", "status"], ["Conversation", "lastMessageAt"], ["Conversation", "unansweredInboundCount"],
    ["ContentRun", "status"], ["WhatsAppAttachmentImport", "status"],
  ];
  const missing: string[] = [];
  for (const [t, c] of allowed) if (!(await col(t, c))) missing.push(`${t}.${c}`);
  check("B1 every console column is readable", missing.length === 0, missing.join(","));

  const forbiddenCols: Array<[string, string]> = [
    ["User", "password"], ["User", "tokenVersion"], ["AuthSession", "secretHash"], ["AuthSession", "id"], ["AuthSession", "userAgent"],
    ["Document", "ocrText"], ["Document", "fileUrl"], ["Document", "contentHashSha256"],
    ["BillingDocument", "totalAmount"], ["BillingDocument", "customerNameSnapshot"], ["BillingDocument", "issuedSnapshot"],
    ["EmailConnection", "lastSyncCursor"], ["EmailConnection", "providerAccountId"], ["EmailConnection", "lastError"],
    ["Conversation", "pendingFollowUp"], ["ContentRun", "inputSnapshot"], ["WhatsAppAttachmentImport", "fromPhone"],
    ["BusinessProfile", "billingTaxId"], ["BusinessProfile", "billingPhone"], ["BusinessProfile", "billingLogoDataUrl"],
  ];
  const leaked: string[] = [];
  for (const [t, c] of forbiddenCols) if (await col(t, c)) leaked.push(`${t}.${c}`);
  check("B2 no secret, content, money or contact column is readable", leaked.length === 0, leaked.join(","));

  const writeTables = ["Business", "User", "BusinessProfile", "AuthSession", "EmailConnection", "Document", "BillingDocument", "Conversation", "ContentRun", "WhatsAppAttachmentImport", "ProductUsageEvent", "PlatformAuditEvent"];
  const writes: string[] = [];
  for (const t of writeTables) for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) if (await tbl(t, p)) writes.push(`${t}:${p}`);
  check("B3 the admin plane holds no write privilege on any table it reads", writes.length === 0, writes.join(","));

  const passkey: string[] = [];
  for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) if (await tbl("PlatformAdminPasskey", p)) passkey.push(p);
  check("B4 the admin plane holds nothing on PlatformAdminPasskey", passkey.length === 0, passkey.join(","));
  check("B5 the admin plane cannot CREATE in the schema", !(await has(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, role)));
  const ledger = (await owner.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS ok`))[0].ok;
  if (ledger) check("B6 the admin plane cannot read the migration ledger", !(await tbl("_prisma_migrations", "SELECT")));
}

async function behaviour(s: Seed) {
  check("C1 SELECT User.password as admin is refused", denied(await sqlState(() => admin.$queryRawUnsafe(`SELECT "password" FROM "User" LIMIT 1`))));
  check("C2 SELECT AuthSession.secretHash as admin is refused", denied(await sqlState(() => admin.$queryRawUnsafe(`SELECT "secretHash" FROM "AuthSession" LIMIT 1`))));
  check("C3 SELECT Document.ocrText as admin is refused", denied(await sqlState(() => admin.$queryRawUnsafe(`SELECT "ocrText" FROM "Document" LIMIT 1`))));
  check("C4 an audit INSERT as admin is refused", denied(await sqlState(() => admin.$executeRawUnsafe(`INSERT INTO "PlatformAuditEvent" ("action") VALUES ('LAB')`))));
  check("C5 a Business UPDATE as admin is refused", denied(await sqlState(() => admin.$executeRawUnsafe(`UPDATE "Business" SET "name" = "name" WHERE "id" = ${s.a}`))));

  const docsAdmin = await admin.document.count({ where: { businessId: { in: [s.a, s.b] } } });
  check("C6 admin sees every tenant's documents (3)", docsAdmin === 3, String(docsAdmin));
  const profiles = await admin.businessProfile.count({ where: { businessId: s.a } });
  check("C7 admin sees BusinessProfile across tenants (new p7adm_read)", profiles === 1, String(profiles));
  const docsRuntime = await runtime.document.count({ where: { businessId: { in: [s.a, s.b] } } });
  check("C8 the runtime with NO tenant context sees zero documents (the defect A1 removes)", docsRuntime === 0, String(docsRuntime));
}

async function services(s: Seed) {
  process.env.ADMIN_DATABASE_URL = ADMIN_URL;
  const { getPlatformAdminHome } = await import("../lib/services/platform-admin/platform-home.service");
  const { listPlatformBusinesses } = await import("../lib/services/platform-admin/platform-businesses.service");
  const { getPlatformAdminBusinessDetail } = await import("../lib/services/platform-admin/platform-business-detail.service");
  const { getPlatformAdminAttention: getPlatformAttention } = await import("../lib/services/platform-admin/platform-attention.service");
  const { getPlatformUsageOverview } = await import("../lib/services/platform-admin/platform-usage-overview.service");
  const { getPlatformAdminOverview } = await import("../lib/services/platform-admin/platform-overview.service");
  const { listPlatformAuditEvents } = await import("../lib/services/platform-admin/platform-audit-list.service");

  const run = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      const out = await fn();
      check(`D ${name} runs as the admin login`, true);
      return out;
    } catch (e) {
      check(`D ${name} runs as the admin login`, false, (e as Error).message.split("\n").slice(-2).join(" ").slice(0, 300));
      return null;
    }
  };

  const home = await run("home", () => getPlatformAdminHome(now));
  if (home) {
    check("D1 home: signups.month counts Alpha (created yesterday)", home.signups.month >= 1 || home.signups.week >= 1, JSON.stringify(home.signups.week));
    check("D2 home: active7d counts Alpha (session + non-auth action) and not Beta (login only)", home.businesses.active7d === 1, String(home.businesses.active7d));
    check("D3 home: users.seen24h = 1", home.users.seen24h === 1, String(home.users.seen24h));
    check("D4 home: funnel registered 30d counts Alpha only", home.funnel30d.registered === 1 && home.funnel30d.onboarded === 1, JSON.stringify(home.funnel30d));
    check("D5 home: recent admin actions exclude page views", home.recentAdminActions.every((x) => !x.action.endsWith("_VIEWED")) && home.recentAdminActions.length >= 1);
    check("D6 home: commercial is stated, not zeroed", home.commercial.status === "NO_SUBSCRIPTION_SYSTEM");
    check("D7 home: the platform business is not counted", home.recentBusinesses.every((b) => b.id !== s.system));
  }
  const base = { page: 1, limit: 50, sort: "createdAt" as const, order: "desc" as const };
  const all = await run("businesses list", () => listPlatformBusinesses({ ...base, q: null, filter: "all" }, now));
  if (all) {
    const alpha = all.items.find((i) => i.id === s.a);
    check("D8 list: real counts across tenants (Alpha 1 needs-review doc, 1 conversation)", alpha?.counts.documentsNeedsReview === 1 && alpha?.counts.conversations === 1, JSON.stringify(alpha?.counts));
    check("D9 list: lastActiveAt + ownerEmail + onboarding present", Boolean(alpha?.lastActiveAt && alpha?.ownerEmail && alpha?.onboardingCompletedAt));
  }
  const byEmail = await run("businesses search by email", () => listPlatformBusinesses({ ...base, q: "beta-apa1", filter: "all" }, now));
  check("D10 search by user email finds Beta only", byEmail?.items.length === 1 && byEmail.items[0].id === s.b, JSON.stringify(byEmail?.items.map((i) => i.id)));
  const byId = await run("businesses search by id", () => listPlatformBusinesses({ ...base, q: String(s.a), filter: "all" }, now));
  check("D11 search by id finds Alpha", Boolean(byId?.items.some((i) => i.id === s.a)));
  const inactive = await run("businesses filter inactive", () => listPlatformBusinesses({ ...base, q: "apa1", filter: "inactive" }, now));
  check("D12 inactive = Beta only", inactive?.items.length === 1 && inactive.items[0].id === s.b, JSON.stringify(inactive?.items.map((i) => i.id)));
  const fresh = await run("businesses filter new", () => listPlatformBusinesses({ ...base, q: "apa1", filter: "new" }, now));
  check("D13 new = Alpha only", fresh?.items.length === 1 && fresh.items[0].id === s.a);
  const noOnb = await run("businesses filter no_onboarding", () => listPlatformBusinesses({ ...base, q: "apa1", filter: "no_onboarding" }, now));
  check("D14 no_onboarding = Beta only", noOnb?.items.length === 1 && noOnb.items[0].id === s.b);
  const detail = await run("business detail", () => getPlatformAdminBusinessDetail(s.a));
  if (detail) {
    check("D15 detail: real document + conversation counts", detail.documents.total === 2 && detail.documents.needsReview === 1 && detail.conversations.waitingForReply === 1, JSON.stringify({ d: detail.documents.total, w: detail.conversations.waitingForReply }));
  }
  await run("attention", () => getPlatformAttention());
  await run("usage overview", () => getPlatformUsageOverview());
  await run("overview", () => getPlatformAdminOverview());
  const audit = await run("audit list", () => listPlatformAuditEvents({ page: 1, limit: 10 } as never));
  check("D16 audit list reads the trail", Boolean(audit && audit.items.length >= 2));
}

async function passkeys(s: Seed) {
  const insert = (db: PrismaClient) =>
    db.$executeRawUnsafe(
      `INSERT INTO "PlatformAdminPasskey" ("userId","credentialId","publicKey","label") VALUES ($1, $2, '\\x01'::bytea, 'lab')`,
      s.userA,
      `lab-cred-${Math.random().toString(36).slice(2)}-0000000000`
    );
  check("E1 the runtime cannot add a passkey", denied(await sqlState(() => insert(runtime))));
  check("E2 the runtime cannot read passkeys", denied(await sqlState(() => runtime.$queryRawUnsafe(`SELECT 1 FROM "PlatformAdminPasskey" LIMIT 1`))));
  check("E3 the admin plane cannot read passkeys", denied(await sqlState(() => admin.$queryRawUnsafe(`SELECT 1 FROM "PlatformAdminPasskey" LIMIT 1`))));
  check("E4 app_auth can add a passkey", (await sqlState(() => insert(auth))) === null);
  check("E5 app_auth can read passkeys", (await sqlState(() => auth.$queryRawUnsafe(`SELECT "id" FROM "PlatformAdminPasskey" LIMIT 1`))) === null);
  check("E6 app_auth can revoke (revokedAt) and count (signCount)", (await sqlState(() => auth.$executeRawUnsafe(`UPDATE "PlatformAdminPasskey" SET "revokedAt" = now(), "signCount" = 1 WHERE "userId" = $1`, s.userA))) === null);
  check("E7 app_auth cannot rewrite a public key", denied(await sqlState(() => auth.$executeRawUnsafe(`UPDATE "PlatformAdminPasskey" SET "publicKey" = '\\x02'::bytea WHERE "userId" = $1`, s.userA))));
  check("E8 app_auth cannot move a passkey to another user", denied(await sqlState(() => auth.$executeRawUnsafe(`UPDATE "PlatformAdminPasskey" SET "userId" = $2 WHERE "userId" = $1`, s.userA, s.userB))));
  check("E9 app_auth cannot delete a passkey", denied(await sqlState(() => auth.$executeRawUnsafe(`DELETE FROM "PlatformAdminPasskey" WHERE "userId" = $1`, s.userA))));
  const shape = await sqlState(() => owner.$executeRawUnsafe(`INSERT INTO "PlatformAdminPasskey" ("userId","credentialId","publicKey","label") VALUES ($1, 'short', '\\x01'::bytea, 'x')`, s.userA));
  check("E10 a malformed credential id is refused by the shape check", shape === "23514", String(shape));
}

const DB_ONLY = process.argv.includes("--db-only");

async function main() {
  const s = await seed();
  await privilegeMatrix();
  await behaviour(s);
  // --db-only: the migration-only PR (migration-first rule) carries no admin service code yet; the
  // services section runs in the application PR, against this same migration.
  if (DB_ONLY) {
    console.log("SKIP  D services — --db-only (migration-only PR; proven in the application PR)");
  } else {
    await services(s);
  }
  await passkeys(s);

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${!c.ok && c.detail ? `  [${c.detail}]` : ""}`);
  }
  console.log(`\nA1 battery: ${checks.length - failed.length}/${checks.length} PASS`);
  await Promise.all([owner, admin, runtime, auth].map((c) => c.$disconnect()));
  process.exit(failed.length === 0 ? 0 : 1);
}

void main().catch(async (e) => {
  console.error("BATTERY ERROR:", (e as Error).message);
  process.exit(1);
});
