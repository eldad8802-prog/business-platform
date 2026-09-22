/**
 * Creating a tax invoice under FORCE ROW LEVEL SECURITY.
 *
 * WHY THIS EXISTS
 *
 * This route refused EVERY tax invoice in Production, for EVERY tenant, with
 * "יש להשלים את פרטי העסק" — including tenants whose identity was complete. It
 * read `BusinessProfile` with the bare Prisma client, outside any tenant
 * transaction. `BusinessProfile` is FORCE RLS, `app.current_business_id` is set
 * only inside `tenantTx`, and a read with no GUC matches zero rows. So the
 * check saw null and concluded the identity was missing. Nothing errored;
 * nothing was logged. It was found from Production, by a QA tenant whose
 * profile endpoint had reported `identityComplete: true` seconds earlier.
 *
 * A test that only pushed the schema would not have caught it: `prisma db push`
 * creates tables, not policies, so without RLS installed the unscoped read
 * happily returns the row. This file therefore installs the SAME policy the
 * migration installs — same name, same predicate — and proves the bug is
 * reproducible before proving it is fixed:
 *
 *   P1  a profile exists for the tenant
 *   P2  an UNSCOPED read cannot observe it            (the bug, reproduced)
 *   P3  a TENANT-SCOPED read observes exactly it      (the fix's mechanism)
 *   P4  the route creates the invoice with no false identity rejection
 *   P5  a tenant cannot observe another tenant's profile
 *   P6  the document that was created belongs to the caller's tenant
 *   P7  an incomplete identity is still refused       (the check still works)
 *
 * Synthetic data only. No secrets, no Neon, no network.
 *
 * Run: npx tsx app/api/billing/documents/route.rls.integration.test.ts
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../../../../lib/auth-token";
import { tenantTx } from "../../../../lib/tenant/tenant-tx";
import { POST } from "./route";

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

/**
 * The policy from 20260825120000_d2_p7_wave1_businessprofile_rls, verbatim.
 * Installed here because the lab is built with `prisma db push`, which does not
 * run migrations — without this the original defect simply does not reproduce.
 */
async function installBusinessProfileRls() {
  // Installing a policy is an owner operation, so it runs on the admin
  // connection. Everything else in this file runs as the governed runtime role,
  // which is the whole point.
  const adminUrl = process.env.RLS_ADMIN_URL;
  if (!adminUrl) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set — cannot install the policy under test");
    process.exit(1);
  }
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    await admin.$executeRawUnsafe(`ALTER TABLE "BusinessProfile" ENABLE ROW LEVEL SECURITY`);
    await admin.$executeRawUnsafe(`ALTER TABLE "BusinessProfile" FORCE ROW LEVEL SECURITY`);
    await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS p7w1_tenant ON "BusinessProfile"`);
    await admin.$executeRawUnsafe(
      `CREATE POLICY p7w1_tenant ON "BusinessProfile"
         USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
         WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`
    );
  } finally {
    await admin.$disconnect();
  }
}

async function makeTenant(label: string, identity: "complete" | "incomplete") {
  const business = await prisma.business.create({ data: { name: `rls-${label}-${uniq()}` } });
  const user = await prisma.user.create({
    data: {
      email: `rls-${label}-${uniq()}@example.test`,
      password: "x",
      businessId: business.id,
      role: "USER",
    },
  });

  // Written with the GUC set, because the policy's WITH CHECK applies to the
  // insert as well — the same reason the read needs it.
  await tenantTx(business.id, (tx) =>
    tx.businessProfile.create({
      data:
        identity === "complete"
          ? {
              businessId: business.id,
              billingLegalName: `RLS Synthetic ${label}`,
              billingBusinessKind: "EXEMPT_DEALER",
              billingTaxId: "QA-TEST-NOT-A-REAL-TAXID",
              billingAddress: "1 Synthetic St",
              billingPhone: "0500000000",
              billingEmail: `rls-${label}@example.test`,
            }
          : { businessId: business.id }
    })
  );

  return { business, user, token: signAuthToken(user.id, user.tokenVersion) };
}

function createInvoiceRequest(token: string, customerName: string) {
  return new NextRequest("http://localhost/api/billing/documents", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      documentType: "TAX_INVOICE",
      customerNameSnapshot: customerName,
      initialLines: [
        { description: "RLS proof item", quantity: "1", unitPrice: "10.00", vatRatePercent: "0" },
      ],
    }),
  });
}

/**
 * RLS is only enforced against an identity that cannot bypass it. A superuser
 * ignores policies entirely, and a table's owner ignores them unless FORCE is
 * set — so a proof run under the wrong role passes while proving nothing. This
 * programme has already been bitten by that on Neon, where every role carries
 * BYPASSRLS. So the identity is checked first, and a run that cannot possibly
 * observe the defect fails instead of reporting success.
 */
async function assertIdentityCanBeGovernedByRls() {
  const [row] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;

  console.log(`  connected as: ${row?.who} (superuser=${row?.rolsuper}, bypassrls=${row?.rolbypassrls})`);
  if (!row || row.rolsuper || row.rolbypassrls) {
    console.log(
      "  [FAIL] this role bypasses row-level security — the defect cannot be reproduced here"
    );
    console.log("BILLING PROFILE RLS: FAIL");
    process.exit(1);
  }
}

async function main() {
  await assertIdentityCanBeGovernedByRls();
  await installBusinessProfileRls();

  const a = await makeTenant("a", "complete");
  const b = await makeTenant("b", "complete");
  const c = await makeTenant("c", "incomplete");

  // --- P1: the row is really there ----------------------------------------
  const scoped = await tenantTx(a.business.id, (tx) =>
    tx.businessProfile.findUnique({
      where: { businessId: a.business.id },
      select: { billingLegalName: true, billingTaxId: true, businessId: true },
    })
  );
  ok("P1 a BusinessProfile exists for the tenant", scoped !== null);

  // --- P2: the defect, reproduced -----------------------------------------
  const unscoped = await prisma.businessProfile.findUnique({
    where: { businessId: a.business.id },
    select: { billingLegalName: true },
  });
  ok(
    "P2 an UNSCOPED read cannot observe the tenant's row",
    unscoped === null,
    "if this fails, RLS is not actually installed and the rest proves nothing"
  );

  // --- P3: what the fix does instead --------------------------------------
  ok("P3 a TENANT-SCOPED read observes the correct profile", scoped?.businessId === a.business.id);
  ok("P3 and it carries the identity fields", scoped?.billingTaxId === "QA-TEST-NOT-A-REAL-TAXID");

  // --- P4: the route itself ------------------------------------------------
  const res = await POST(createInvoiceRequest(a.token, "RLS Customer A"));
  const body = (await res.json()) as { document?: { id: number; businessId: number }; error?: string };
  ok(
    "P4 the route creates the invoice with a complete identity",
    res.status === 201,
    `status ${res.status}: ${body.error ?? ""}`
  );
  ok(
    "P4 no false BILLING_IDENTITY_INCOMPLETE rejection",
    !(body.error ?? "").includes("להשלים את פרטי העסק"),
    body.error ?? ""
  );

  // --- P5: the negative, cross-tenant --------------------------------------
  const crossTenant = await tenantTx(a.business.id, (tx) =>
    tx.businessProfile.findMany({ where: { businessId: b.business.id } })
  );
  ok("P5 tenant A cannot observe tenant B's profile", crossTenant.length === 0, `${crossTenant.length} rows`);

  const everythingAsA = await tenantTx(a.business.id, (tx) => tx.businessProfile.findMany({}));
  ok(
    "P5 an unfiltered read as tenant A returns only tenant A",
    everythingAsA.every((p) => p.businessId === a.business.id),
    `${everythingAsA.length} rows, ids: ${everythingAsA.map((p) => p.businessId).join(",")}`
  );

  // --- P6: the document landed in the right tenant -------------------------
  ok(
    "P6 the created document belongs to the calling tenant",
    body.document?.businessId === a.business.id,
    String(body.document?.businessId)
  );

  // --- P7: the check still refuses what it should --------------------------
  const refused = await POST(createInvoiceRequest(c.token, "RLS Customer C"));
  const refusedBody = (await refused.json()) as { error?: string };
  ok(
    "P7 an incomplete identity is still refused",
    refused.status >= 400 && (refusedBody.error ?? "").includes("להשלים את פרטי העסק"),
    `status ${refused.status}: ${refusedBody.error ?? ""}`
  );

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("BILLING PROFILE RLS: FAIL");
    process.exit(1);
  }
  console.log("BILLING PROFILE RLS: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
