/**
 * Integration test — canonical customer service + endpoint parity.
 * Run: npx tsx lib/services/crm/customer.service.test.ts  (needs a dev DB).
 */
import assert from "node:assert/strict";

// Ensure a signing secret exists so the endpoint-parity section can mint tokens.
if (!process.env.AUTH_TOKEN_SECRET || !process.env.AUTH_TOKEN_SECRET.trim()) {
  process.env.AUTH_TOKEN_SECRET = "crm-phase1-test-secret";
}

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { customerService } from "@/lib/services/crm/customer.service";
import { ValidationError, NotFoundError } from "@/lib/errors";
import { signAuthToken } from "@/lib/auth-token";
import { POST as legacyCustomerPost } from "@/app/api/customer/route";
import { POST as billingCustomerPost } from "@/app/api/billing/customers/route";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function createBusinessWithUser(label: string) {
  const business = await prisma.business.create({
    data: {
      name: `CRM P1 ${label} ${runId}`,
      users: {
        create: {
          email: `crm-p1-${label}-${runId}@example.test`,
          password: "test-password",
          name: "CRM Test User",
        },
      },
    },
    include: { users: true },
  });
  return { businessId: business.id, userId: business.users[0].id };
}

async function main() {
  const a = await createBusinessWithUser("A");
  const b = await createBusinessWithUser("B");

  try {
    // ===== 1. CREATE + NORMALIZATION =====
    const created = await customerService.createCustomer({
      businessId: a.businessId,
      name: "  Dana Levi  ",
      phone: "050-111-2222",
      email: "  dana@example.test ",
      city: "  תל אביב ",
      notes: "  לקוח קבוע  ",
    });
    assert.equal(created.name, "Dana Levi", "name trimmed");
    assert.equal(created.phone, "972501112222", "phone canonicalized");
    assert.equal(created.email, "dana@example.test", "email trimmed");
    assert.equal(created.city, "תל אביב", "city trimmed");
    assert.equal(created.notes, "לקוח קבוע", "notes trimmed");

    // ===== 2. GET =====
    const fetched = await customerService.getCustomer({
      businessId: a.businessId,
      customerId: created.id,
    });
    assert.equal(fetched.id, created.id, "get returns created customer");

    // ===== 3. VALIDATION =====
    await assert.rejects(
      () => customerService.createCustomer({ businessId: a.businessId, name: "   " }),
      ValidationError,
      "empty name rejected"
    );

    // ===== 4. UPDATE BASICS (partial + re-normalize + clear) =====
    const updated = await customerService.updateCustomerBasics({
      businessId: a.businessId,
      customerId: created.id,
      phone: "0524445566",
      notes: null,
    });
    assert.equal(updated.phone, "972524445566", "phone re-normalized on update");
    assert.equal(updated.notes, null, "notes cleared");
    assert.equal(updated.name, "Dana Levi", "untouched field preserved");

    // ===== 5. LIST + SEARCH =====
    await customerService.createCustomer({
      businessId: a.businessId,
      name: "Yossi Cohen",
      phone: "0501234567",
    });
    const recent = await customerService.listCustomers({
      businessId: a.businessId,
      sort: "recent",
    });
    assert.equal(recent.length, 2, "list returns both customers of business A");

    const byName = await customerService.listCustomers({
      businessId: a.businessId,
      query: "yossi",
    });
    assert.ok(
      byName.some((c) => c.name === "Yossi Cohen"),
      "case-insensitive name search"
    );

    // ===== 6. TENANT ISOLATION =====
    const bCustomer = await customerService.createCustomer({
      businessId: b.businessId,
      name: "Business B Customer",
    });
    const bList = await customerService.listCustomers({ businessId: b.businessId });
    assert.equal(bList.length, 1, "business B sees only its own customer");

    await assert.rejects(
      () =>
        customerService.getCustomer({
          businessId: b.businessId,
          customerId: created.id,
        }),
      NotFoundError,
      "cannot read another business's customer"
    );
    await assert.rejects(
      () =>
        customerService.updateCustomerBasics({
          businessId: b.businessId,
          customerId: created.id,
          name: "hijack",
        }),
      NotFoundError,
      "cannot update another business's customer"
    );
    assert.ok(bCustomer.id, "business B customer created");

    // ===== 7. ENDPOINT PARITY — both legacy routes share the same service =====
    // Same raw phone through each endpoint, but in SEPARATE businesses so the
    // (businessId, phone) unique constraint doesn't collide — the identical
    // normalized output is exactly what proves both delegate to one service.
    const tokenA = signAuthToken(a.userId);
    const tokenB = signAuthToken(b.userId);
    const messyPhone = "054-777-8899"; // → 972547778899
    const expectedPhone = "972547778899";

    const legacyRes = await legacyCustomerPost(
      new NextRequest("http://localhost/api/customer", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({ name: "Parity Legacy", phone: messyPhone }),
      })
    );
    const legacyJson = await legacyRes.json();

    const billingRes = await billingCustomerPost(
      new NextRequest("http://localhost/api/billing/customers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenB}`,
        },
        body: JSON.stringify({ name: "Parity Billing", phone: messyPhone }),
      })
    );
    const billingJson = await billingRes.json();

    assert.equal(legacyRes.status, 201, "legacy create returns 201");
    assert.equal(billingRes.status, 201, "billing create returns 201");
    assert.equal(
      legacyJson.phone,
      expectedPhone,
      "legacy endpoint normalizes phone via shared service"
    );
    assert.equal(
      billingJson.customer.phone,
      expectedPhone,
      "billing endpoint normalizes phone via shared service"
    );
    assert.equal(
      legacyJson.phone,
      billingJson.customer.phone,
      "both endpoints produce identical normalized phone"
    );
    // Billing response shape preserved: identity subset only (no notes/taxId).
    assert.deepEqual(
      Object.keys(billingJson.customer).sort(),
      ["city", "email", "id", "name", "phone"],
      "billing response shape unchanged"
    );

    console.log("customer.service.test.ts: ok");
  } finally {
    await prisma.customer.deleteMany({
      where: { businessId: { in: [a.businessId, b.businessId] } },
    });
    await prisma.business.deleteMany({
      where: { id: { in: [a.businessId, b.businessId] } },
    });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
