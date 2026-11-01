/**
 * Runtime-role compatibility under the Production posture — four reads/writes that were
 * written for a BYPASSRLS connection and broke when the runtime role lost it.
 *
 * WHAT WAS BROKEN (each reproduced on main as a NOSUPERUSER / NOBYPASSRLS runtime role)
 *
 *   Q1  The quote PDF read `Business` + nested `BusinessProfile` on the bare client.
 *       BusinessProfile is FORCE RLS, so the profile came back `null` and the quote was
 *       printed with no legal name, tax id, VAT number, logo or signature.
 *   O1  `GET /api/offers` used `include: { issuingBusiness: { include: { profile } } }`,
 *       which selects every `Business` column. The runtime role is column-granted on
 *       Business (20260908180000_d2_user_business_privilege_narrowing), so the whole query
 *       was refused: "permission denied for table Business".
 *   C1  The public coupon surfaces (wizard identity, home feed, coupon detail page) read
 *       the issuer's profile on the bare client → city / address / phone / hours / distance
 *       all missing, silently.
 *   U1  `POST /api/customer` inserted with no tenant context → the Customer INSERT policy
 *       refused the row → 500.
 *
 * Honesty rules, as in every RLS proof here:
 *   1. POLICIES / GRANTS are installed from the migrations' own definitions (a `db push`
 *      lab has neither), and two CONTROLS prove they bite before anything else is asserted.
 *   2. IDENTITY: the test refuses to run as a role that bypasses RLS.
 *   3. AMBIENT CONTEXT: services and routes are called with NO tenant context.
 * The Business column narrowing is applied to the runtime login only if it holds a
 * table-level SELECT, and that SELECT is restored at the end so later steps are unaffected.
 *
 * Synthetic data only. No secrets, no Neon, no network.
 *
 * env: DATABASE_URL (runtime role), RLS_ADMIN_URL (owner — installs policies and seeds),
 *      AUTH_TOKEN_SECRET, and the auth plane as the job configures it.
 * Run: npx tsx app/api/rls-runtime-compat.integration.test.ts
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../../lib/auth-token";
import { getTenantContext } from "../../lib/tenant/context";
import { loadQuoteBusiness } from "../../lib/services/billing/quote-pdf.service";
import { getOffersByBusiness } from "../../lib/services/offer.service";
import { getCouponBusinessIdentity } from "../../lib/services/revenue/coupon-business-identity.service";
import { getActiveCoupons } from "../../lib/services/revenue/active-coupons.service";
import { getPublicCouponDetails } from "../../lib/services/revenue/coupon-details-public.service";
import { GET as legacyCustomerGET, POST as legacyCustomerPOST } from "./customer/route";

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
const TENANT = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;
/** 20260908180000_d2_user_business_privilege_narrowing — the runtime's Business columns. */
const BUSINESS_RUNTIME_COLUMNS = `"id", "name", "createdAt", "deletionRequestedAt", "deletedAt"`;

function adminClient(): PrismaClient {
  const url = process.env.RLS_ADMIN_URL;
  if (!url) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set — cannot install the posture under test");
    process.exit(1);
  }
  return new PrismaClient({ datasourceUrl: url });
}

async function runtimeRole(): Promise<string> {
  const [row] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  connected as: ${row?.who} (superuser=${row?.rolsuper}, bypassrls=${row?.rolbypassrls})`);
  if (!row || row.rolsuper || row.rolbypassrls) {
    console.log("  [FAIL] this role bypasses RLS — nothing below would prove anything");
    process.exit(1);
  }
  ok("no ambient tenant context, as in a real request", getTenantContext() === undefined);
  return row.who;
}

/** Installs the migrations' policies; narrows Business for the login if it has table SELECT. */
async function installPosture(admin: PrismaClient, role: string): Promise<() => Promise<void>> {
  // BusinessProfile — 20260825120000_d2_p7_wave1_businessprofile_rls (one ALL policy).
  await admin.$executeRawUnsafe(`ALTER TABLE "BusinessProfile" ENABLE ROW LEVEL SECURITY`);
  await admin.$executeRawUnsafe(`ALTER TABLE "BusinessProfile" FORCE ROW LEVEL SECURITY`);
  await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS p7w1_tenant ON "BusinessProfile"`);
  await admin.$executeRawUnsafe(
    `CREATE POLICY p7w1_tenant ON "BusinessProfile" USING (${TENANT}) WITH CHECK (${TENANT})`
  );
  // Customer — 20260902120000_d2_cutover2b_pilot_tenant_rls (per command, no DELETE).
  await admin.$executeRawUnsafe(`ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY`);
  await admin.$executeRawUnsafe(`ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY`);
  for (const [name, sql] of [
    ["p7pilot_tenant_read", `FOR SELECT USING (${TENANT})`],
    ["p7pilot_tenant_insert", `FOR INSERT WITH CHECK (${TENANT})`],
    ["p7pilot_tenant_update", `FOR UPDATE USING (${TENANT}) WITH CHECK (${TENANT})`],
  ] as const) {
    await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS ${name} ON "Customer"`);
    await admin.$executeRawUnsafe(`CREATE POLICY ${name} ON "Customer" ${sql}`);
  }

  const [grant] = (await admin.$queryRawUnsafe(
    `SELECT has_table_privilege($1, 'public."Business"', 'SELECT') AS has`,
    role
  )) as Array<{ has: boolean }>;
  if (!grant?.has) return async () => {};
  // A db-push lab granted the login SELECT on everything; Production grants five columns.
  await admin.$executeRawUnsafe(`REVOKE SELECT ON "Business" FROM "${role}"`);
  await admin.$executeRawUnsafe(`GRANT SELECT (${BUSINESS_RUNTIME_COLUMNS}) ON "Business" TO "${role}"`);
  return async () => {
    await admin.$executeRawUnsafe(`GRANT SELECT ON "Business" TO "${role}"`);
  };
}

type Tenant = {
  businessId: number;
  userId: number;
  token: string;
  city: string;
  phone: string;
  legalName: string;
  offerId: number;
  couponPublicId: string;
};

async function seedTenant(admin: PrismaClient, label: string, city: string): Promise<Tenant> {
  const business = await admin.business.create({ data: { name: `rls-rc-${label}-${uniq()}` } });
  const phone = `050-${label === "A" ? "1111111" : "2222222"}`;
  const legalName = `${label} בע״מ ${uniq()}`;
  await admin.businessProfile.create({
    data: {
      businessId: business.id,
      city,
      billingAddress: `${city} 1`,
      billingPhone: phone,
      billingLegalName: legalName,
      billingTaxId: label === "A" ? "511111111" : "522222222",
      category: "קפה",
      openingHours: "א׳–ה׳ 8:00–18:00",
      latitude: label === "A" ? 32.794 : 29.557,
      longitude: label === "A" ? 34.989 : 34.951,
    },
  });
  const user = await admin.user.create({
    data: { email: `rls-rc-${label}-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER" },
  });
  const offer = await admin.offer.create({
    data: {
      issuingBusinessId: business.id,
      title: `הצעה ${label}`,
      customerBenefitText: "10% הנחה",
      validUntil: new Date(Date.now() + 30 * 864e5),
    },
  });
  const coupon = await admin.coupon.create({
    data: {
      offerId: offer.id,
      issuingBusinessId: business.id,
      token: `rls-rc-t-${label}-${uniq()}`,
      qrValue: `rls-rc-q-${label}-${uniq()}`,
      expiresAt: new Date(Date.now() + 30 * 864e5),
    },
  });
  return {
    businessId: business.id,
    userId: user.id,
    token: signAuthToken(user.id),
    city,
    phone,
    legalName,
    offerId: offer.id,
    couponPublicId: coupon.publicId,
  };
}

function authed(token: string, url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function refused(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function main() {
  console.log("runtime-role compatibility (quote PDF, offers, public coupons, legacy customer POST)");
  const role = await runtimeRole();
  const admin = adminClient();
  const restore = await installPosture(admin, role);
  try {
    const a = await seedTenant(admin, "A", "חיפה");
    const b = await seedTenant(admin, "B", "אילת");

    // ── controls: the posture under test actually bites ───────────────────────
    const bareProfile = await prisma.businessProfile.findUnique({ where: { businessId: a.businessId } });
    ok("CONTROL BusinessProfile is invisible on the bare client (FORCE RLS active)", bareProfile === null);
    const colDenied = await refused(() =>
      prisma.business.findUnique({ where: { id: a.businessId }, select: { id: true, updatedAt: true } })
    );
    ok("CONTROL a non-granted Business column is refused (column grant active)", !!colDenied && /permission denied/i.test(colDenied), colDenied ?? "not refused");

    // ── Q1 quote PDF issuer identity ──────────────────────────────────────────
    const qa = await loadQuoteBusiness(a.businessId);
    ok("Q1 quote business loads with its profile", qa?.profile?.billingLegalName === a.legalName, JSON.stringify(qa?.profile ?? null));
    ok("Q1 quote carries the issuer's own tax id", qa?.profile?.billingTaxId === "511111111");
    const qb = await loadQuoteBusiness(b.businessId);
    ok("Q1 each business gets its own identity (no cross-tenant read)", qb?.profile?.billingLegalName === b.legalName && qb?.profile?.billingLegalName !== a.legalName);
    ok("Q1 leaves no tenant context behind", getTenantContext() === undefined);

    // ── O1 GET /api/offers service ────────────────────────────────────────────
    const offersErr = await refused(() => getOffersByBusiness(a.businessId));
    ok("O1 offers list is not refused", offersErr === null, offersErr ?? "");
    const offers = offersErr ? [] : await getOffersByBusiness(a.businessId);
    ok("O1 returns only the caller's own offers", offers.length >= 1 && offers.every((o) => o.issuingBusinessId === a.businessId));
    const issuer = offers[0]?.issuingBusiness as Record<string, unknown> | undefined;
    ok("O1 issuer profile is present (city used by the coupon list)", (issuer?.profile as { city?: string } | null)?.city === a.city);
    ok("O1 issuer carries only granted Business columns", !!issuer && !("updatedAt" in issuer) && !("archivedAt" in issuer) && "name" in issuer);

    // ── C1 public coupon surfaces ─────────────────────────────────────────────
    const identity = await getCouponBusinessIdentity(a.businessId);
    ok("C1 wizard identity shows the business's city", identity.city === a.city, JSON.stringify(identity));
    ok("C1 wizard no longer reports filled fields as missing", !identity.incomplete.includes("city") && !identity.incomplete.includes("address"));

    const feed = await getActiveCoupons({ limit: 200 });
    const cardA = feed.find((c) => c.business.id === a.businessId);
    const cardB = feed.find((c) => c.business.id === b.businessId);
    ok("C1 home feed: business A shows its own city and phone", cardA?.business.city === a.city && cardA?.business.phone === a.phone, JSON.stringify(cardA?.business ?? null));
    ok("C1 home feed: business B shows its own city and phone", cardB?.business.city === b.city && cardB?.business.phone === b.phone, JSON.stringify(cardB?.business ?? null));
    const near = await getActiveCoupons({ limit: 200, near: { lat: 32.79, lng: 34.99 } });
    ok("C1 home feed: distance is computed again from the profile's geo", typeof near.find((c) => c.business.id === a.businessId)?.distanceLabel === "string");
    ok("C1 home feed never exposes token or qrValue", !JSON.stringify(feed).includes("rls-rc-t-") && !JSON.stringify(feed).includes("rls-rc-q-"));

    const detail = await getPublicCouponDetails(a.couponPublicId);
    ok("C1 coupon page shows the issuer's city, address and hours", detail.business.city === a.city && detail.business.address === `${a.city} 1` && !!detail.business.openingHours, JSON.stringify(detail.business));
    ok("C1 coupon page shows A's details, not B's", detail.business.phone === a.phone && detail.business.id === a.businessId);
    ok("C1 leaves no tenant context behind", getTenantContext() === undefined);

    // ── U1 legacy POST /api/customer ──────────────────────────────────────────
    const name = `לקוח ${uniq()}`;
    const res = await legacyCustomerPOST(authed(a.token, "http://localhost/api/customer", { method: "POST", body: { name, businessId: b.businessId } }) as never);
    const created = (await res.json()) as { id?: number; businessId?: number; name?: string };
    ok("U1 legacy customer POST answers 201", res.status === 201, `status ${res.status} ${JSON.stringify(created)}`);
    ok("U1 the row belongs to the caller's business — the body's businessId is ignored", created.businessId === a.businessId);
    const listA = (await (await legacyCustomerGET(authed(a.token, "http://localhost/api/customer") as never)).json()) as Array<{ id: number }>;
    const listB = (await (await legacyCustomerGET(authed(b.token, "http://localhost/api/customer") as never)).json()) as Array<{ id: number }>;
    ok("U1 the new customer is listed for its business", listA.some((c) => c.id === created.id));
    ok("U1 and is invisible to the other business", !listB.some((c) => c.id === created.id));
  } finally {
    await restore();
    await admin.$disconnect();
    await prisma.$disconnect();
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
