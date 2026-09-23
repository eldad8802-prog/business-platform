/**
 * The four remaining suspicious callers, decided by running them.
 *
 * Resembling a previous failure is not evidence, so each group here is put in
 * the posture its real caller has — a governed role, the real policies, and NO
 * ambient tenant context — and then asked what it actually does. Two of the
 * four could in principle be safe; the point is to find out rather than to
 * assume, and the fixtures are chosen so that an empty result cannot look like
 * a correct one:
 *
 *   notifications     real rows for two tenants, then list/count/mark/mark-all
 *   awaiting payment  payment terms of 0 days, which the default of 30 would
 *                     contradict — a silent fallback changes the ANSWER, not
 *                     just a field
 *   pricing           a saved calculation for each tenant
 *   authority         a distinctive VAT number, so "no identity" cannot pass
 *
 * Synthetic data only. No secrets, no Neon, no network.
 *
 * Run: npx tsx app/api/rls-caller-closure.integration.test.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { NextRequest } from "next/server";

import { signAuthToken } from "../../lib/auth-token";
import { tenantTx } from "../../lib/tenant/tenant-tx";
import { getTenantContext } from "../../lib/tenant/context";
import {
  countUnread,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../../lib/notifications/notification-read.service";
import { loadAwaitingPaymentList } from "../../lib/services/billing/collection/awaiting-payment.loader";
import { DEFAULT_PAYMENT_TERMS_DAYS } from "../../lib/services/billing/collection/payment-terms";
import { GET as pricingGET } from "./pricing/calculations/route";

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
const DAY = 86_400_000;

const TENANT_PREDICATE = `"businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int`;
const RLS_TABLES = [
  "Notification",
  "PricingCalculation",
  "BusinessProfile",
  "BillingDocument",
  "BillingPaymentAllocation",
  "Customer",
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

async function assertPosture() {
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

/** Payment terms the default would contradict: 0 days means "due on issue". */
const QA_TERMS_DAYS = 0;

type Tenant = {
  businessId: number;
  token: string;
  notificationIds: number[];
  invoiceId: number;
  vatNumber: string;
};

async function makeTenant(label: string): Promise<Tenant> {
  const business = await prisma.business.create({ data: { name: `caller-${label}-${uniq()}` } });
  const user = await prisma.user.create({
    data: {
      email: `caller-${label}-${uniq()}@example.test`,
      password: "x",
      businessId: business.id,
      role: "USER",
    },
  });
  const vatNumber = `VAT-${label.toUpperCase()}-${uniq()}`;

  const { notificationIds, invoiceId } = await tenantTx(business.id, async (tx) => {
    await tx.businessProfile.create({
      data: {
        businessId: business.id,
        billingLegalName: `Caller Synthetic ${label}`,
        billingBusinessKind: "EXEMPT_DEALER",
        billingTaxId: `TAX-${label.toUpperCase()}`,
        billingVatNumber: vatNumber,
        billingAddress: "1 Synthetic St",
        billingPhone: "0500000000",
        billingEmail: `caller-${label}@example.test`,
        billingPaymentTermsDays: QA_TERMS_DAYS,
      },
    });

    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const n = await tx.notification.create({
        data: {
          businessId: business.id,
          dedupeKey: `caller-${label}-${uniq()}-${i}`,
          domain: "INVENTORY",
          semanticCategory: "LOW_STOCK",
          severity: "INFO",
          entityType: "InventoryItem",
          entityId: i + 1,
          title: `${label} notification ${i}`,
          href: "/inventory",
          reason: "synthetic fixture",
          cooldownHours: 24,
        },
        select: { id: true },
      });
      ids.push(n.id);
    }

    await tx.pricingCalculation.create({
      data: {
        businessId: business.id,
        inputMaterialCost: 10,
        inputLaborMinutes: 60,
        inputHourlyRate: 100,
        inputOverheadPercent: 0,
        laborCost: 100,
        directCost: 110,
        overheadCost: 0,
        fullCost: 110,
        minimumPrice: 120,
        recommendedPrice: 160,
        premiumPrice: 200,
      },
      select: { id: true },
    });

    // Issued five days ago: awaiting under terms of 0 days, NOT awaiting under
    // the default 30. The list is therefore the answer to "were the terms
    // read", not merely "was a field populated".
    const customer = await tx.customer.create({
      data: { businessId: business.id, name: `Caller customer ${label}`, phone: "0500000000" },
      select: { id: true },
    });

    const invoice = await tx.billingDocument.create({
      data: {
        businessId: business.id,
        documentType: "TAX_INVOICE",
        status: "ISSUED",
        documentNumber: 1,
        customerId: customer.id,
        customerNameSnapshot: `Caller customer ${label}`,
        subtotalAmount: D("100.00"),
        vatAmount: D("0"),
        totalAmount: D("100.00"),
        currency: "ILS",
        issuedAt: new Date(Date.now() - 5 * DAY),
      },
      select: { id: true },
    });

    return { notificationIds: ids, invoiceId: invoice.id };
  });

  return { businessId: business.id, token: signAuthToken(user.id, 0), notificationIds, invoiceId, vatNumber };
}

const authed = (token: string, url: string) =>
  new NextRequest(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  } as never);

async function main() {
  await assertPosture();
  await installRls();

  const a = await makeTenant("a");
  const b = await makeTenant("b");

  // ------------------------------------------------------- notifications ---
  const page = await listNotifications(a.businessId, { limit: 20, cursor: null, unreadOnly: false });
  ok("N1 the list returns this tenant's notifications", page.notifications.length === 3, `${page.notifications.length}`);
  ok(
    "N1 and only this tenant's",
    page.notifications.every((n) => a.notificationIds.includes(n.id)),
    JSON.stringify(page.notifications.map((n) => n.id))
  );
  ok("N1 the unread count in the same page is right", page.unreadCount === 3, String(page.unreadCount));

  const unread = await countUnread(a.businessId);
  ok("N2 the standalone unread count agrees", unread === 3, String(unread));

  const markOwn = await markNotificationRead(a.businessId, a.notificationIds[0]!, new Date());
  ok("N3 marking own notification read finds and changes it", markOwn.found && markOwn.changed, JSON.stringify(markOwn));
  ok("N3 the unread count drops", (await countUnread(a.businessId)) === 2);

  // Tenant A pointing at tenant B's id must change nothing, and must not even
  // be able to tell that the row exists.
  const markCross = await markNotificationRead(a.businessId, b.notificationIds[0]!, new Date());
  ok("N4 tenant A cannot mark tenant B's notification", !markCross.changed && !markCross.found, JSON.stringify(markCross));
  ok("N4 tenant B's unread count is untouched", (await countUnread(b.businessId)) === 3);

  const allA = await markAllNotificationsRead(a.businessId, new Date());
  ok("N5 mark-all clears the rest for A", allA === 2, String(allA));
  ok("N5 A has nothing unread left", (await countUnread(a.businessId)) === 0);
  ok("N5 and B still has all three", (await countUnread(b.businessId)) === 3, String(await countUnread(b.businessId)));

  // ------------------------------------------------- awaiting payment ------
  const awaiting = await loadAwaitingPaymentList(a.businessId);
  const ids = awaiting.customers.flatMap((c) => c.invoices.map((i) => i.id));
  console.log(`  awaiting list: ${JSON.stringify(awaiting).slice(0, 220)}`);
  ok(
    `W1 an invoice issued 5 days ago IS awaiting under terms of ${QA_TERMS_DAYS} days`,
    awaiting.customerCount > 0,
    `default terms are ${DEFAULT_PAYMENT_TERMS_DAYS}; an empty list means the profile read was lost`
  );
  ok("W1 and it is this tenant's invoice", ids.includes(a.invoiceId), JSON.stringify(ids));

  const awaitingB = await loadAwaitingPaymentList(b.businessId);
  const idsB = awaitingB.customers.flatMap((c) => c.invoices.map((i) => i.id));
  ok("W2 tenant B sees its own debt", idsB.includes(b.invoiceId), JSON.stringify(idsB));
  ok("W2 and never tenant A's", !idsB.includes(a.invoiceId), JSON.stringify(idsB));

  // ------------------------------------------------------------ pricing ----
  const pRes = await pricingGET(authed(a.token, "http://localhost/api/pricing/calculations") as unknown as Request);
  const pBody = (await pRes.json()) as { calculations?: Array<{ id: number; businessId: number }> } | Array<{ id: number; businessId: number }>;
  const rows = Array.isArray(pBody) ? pBody : (pBody.calculations ?? []);
  ok("C1 the pricing route answers", pRes.status === 200, `status ${pRes.status}`);
  ok("C1 it returns the tenant's saved calculation", rows.length === 1, `${rows.length} rows`);
  ok("C1 and only this tenant's", rows.every((r) => r.businessId === a.businessId), JSON.stringify(rows.map((r) => r.businessId)));

  // ---------------------------------------------------------- authority ----
  // The enclosing `validateAuthorityConnection` needs a stored connection,
  // encryption keys and a network probe, and this mission must not touch any of
  // those. What is proven here is the read it performs, in both postures, with
  // a VAT number distinctive enough that an empty answer cannot pass for one.
  const unscopedIdentity = await prisma.businessProfile.findUnique({
    where: { businessId: a.businessId },
    select: { billingVatNumber: true, billingTaxId: true },
  });
  const scopedIdentity = await tenantTx(a.businessId, (tx) =>
    tx.businessProfile.findUnique({
      where: { businessId: a.businessId },
      select: { billingVatNumber: true, billingTaxId: true },
    })
  );
  console.log(`  authority identity — unscoped: ${JSON.stringify(unscopedIdentity)} | scoped: ${JSON.stringify(scopedIdentity)}`);
  ok(
    "A1 the unscoped identity read returns nothing (the defect)",
    unscopedIdentity === null,
    "if this fails, RLS is not in force and the rest proves nothing"
  );
  ok("A1 the tenant-scoped read returns the real VAT number", scopedIdentity?.billingVatNumber === a.vatNumber);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("RLS CALLER CLOSURE: FAIL");
    process.exit(1);
  }
  console.log("RLS CALLER CLOSURE: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
