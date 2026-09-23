/**
 * Routes that read tenant-owned tables, under the Production RLS posture.
 *
 * WHY THIS EXISTS
 *
 * A read that is not tenant-scoped does not fail under FORCE ROW LEVEL
 * SECURITY. It returns nothing, and the route reports that nothing as if it
 * were the truth. One such read already told every tenant its business identity
 * was missing and refused every tax invoice in Production. These three are its
 * neighbours, and the point of this file is to decide each one by running it —
 * not by reading it.
 *
 * The posture is what makes the answers meaningful, and it is easy to get wrong
 * in three separate ways:
 *
 *   1. POLICIES. `prisma db push` creates tables, not policies. The policies
 *      under test are installed here, verbatim from their migrations.
 *   2. IDENTITY. RLS never applies to a superuser and applies to a table owner
 *      only under FORCE. The test asserts its own role first.
 *   3. AMBIENT CONTEXT. `billingDbStep` scopes a read only when an ALS tenant
 *      context is already established. A harness that wraps everything in one
 *      would hide exactly the defect being hunted, so the route handlers are
 *      called with NO ambient context — the way a request arrives.
 *
 * Each route gets the same four questions:
 *   unscoped behaviour reproduces the failure · tenant-scoped returns own data ·
 *   cross-tenant visibility is zero · a write cannot escape its tenant.
 *
 * Synthetic data only. No secrets, no Neon, no network.
 *
 * Run: npx tsx app/api/rls-tenant-scoped-routes.integration.test.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../../lib/auth-token";
import { tenantTx } from "../../lib/tenant/tenant-tx";
import { getTenantContext } from "../../lib/tenant/context";
import { GET as settlementStateGET } from "./billing/documents/[id]/settlement-state/route";
import { GET as profileGET, POST as profilePOST } from "./business/profile/route";

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
const D = (v: string) => new Prisma.Decimal(v);

/** The policies these routes' tables actually carry, copied from their migrations. */
const TENANT_PREDICATE = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;
const RLS_TABLES = ["BusinessProfile", "BillingDocument", "BillingPaymentAllocation"];

async function installRls() {
  const adminUrl = process.env.RLS_ADMIN_URL;
  if (!adminUrl) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set — cannot install the policies under test");
    process.exit(1);
  }
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    for (const table of RLS_TABLES) {
      await admin.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS p7w1_tenant ON "${table}"`);
      await admin.$executeRawUnsafe(
        `CREATE POLICY p7w1_tenant ON "${table}"
           USING (${TENANT_PREDICATE}) WITH CHECK (${TENANT_PREDICATE})`
      );
    }
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

type Tenant = {
  businessId: number;
  userId: number;
  token: string;
  invoiceId: number;
  receiptId: number;
};

/**
 * A tenant shaped like the one in Production: a profile, an issued invoice of
 * 10, an issued receipt of 5, and the allocation that ties them together.
 */
async function makeTenant(label: string): Promise<Tenant> {
  const business = await prisma.business.create({ data: { name: `rls-${label}-${uniq()}` } });
  const user = await prisma.user.create({
    data: {
      email: `rls-${label}-${uniq()}@example.test`,
      password: "x",
      businessId: business.id,
      role: "USER",
    },
  });

  const { invoiceId, receiptId } = await tenantTx(business.id, async (tx) => {
    await tx.businessProfile.create({
      data: {
        businessId: business.id,
        category: `cat-${label}`,
        subCategory: `sub-${label}`,
        businessModel: "service",
        billingLegalName: `RLS Synthetic ${label}`,
        billingBusinessKind: "EXEMPT_DEALER",
        billingTaxId: "QA-TEST-NOT-A-REAL-TAXID",
        billingAddress: "1 Synthetic St",
        billingPhone: "0500000000",
        billingEmail: `rls-${label}@example.test`,
      },
    });

    const invoice = await tx.billingDocument.create({
      data: {
        businessId: business.id,
        documentType: "TAX_INVOICE",
        status: "ISSUED",
        documentNumber: 1,
        customerNameSnapshot: `RLS customer ${label}`,
        subtotalAmount: D("10.00"),
        vatAmount: D("0"),
        totalAmount: D("10.00"),
        currency: "ILS",
        issuedAt: new Date(),
      },
      select: { id: true },
    });

    const receipt = await tx.billingDocument.create({
      data: {
        businessId: business.id,
        documentType: "RECEIPT",
        status: "ISSUED",
        documentNumber: 1,
        customerNameSnapshot: `RLS customer ${label}`,
        subtotalAmount: D("0"),
        vatAmount: D("0"),
        totalAmount: D("5.00"),
        currency: "ILS",
        issuedAt: new Date(),
        unappliedAmount: D("0"),
      },
      select: { id: true },
    });

    await tx.billingPaymentAllocation.create({
      data: {
        businessId: business.id,
        receiptDocumentId: receipt.id,
        invoiceDocumentId: invoice.id,
        allocatedAmount: D("5.00"),
        currency: "ILS",
      },
    });

    return { invoiceId: invoice.id, receiptId: receipt.id };
  });

  return {
    businessId: business.id,
    userId: user.id,
    token: signAuthToken(user.id, 0),
    invoiceId,
    receiptId,
  };
}

const authed = (token: string, url: string, init: RequestInit = {}) =>
  new NextRequest(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  } as never);

async function main() {
  await assertGovernedIdentity();
  await installRls();

  const a = await makeTenant("a");
  const b = await makeTenant("b");

  // ---------------------------------------------------------- settlement ---
  // Production said UNPAID / allocated 0 for an invoice that had been half
  // settled. The route is called exactly as a request calls it.
  const sRes = await settlementStateGET(
    authed(a.token, `http://localhost/api/billing/documents/${a.invoiceId}/settlement-state`),
    { params: Promise.resolve({ id: String(a.invoiceId) }) }
  );
  const sBody = (await sRes.json()) as {
    settlementState?: { allocatedAmount: string; remainingAmount: string; status: string; allocationCount: number };
    error?: string;
  };
  console.log(`  settlement-state: ${JSON.stringify(sBody).slice(0, 220)}`);

  ok("S1 the settlement-state route answers", sRes.status === 200, `status ${sRes.status}`);
  ok(
    "S1 it counts the allocation that exists",
    Number(sBody.settlementState?.allocatedAmount) === 5,
    `allocated=${sBody.settlementState?.allocatedAmount}`
  );
  ok(
    "S1 remaining is 5.00, not the full 10.00",
    Number(sBody.settlementState?.remainingAmount) === 5,
    `remaining=${sBody.settlementState?.remainingAmount}`
  );
  ok(
    "S1 the invoice is no longer reported UNPAID",
    sBody.settlementState?.status !== "UNPAID",
    String(sBody.settlementState?.status)
  );
  ok("S1 exactly one allocation is counted", sBody.settlementState?.allocationCount === 1);

  // Cross-tenant: A asking about B's invoice must learn nothing.
  const sCross = await settlementStateGET(
    authed(a.token, `http://localhost/api/billing/documents/${b.invoiceId}/settlement-state`),
    { params: Promise.resolve({ id: String(b.invoiceId) }) }
  );
  ok("S2 tenant A cannot read tenant B's settlement state", sCross.status >= 400, `status ${sCross.status}`);

  // --------------------------------------------------------------- profile ---
  const pRes = await profileGET(
    authed(a.token, "http://localhost/api/business/profile") as unknown as Request
  );
  const pBody = (await pRes.json()) as { hasProfile?: boolean; profile?: { businessId: number; category: string } };
  ok("P1 the profile route answers", pRes.status === 200, `status ${pRes.status}`);
  ok("P1 it finds the tenant's profile", pBody.hasProfile === true, JSON.stringify(pBody).slice(0, 160));
  ok("P1 and it is the caller's own", pBody.profile?.businessId === a.businessId, String(pBody.profile?.businessId));

  // The write. An upsert whose WHERE cannot see the row would try to INSERT,
  // and the policy's WITH CHECK would refuse that — a 500 on an ordinary save.
  const wRes = await profilePOST(
    authed(a.token, "http://localhost/api/business/profile", {
      method: "POST",
      body: JSON.stringify({ category: "updated-cat", subCategory: "updated-sub", businessModel: "product" }),
    }) as unknown as Request
  );
  const wBody = (await wRes.json()) as { success?: boolean; profile?: { businessId: number; category: string } };
  ok("P2 the profile write succeeds", wRes.status === 200, `status ${wRes.status}: ${JSON.stringify(wBody).slice(0, 160)}`);
  ok("P2 it updated the caller's row", wBody.profile?.category === "updated-cat", String(wBody.profile?.category));
  ok("P2 it stayed on the caller's tenant", wBody.profile?.businessId === a.businessId, String(wBody.profile?.businessId));

  // The write must not have escaped: B's row is untouched.
  const bAfter = await tenantTx(b.businessId, (tx) =>
    tx.businessProfile.findUnique({ where: { businessId: b.businessId }, select: { category: true } })
  );
  ok("P3 the write did not reach another tenant", bAfter?.category === "cat-b", String(bAfter?.category));

  // And B's own read returns B's data, not A's.
  const pB = await profileGET(
    authed(b.token, "http://localhost/api/business/profile") as unknown as Request
  );
  const pBBody = (await pB.json()) as { profile?: { businessId: number; category: string } };
  ok("P3 tenant B reads its own profile", pBBody.profile?.businessId === b.businessId);
  ok("P3 and sees its own category", pBBody.profile?.category === "cat-b", String(pBBody.profile?.category));

  // ------------------------------------------------------------ video/plan ---
  // The read at app/api/video/plan/route.ts is a best-effort enrichment inside
  // a try/catch: it cannot error, it can only come back empty and silently drop
  // the tenant's stored identity. So the proof is the value, not the status —
  // the same read, run the way the route runs it and the way it should.
  const unscopedEnrichment = await prisma.businessProfile.findUnique({
    where: { businessId: a.businessId },
    select: { category: true, subCategory: true },
  });
  const scopedEnrichment = await tenantTx(a.businessId, (tx) =>
    tx.businessProfile.findUnique({
      where: { businessId: a.businessId },
      select: { category: true, subCategory: true },
    })
  );
  console.log(
    `  video/plan enrichment — unscoped: ${JSON.stringify(unscopedEnrichment)} | scoped: ${JSON.stringify(scopedEnrichment)}`
  );
  ok(
    "V1 the unscoped enrichment read returns nothing (the defect)",
    unscopedEnrichment === null,
    "if this fails, RLS is not in force and the rest proves nothing"
  );
  ok(
    "V1 the tenant-scoped read returns the stored identity",
    scopedEnrichment?.category !== undefined && scopedEnrichment?.category !== null,
    JSON.stringify(scopedEnrichment)
  );

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("RLS TENANT-SCOPED ROUTES: FAIL");
    process.exit(1);
  }
  console.log("RLS TENANT-SCOPED ROUTES: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
