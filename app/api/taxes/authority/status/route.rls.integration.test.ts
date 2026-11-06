/**
 * The tax-authority connection status under the Production RLS posture.
 *
 * WHY THIS EXISTS
 *
 * `GET /api/taxes/authority/status` (and the connections center / summary,
 * which share its resolver) read `BillingAuthorityConnection` through
 * billingDbStep with NO tenant context, so the read ran on the global client
 * without `app.current_business_id`. The table is FORCE RLS
 * (20260831120000_d2_p7_w4eb2_billing_tenant_rls) and the runtime role cannot
 * bypass it, so the row was invisible and every business read as DISCONNECTED —
 * including right after a successful OAuth callback, which writes through
 * billingTenantTx and commits CONNECTED + tokens. The card then offered
 * "connect" on a live connection.
 *
 * Same three rules as every RLS proof in this repository:
 *   1. POLICIES installed here exactly as the migration defines them.
 *   2. IDENTITY asserted NOSUPERUSER / NOBYPASSRLS.
 *   3. AMBIENT CONTEXT: routes are called with NO tenant context.
 *
 * Synthetic data only. No secrets, no Neon, no network, no ITA.
 *
 * Run: npx tsx app/api/taxes/authority/status/route.rls.integration.test.ts
 */
import { BillingAuthorityEnvironment, PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../../../../../lib/auth-token";
import { tenantTx } from "../../../../../lib/tenant/tenant-tx";
import { getTenantContext } from "../../../../../lib/tenant/context";
import { GET as statusGET } from "./route";
import { GET as connectionsCenterGET } from "../../../settings/connections-center/route";
import { GET as connectionsSummaryGET } from "../../../settings/connections-summary/route";

const prisma = new PrismaClient();

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** As 20260831120000_d2_p7_w4eb2_billing_tenant_rls installs it (one policy, all commands). */
const TENANT_PREDICATE = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;

async function installRls() {
  const adminUrl = process.env.RLS_ADMIN_URL;
  if (!adminUrl) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set — cannot install the policy under test");
    process.exit(1);
  }
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    const t = "BillingAuthorityConnection";
    await admin.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await admin.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS p7w4eb2_tenant ON "${t}"`);
    await admin.$executeRawUnsafe(
      `CREATE POLICY p7w4eb2_tenant ON "${t}" USING (${TENANT_PREDICATE}) WITH CHECK (${TENANT_PREDICATE})`
    );
  } finally {
    await admin.$disconnect();
  }
}

async function assertGovernedIdentity() {
  const [row] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  connected as: ${row?.who} (superuser=${row?.rolsuper}, bypassrls=${row?.rolbypassrls})`);
  if (!row || row.rolsuper || row.rolbypassrls) {
    console.log("  [FAIL] this role bypasses RLS — nothing below would prove anything");
    process.exit(1);
  }
  ok("no ambient tenant context, as in a real request", getTenantContext() === undefined);
}

/** BillingAuthorityApp is platform-level (no RLS); synthetic, non-secret placeholders. */
async function ensureApp(environment: BillingAuthorityEnvironment) {
  const data = {
    status: "ACTIVE" as const,
    accountingSoftwareNumber: "000000",
    itaClientId: `synthetic-client-${environment.toLowerCase()}`,
    clientSecretEncrypted: "synthetic",
    clientSecretIv: "synthetic",
    clientSecretTag: "synthetic",
    encryptionKeyId: "synthetic",
  };
  await prisma.billingAuthorityApp.upsert({
    where: { environment },
    create: { environment, ...data },
    update: data,
  });
}

type Tenant = { businessId: number; userId: number; token: string };

async function makeTenant(label: string): Promise<Tenant> {
  const business = await prisma.business.create({ data: { name: `rls-auth-${label}-${uniq()}` } });
  const user = await prisma.user.create({
    data: {
      email: `rls-auth-${label}-${uniq()}@example.test`,
      password: "x",
      businessId: business.id,
      role: "USER",
    },
  });
  return { businessId: business.id, userId: user.id, token: signAuthToken(user.id, user.tokenVersion) };
}

const SYNTHETIC_CIPHERTEXT = {
  accessTokenEncrypted: "synthetic-access-ct",
  accessTokenIv: "synthetic-iv",
  accessTokenTag: "synthetic-tag",
  refreshTokenEncrypted: "synthetic-refresh-ct",
  refreshTokenIv: "synthetic-iv",
  refreshTokenTag: "synthetic-tag",
  encryptionKeyId: "synthetic",
};

const get = (token: string, url: string) =>
  new NextRequest(url, { headers: { Authorization: `Bearer ${token}` } } as never);

type StatusBody = {
  authority?: { environment: string; status: string; connectedAt: string | null; canConnect: boolean };
  productionPilot?: { status: string; connectedAt: string | null; canConnect: boolean; canReconnect: boolean } | null;
  error?: string;
};

async function status(token: string, qs = ""): Promise<{ code: number; body: StatusBody; raw: string }> {
  const res = await statusGET(get(token, `http://localhost/api/taxes/authority/status${qs}`));
  const raw = await res.text();
  return { code: res.status, body: JSON.parse(raw) as StatusBody, raw };
}

async function main() {
  await assertGovernedIdentity();
  await installRls();

  await ensureApp(BillingAuthorityEnvironment.PRODUCTION);
  await ensureApp(BillingAuthorityEnvironment.SANDBOX);

  const a = await makeTenant("a"); // pilot business + user, PRODUCTION CONNECTED with tokens
  const b = await makeTenant("b"); // PRODUCTION AUTHORIZATION_REQUIRED (OAuth started, no callback)
  const c = await makeTenant("c"); // no connection at all

  process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = String(a.businessId);
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = String(a.userId);
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth";

  const authorizedAt = new Date("2026-11-05T15:55:57.000Z");
  // Seeded with the GUC set, as the callback writes (billingTenantTx).
  await tenantTx(a.businessId, (tx) =>
    tx.billingAuthorityConnection.create({
      data: {
        businessId: a.businessId,
        environment: BillingAuthorityEnvironment.PRODUCTION,
        status: "CONNECTED",
        ...SYNTHETIC_CIPHERTEXT,
        oauthAuthorizedAt: authorizedAt,
        oauthAuthorizedByUserId: a.userId,
      },
    })
  );
  await tenantTx(b.businessId, (tx) =>
    tx.billingAuthorityConnection.create({
      data: {
        businessId: b.businessId,
        environment: BillingAuthorityEnvironment.PRODUCTION,
        status: "AUTHORIZATION_REQUIRED",
      },
    })
  );

  // ------------------------------------------------------------ the posture ---
  const unscoped = await prisma.billingAuthorityConnection.findMany({ where: { businessId: a.businessId } });
  ok("G1 an unscoped connection read returns nothing (RLS is in force)", unscoped.length === 0, `got ${unscoped.length}`);
  const scopedA = await tenantTx(a.businessId, (tx) => tx.billingAuthorityConnection.count());
  ok("G2 a scoped read sees tenant A's one row", scopedA === 1, `scoped count ${scopedA}`);

  // ----------------------------------------------------- connected tenant A ---
  const sa = await status(a.token);
  ok("S1 tenant A's status answers 200", sa.code === 200, `status ${sa.code}`);
  ok(
    "S1 the main authority card reads CONNECTED (runtime PRODUCTION)",
    sa.body.authority?.environment === "PRODUCTION" && sa.body.authority?.status === "CONNECTED",
    JSON.stringify(sa.body.authority)
  );
  ok(
    "S2 the Production pilot section reads CONNECTED, connect not offered",
    sa.body.productionPilot?.status === "CONNECTED" &&
      sa.body.productionPilot?.canConnect === false &&
      sa.body.productionPilot?.canReconnect === false,
    JSON.stringify(sa.body.productionPilot)
  );
  ok(
    "S3 connectedAt is the authorization time",
    sa.body.productionPilot?.connectedAt === authorizedAt.toISOString(),
    String(sa.body.productionPilot?.connectedAt)
  );
  ok(
    "S4 no token or ciphertext material in the answer",
    !/synthetic-(access|refresh)-ct|Encrypted|accessToken|refreshToken/i.test(sa.raw)
  );

  // ------------------------------------------- tenant B: OAuth not finished ---
  const sb = await status(b.token);
  ok(
    "B1 tenant B (authorization required) reads DISCONNECTED with connect offered",
    sb.code === 200 && sb.body.authority?.status === "DISCONNECTED" && sb.body.authority?.canConnect === true,
    JSON.stringify(sb.body.authority)
  );
  ok("B2 tenant B is not a pilot → no Production section", sb.body.productionPilot === null);
  ok("B3 tenant B never sees A's connection date", sb.body.authority?.connectedAt === null);

  // ----------------------------------------------- tenant C: no connection ---
  const sc = await status(c.token);
  ok(
    "C1 a tenant with no connection reads DISCONNECTED",
    sc.code === 200 && sc.body.authority?.status === "DISCONNECTED",
    JSON.stringify(sc.body.authority)
  );

  // ------------------------------------------------------------ isolation ---
  const ab = await status(a.token, `?businessId=${b.businessId}`);
  ok("X1 tenant A asking for B's status → 403", ab.code === 403, `status ${ab.code}`);
  const ba = await status(b.token, `?businessId=${a.businessId}`);
  ok("X2 tenant B asking for A's status → 403", ba.code === 403, `status ${ba.code}`);
  ok("X3 and B's refusal carries nothing of A's", !ba.raw.includes(authorizedAt.toISOString()));
  ok("X4 no tenant context leaks out of the route", getTenantContext() === undefined);

  // ------------------------------------- connections center + summary ---
  const ccA = JSON.stringify(
    await (await connectionsCenterGET(get(a.token, "http://localhost/api/settings/connections-center"))).json()
  );
  ok("CC1 connections center shows A's authority card", ccA.includes('"provider":"tax_authority"'));
  const ccB = JSON.stringify(
    await (await connectionsCenterGET(get(b.token, "http://localhost/api/settings/connections-center"))).json()
  );
  ok("CC2 connections center shows no authority card for B", !ccB.includes('"provider":"tax_authority"'));

  const csA = (await (await connectionsSummaryGET(get(a.token, "http://localhost/api/settings/connections-summary"))).json()) as {
    breakdown?: { taxAuthority?: number };
  };
  ok("CS1 connections summary counts A's authority connection", csA.breakdown?.taxAuthority === 1, JSON.stringify(csA.breakdown));
  const csB = (await (await connectionsSummaryGET(get(b.token, "http://localhost/api/settings/connections-summary"))).json()) as {
    breakdown?: { taxAuthority?: number };
  };
  ok("CS2 and counts none for B", csB.breakdown?.taxAuthority === 0, JSON.stringify(csB.breakdown));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("AUTHORITY STATUS UNDER RLS: FAIL");
    process.exit(1);
  }
  console.log("AUTHORITY STATUS UNDER RLS: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
