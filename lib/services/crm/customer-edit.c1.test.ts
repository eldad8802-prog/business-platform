/**
 * C1 — Customer Edit. Integration test for the canonical edit path:
 * service (updateCustomerBasics) + the new PATCH /api/customers/[id] route.
 * Run: npx tsx --env-file=.env lib/services/crm/customer-edit.c1.test.ts  (dev DB)
 */
import assert from "node:assert/strict";

if (!process.env.AUTH_TOKEN_SECRET || !process.env.AUTH_TOKEN_SECRET.trim()) {
  process.env.AUTH_TOKEN_SECRET = "crm-c1-test-secret";
}

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { customerService } from "@/lib/services/crm/customer.service";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { signAuthToken } from "@/lib/auth-token";
import { PATCH as patchCustomer } from "@/app/api/customers/[id]/route";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function biz(label: string) {
  const b = await prisma.business.create({
    data: {
      name: `C1 ${label} ${runId}`,
      users: {
        create: { email: `c1-${label}-${runId}@example.test`, password: "x", name: "U" },
      },
    },
    include: { users: true },
  });
  return { businessId: b.id, userId: b.users[0].id };
}

function patchReq(id: number, token: string | null, body: unknown) {
  return patchCustomer(
    new NextRequest(`http://localhost/api/customers/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(id) }) }
  );
}

async function main() {
  const a = await biz("A");
  const b = await biz("B");
  const tokenA = signAuthToken(a.userId);

  try {
    const c = await customerService.createCustomer({
      businessId: a.businessId,
      name: "לקוח מקורי",
      phone: "0501112222",
      email: "orig@example.test",
      city: "חיפה",
      notes: "הערה מקורית",
    });

    // ===== SERVICE: 1-5 field updates =====
    let u = await customerService.updateCustomerBasics({ businessId: a.businessId, customerId: c.id, name: "שם חדש" });
    assert.equal(u.name, "שם חדש", "1: name updated");
    u = await customerService.updateCustomerBasics({ businessId: a.businessId, customerId: c.id, phone: "0523334444" });
    assert.equal(u.phone, "972523334444", "2: phone updated + normalized");
    u = await customerService.updateCustomerBasics({ businessId: a.businessId, customerId: c.id, email: "new@example.test" });
    assert.equal(u.email, "new@example.test", "3: email updated");
    u = await customerService.updateCustomerBasics({ businessId: a.businessId, customerId: c.id, city: "תל אביב" });
    assert.equal(u.city, "תל אביב", "4: city updated");
    u = await customerService.updateCustomerBasics({ businessId: a.businessId, customerId: c.id, notes: "הערה חדשה" });
    assert.equal(u.notes, "הערה חדשה", "5: notes updated");

    // ===== 6: partial update does NOT clear unsent fields =====
    assert.equal(u.name, "שם חדש", "6: name preserved");
    assert.equal(u.email, "new@example.test", "6: email preserved");
    assert.equal(u.city, "תל אביב", "6: city preserved");

    // ===== 7: not found =====
    await assert.rejects(
      () => customerService.updateCustomerBasics({ businessId: a.businessId, customerId: 999999999, name: "x" }),
      NotFoundError,
      "7: non-existent customer → NotFound"
    );

    // ===== 8: cross-tenant → same not-found (no existence disclosure) =====
    await assert.rejects(
      () => customerService.updateCustomerBasics({ businessId: b.businessId, customerId: c.id, name: "hijack" }),
      NotFoundError,
      "8: another business's customer → NotFound"
    );

    // ===== 9: duplicate phone → friendly ConflictError, NO partial update =====
    const other = await customerService.createCustomer({ businessId: a.businessId, name: "לקוח אחר", phone: "0509998888" });
    await assert.rejects(
      () => customerService.updateCustomerBasics({ businessId: a.businessId, customerId: other.id, name: "שם-שלא-יישמר", phone: "0523334444" }),
      (e) => e instanceof ConflictError && e.statusCode === 409 && /טלפון/.test(e.message),
      "9: duplicate phone → ConflictError (friendly, 409)"
    );
    const otherAfter = await customerService.getCustomer({ businessId: a.businessId, customerId: other.id });
    assert.equal(otherAfter.name, "לקוח אחר", "9: name NOT partially updated on conflict");
    assert.equal(otherAfter.phone, "972509998888", "9: phone NOT changed on conflict");

    // ===== 10: same phone in ANOTHER business is allowed =====
    const bCustomer = await customerService.createCustomer({ businessId: b.businessId, name: "B customer" });
    const bUpdated = await customerService.updateCustomerBasics({ businessId: b.businessId, customerId: bCustomer.id, phone: "0523334444" });
    assert.equal(bUpdated.phone, "972523334444", "10: same phone allowed in different business");

    // ===== PATCH ROUTE (direct handler) =====
    const okRes = await patchReq(c.id, tokenA, { city: "ירושלים" });
    const okJson = await okRes.json();
    assert.equal(okRes.status, 200, "route: 200 on success");
    assert.equal(okJson.customer.city, "ירושלים", "route: returns updated card-customer");
    assert.deepEqual(
      Object.keys(okJson.customer).sort(),
      ["city", "createdAt", "email", "id", "isActive", "legalName", "name", "notes", "phone", "taxId", "taxIdType", "updatedAt"],
      "route: card-customer projection shape"
    );

    // route: unauthorized
    const noAuth = await patchReq(c.id, null, { name: "x" });
    assert.equal(noAuth.status, 401, "route: 401 without auth");

    // route: cross-tenant → 404 (tenant-safe)
    const tokenB = signAuthToken(b.userId);
    const cross = await patchReq(c.id, tokenB, { name: "hijack" });
    assert.equal(cross.status, 404, "route: cross-tenant → 404");

    // route: duplicate phone → 409 friendly, NOT 500.
    // `c` currently holds 0523334444 (set earlier); moving `other` onto it collides.
    const dupRes = await patchReq(other.id, tokenA, { phone: "0523334444" });
    const dupJson = await dupRes.json();
    assert.equal(dupRes.status, 409, "route: duplicate phone → 409 (not 500)");
    assert.ok(/טלפון/.test(dupJson.error), "route: friendly Hebrew conflict message");

    console.log("customer-edit.c1.test.ts: ok");
  } finally {
    await prisma.customer.deleteMany({ where: { businessId: { in: [a.businessId, b.businessId] } } });
    await prisma.business.deleteMany({ where: { id: { in: [a.businessId, b.businessId] } } });
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exitCode = 1;
});
