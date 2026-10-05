/**
 * Profile + Settings read APIs under the Production RLS posture.
 *
 *   GET /api/profile/summary
 *   GET /api/settings/connections-summary
 *
 * Both answer with counts and identity for "the signed-in business". The two
 * ways that goes wrong are (1) a count that silently reads zero because it ran
 * without tenant context, and (2) a count or field that leaks another tenant.
 * Each is decided here by running the real route handlers, with no ambient
 * tenant context (the way a request arrives), as a NOSUPERUSER / NOBYPASSRLS
 * role, against the tenant policies installed verbatim-in-shape from their
 * migrations.
 *
 * It also pins the documented metric rules against real rows:
 *   active customers = isActive · issued documents = status ISSUED ·
 *   active quotes = QUOTE, not converted, validUntil null or ≥ today (Israel)
 * and the connection rule "only what the Connections screen shows as connected".
 *
 * Synthetic data only. No secrets, no Neon, no network.
 *
 * Run: npx tsx app/api/profile-settings.rls.integration.test.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../../lib/auth-token";
import { tenantTx } from "../../lib/tenant/tenant-tx";
import { getTenantContext } from "../../lib/tenant/context";
import { jerusalemDayKey } from "../../lib/utils/jerusalem-day";
import { GET as profileSummaryGET } from "./profile/summary/route";
import { GET as connectionsSummaryGET } from "./settings/connections-summary/route";

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

const TENANT_PREDICATE = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;
/** Every tenant table the two routes read. */
const RLS_TABLES = [
  "BusinessProfile",
  "Customer",
  "BillingDocument",
  "EmailConnection",
  "BusinessPaymentConnection",
  "AcquisitionConnection",
  "BillingAuthorityConnection",
  "BusinessFeatureAccess",
];

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
      await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS psv2_tenant ON "${table}"`);
      await admin.$executeRawUnsafe(
        `CREATE POLICY psv2_tenant ON "${table}" USING (${TENANT_PREDICATE}) WITH CHECK (${TENANT_PREDICATE})`
      );
    }
    // The feature catalogue row the acquisition override hangs off (global, not a tenant table).
    await admin.platformFeatureDefinition.upsert({
      where: { key: "acquisition_web_forms" },
      update: {},
      create: { key: "acquisition_web_forms", displayName: "לידים מטופס באתר", category: "acquisition", defaultEnabled: false },
    });
  } finally {
    await admin.$disconnect();
  }
}

async function assertGovernedIdentity() {
  const [row] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  connected as: ${row?.who} (superuser=${row?.rolsuper}, bypassrls=${row?.rolbypassrls})`);
  if (!row || row.rolsuper || row.rolbypassrls) {
    console.log("  [FAIL] this role bypasses RLS — nothing below would prove anything");
    process.exit(1);
  }
  ok("no ambient tenant context, as in a real request", getTenantContext() === undefined);
}

// A 1×1 PNG — the smallest image the logo/signature validator accepts.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type Tenant = { businessId: number; userId: number; token: string; email: string; name: string };

async function makeUser(label: string): Promise<Tenant> {
  const name = `עסק ${label} ${uniq()}`;
  const business = await prisma.business.create({ data: { name } });
  const email = `psv2-${label}-${uniq()}@example.test`;
  const user = await prisma.user.create({
    data: { email, password: "x", businessId: business.id, role: "USER", name: `Owner ${label}` },
  });
  return { businessId: business.id, userId: user.id, token: signAuthToken(user.id, 0), email, name };
}

const day = (offsetDays: number) => {
  const key = jerusalemDayKey(new Date(Date.now() + offsetDays * 86_400_000));
  return new Date(`${key}T00:00:00.000Z`);
};

let docNo = 1;
function doc(businessId: number, documentType: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    businessId,
    documentType,
    status,
    documentNumber: docNo++,
    customerNameSnapshot: "Synthetic customer",
    subtotalAmount: D("10.00"),
    vatAmount: D("0"),
    totalAmount: D("10.00"),
    currency: "ILS",
    ...(status === "ISSUED" ? { issuedAt: new Date() } : {}),
    ...extra,
  } as Prisma.BillingDocumentUncheckedCreateInput;
}

/**
 * Tenant A — everything filled, and every rule's edge:
 *   customers  3 active + 1 deactivated
 *   documents  2 issued invoices + 1 issued receipt + 1 draft invoice
 *   quotes     open-ended · valid today · valid tomorrow · expired yesterday · converted
 *   connections WhatsApp CONNECTED · Gmail connected + revoked · payments active + inactive ·
 *              web form ACTIVE (source enabled) + PAUSED
 */
async function seedA(t: Tenant) {
  await tenantTx(t.businessId, async (tx) => {
    await tx.businessProfile.create({
      data: {
        businessId: t.businessId,
        category: "Food",
        subCategory: "Cafe",
        billingLegalName: "Synthetic A Ltd",
        billingBusinessKind: "LTD_COMPANY",
        billingTaxId: "QA-NOT-A-REAL-TAXID",
        billingAddress: "1 Synthetic St",
        billingPhone: "0500000000",
        billingEmail: "a@example.test",
        billingLogoDataUrl: PNG,
        billingSignatureDataUrl: PNG,
      },
    });
    for (let i = 0; i < 3; i++) {
      await tx.customer.create({ data: { businessId: t.businessId, name: `A customer ${i}`, phone: `05211111${i}` } });
    }
    await tx.customer.create({ data: { businessId: t.businessId, name: "A inactive", phone: "0521111199", isActive: false } });

    const invoice = await tx.billingDocument.create({ data: doc(t.businessId, "TAX_INVOICE", "ISSUED"), select: { id: true } });
    await tx.billingDocument.create({ data: doc(t.businessId, "TAX_INVOICE", "ISSUED") });
    await tx.billingDocument.create({ data: doc(t.businessId, "RECEIPT", "ISSUED", { unappliedAmount: D("0") }) });
    await tx.billingDocument.create({ data: doc(t.businessId, "TAX_INVOICE", "DRAFT") });

    await tx.billingDocument.create({ data: doc(t.businessId, "QUOTE", "DRAFT") });
    await tx.billingDocument.create({ data: doc(t.businessId, "QUOTE", "DRAFT", { validUntil: day(0) }) });
    await tx.billingDocument.create({ data: doc(t.businessId, "QUOTE", "PENDING_REVIEW", { validUntil: day(1) }) });
    await tx.billingDocument.create({ data: doc(t.businessId, "QUOTE", "DRAFT", { validUntil: day(-1) }) });
    await tx.billingDocument.create({ data: doc(t.businessId, "QUOTE", "DRAFT", { convertedToInvoiceId: invoice.id }) });

    await tx.emailConnection.create({
      data: { businessId: t.businessId, provider: "gmail", emailAddress: "a1@example.test", providerAccountId: `pa-${uniq()}`, scopes: "x", status: "connected" },
    });
    await tx.emailConnection.create({
      data: { businessId: t.businessId, provider: "gmail", emailAddress: "a2@example.test", providerAccountId: `pa-${uniq()}`, scopes: "x", status: "revoked" },
    });
    await tx.businessPaymentConnection.create({ data: { businessId: t.businessId, provider: "CARDCOM", isActive: true } });
    await tx.businessPaymentConnection.create({ data: { businessId: t.businessId, provider: "TRANZILA", isActive: false } });
    await tx.businessFeatureAccess.create({
      data: { businessId: t.businessId, featureKey: "acquisition_web_forms", state: "ENABLED" },
    });
    await tx.acquisitionConnection.create({ data: { businessId: t.businessId, sourceKey: "web.form", publicId: `pub-${uniq()}`, status: "ACTIVE" } });
    await tx.acquisitionConnection.create({ data: { businessId: t.businessId, sourceKey: "web.form", publicId: `pub-${uniq()}`, status: "PAUSED" } });
  });

  // WhatsAppConnection is not a FORCE-RLS table (webhooks resolve it before a tenant exists).
  await prisma.whatsAppConnection.create({
    data: {
      businessId: t.businessId,
      phoneNumberId: `pn-${uniq()}`,
      displayPhoneNumber: "+972500000000",
      wabaId: "waba-synthetic",
      accessTokenEncrypted: "synthetic",
      accessTokenIv: "synthetic",
      accessTokenTag: "synthetic",
      status: "CONNECTED",
    },
  });
}

/**
 * Tenant B — sparse: a profile with a phone only, 2 customers, 1 issued invoice,
 * 1 open quote, an ACTIVE lead source whose feature is NOT enabled for it, and
 * a WhatsApp row that is DISCONNECTED.
 */
async function seedB(t: Tenant) {
  await tenantTx(t.businessId, async (tx) => {
    await tx.businessProfile.create({ data: { businessId: t.businessId, billingPhone: "0539999999" } });
    await tx.customer.create({ data: { businessId: t.businessId, name: "B customer 1", phone: "0532222221" } });
    await tx.customer.create({ data: { businessId: t.businessId, name: "B customer 2", phone: "0532222222" } });
    await tx.billingDocument.create({ data: doc(t.businessId, "TAX_INVOICE", "ISSUED") });
    await tx.billingDocument.create({ data: doc(t.businessId, "QUOTE", "DRAFT") });
    await tx.acquisitionConnection.create({ data: { businessId: t.businessId, sourceKey: "web.form", publicId: `pub-${uniq()}`, status: "ACTIVE" } });
  });
  await prisma.whatsAppConnection.create({
    data: {
      businessId: t.businessId,
      phoneNumberId: `pn-${uniq()}`,
      displayPhoneNumber: "+972500000001",
      wabaId: "waba-synthetic",
      accessTokenEncrypted: "synthetic",
      accessTokenIv: "synthetic",
      accessTokenTag: "synthetic",
      status: "DISCONNECTED",
    },
  });
}

const get = (token: string | null, url: string) =>
  new NextRequest(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} } as never);

async function main() {
  await assertGovernedIdentity();
  await installRls();

  const a = await makeUser("A");
  const b = await makeUser("B");
  await seedA(a);
  await seedB(b);

  console.log("\n  posture");
  ok(
    "a context-less read of Customer sees nothing (RLS is really on)",
    (await prisma.customer.count({ where: { businessId: a.businessId } })) === 0
  );

  console.log("\n  /api/profile/summary — tenant A");
  const resA = await profileSummaryGET(get(a.token, "http://t/api/profile/summary"));
  const A = await resA.json();
  ok("200", resA.status === 200, String(resA.status));
  ok("business name is A's", A.business?.name === a.name, A.business?.name);
  ok("category label is the shared Hebrew label", A.business?.categoryLabel === "בית קפה", A.business?.categoryLabel);
  ok("contacts are A's own", A.business?.phone === "0500000000" && A.business?.email === "a@example.test" && A.business?.location === "1 Synthetic St");
  ok("logo returned", typeof A.business?.logoDataUrl === "string" && A.business.logoDataUrl.startsWith("data:image/png"));
  ok("no website field is invented", !("website" in (A.business ?? {})));
  ok("account is the signed-in user", A.account?.email === a.email);
  ok("active customers = 3 (deactivated excluded)", A.metrics?.activeCustomers === 3, JSON.stringify(A.metrics));
  ok("issued documents = 3 (draft excluded)", A.metrics?.issuedDocuments === 3, JSON.stringify(A.metrics));
  ok(
    "active quotes = 3 (open-ended, today, tomorrow; expired and converted excluded)",
    A.metrics?.activeQuotes === 3,
    JSON.stringify(A.metrics)
  );
  ok("there is no signature-rate metric", Object.keys(A.metrics ?? {}).sort().join(",") === "activeCustomers,activeQuotes,issuedDocuments");
  ok("completion 100% with all 8 filled", A.completion?.percent === 100 && A.completion?.filled === 8 && A.completion?.total === 8, JSON.stringify(A.completion));
  ok("document signature configured", A.documentSignature?.configured === true);
  ok("subscription is unavailable (no plan invented)", JSON.stringify(A.subscription) === JSON.stringify({ status: "unavailable" }));

  console.log("\n  /api/profile/summary — tenant B sees only B");
  const resB = await profileSummaryGET(get(b.token, "http://t/api/profile/summary"));
  const B = await resB.json();
  const bText = JSON.stringify(B);
  ok("200", resB.status === 200, String(resB.status));
  ok("B's counts are B's (2 / 1 / 1)", B.metrics?.activeCustomers === 2 && B.metrics?.issuedDocuments === 1 && B.metrics?.activeQuotes === 1, JSON.stringify(B.metrics));
  ok("no A value appears in B's answer", !bText.includes(a.name) && !bText.includes("a@example.test") && !bText.includes("1 Synthetic St") && !bText.includes(a.email));
  ok("B completion = floor(1/8) = 12% (phone only)", B.completion?.percent === 12 && B.completion?.filled === 1, JSON.stringify(B.completion));
  ok("B has no logo → null (initials fallback)", B.business?.logoDataUrl === null);
  ok("B has no category → null, not a placeholder", B.business?.categoryLabel === null);
  ok("B signature not configured", B.documentSignature?.configured === false);

  console.log("\n  /api/settings/connections-summary");
  const cA = await (await connectionsSummaryGET(get(a.token, "http://t/api/settings/connections-summary"))).json();
  ok(
    "A: WhatsApp 1 · Gmail 1 (revoked excluded) · payments 1 (inactive excluded) · tax authority 0 · lead sources 1 (paused excluded)",
    cA.available === true &&
      cA.breakdown?.whatsapp === 1 &&
      cA.breakdown?.gmail === 1 &&
      cA.breakdown?.payments === 1 &&
      cA.breakdown?.taxAuthority === 0 &&
      cA.breakdown?.leadSources === 1,
    JSON.stringify(cA)
  );
  ok("A: active = 4", cA.active === 4, String(cA.active));
  const cB = await (await connectionsSummaryGET(get(b.token, "http://t/api/settings/connections-summary"))).json();
  ok(
    "B: 0 — a DISCONNECTED WhatsApp and an ACTIVE source the business is not enabled for do not count",
    cB.available === true && cB.active === 0,
    JSON.stringify(cB)
  );

  console.log("\n  authentication");
  ok("profile summary without a token → 401", (await profileSummaryGET(get(null, "http://t/api/profile/summary"))).status === 401);
  ok("connections summary without a token → 401", (await connectionsSummaryGET(get(null, "http://t/api/settings/connections-summary"))).status === 401);
  ok("a forged token → 401", (await profileSummaryGET(get("not-a-token", "http://t/api/profile/summary"))).status === 401);
  const withQuery = await (await profileSummaryGET(get(b.token, `http://t/api/profile/summary?businessId=${a.businessId}`))).json();
  ok("a businessId in the query is ignored — B still gets B", withQuery.business?.name === b.name && withQuery.metrics?.activeCustomers === 2);

  ok("still no ambient tenant context after the requests", getTenantContext() === undefined);

  console.log(`\n  ${pass} passed, ${failures.length} failed`);
  await prisma.$disconnect();
  if (failures.length > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
