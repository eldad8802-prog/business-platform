/**
 * C2 — Customer Lifecycle. Integration test: service list filter + isActive update,
 * plus the canonical routes (GET /api/customers status filter, PATCH isActive).
 * Run: npx tsx --env-file=.env lib/services/crm/customer-lifecycle.c2.test.ts  (dev DB)
 */
import assert from "node:assert/strict";

if (!process.env.AUTH_TOKEN_SECRET || !process.env.AUTH_TOKEN_SECRET.trim()) {
  process.env.AUTH_TOKEN_SECRET = "crm-c2-test-secret";
}

import { NextRequest } from "next/server";
import { ConversationChannel } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { customerService } from "@/lib/services/crm/customer.service";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { signAuthToken } from "@/lib/auth-token";
import { GET as listCustomers } from "@/app/api/customers/route";
import { PATCH as patchCustomer } from "@/app/api/customers/[id]/route";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function biz(label: string) {
  const b = await prisma.business.create({
    data: {
      name: `C2 ${label} ${runId}`,
      users: { create: { email: `c2-${label}-${runId}@example.test`, password: "x", name: "U" } },
    },
    include: { users: true },
  });
  return { businessId: b.id, userId: b.users[0].id };
}

function listReq(token: string, status?: string) {
  const url = new URL("http://localhost/api/customers");
  if (status !== undefined) url.searchParams.set("status", status);
  return listCustomers(
    new NextRequest(url, { method: "GET", headers: { authorization: `Bearer ${token}` } })
  );
}
function patchReq(id: number, token: string, body: unknown) {
  return patchCustomer(
    new NextRequest(`http://localhost/api/customers/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(id) }) }
  );
}

async function main() {
  const a = await biz("A");
  const b = await biz("B");
  const tokenA = signAuthToken(a.userId);
  const tokenB = signAuthToken(b.userId);

  try {
    const active = await customerService.createCustomer({ businessId: a.businessId, name: "לקוח פעיל", phone: "0501112222" });
    const toDeactivate = await customerService.createCustomer({ businessId: a.businessId, name: "לקוח להשבתה", phone: "0503334444", email: "keep@example.test", city: "חיפה", notes: "הערה" });
    // a real related record to prove deactivation touches nothing but the flag
    await prisma.conversation.create({ data: { businessId: a.businessId, customerId: toDeactivate.id, channel: ConversationChannel.WHATSAPP } });

    // ===== 6: deactivate flips only isActive =====
    const deactivated = await customerService.setCustomerActiveStatus({ businessId: a.businessId, customerId: toDeactivate.id, isActive: false });
    assert.equal(deactivated.isActive, false, "6: isActive=false");
    assert.equal(deactivated.name, "לקוח להשבתה", "6: name unchanged");
    assert.equal(deactivated.email, "keep@example.test", "6: email unchanged");
    assert.equal(deactivated.city, "חיפה", "6: city unchanged");
    assert.equal(deactivated.notes, "הערה", "6: notes unchanged");
    assert.equal(deactivated.phone, "972503334444", "6: phone unchanged");

    // ===== 10-11: related records survive deactivation =====
    const convCount = await prisma.conversation.count({ where: { businessId: a.businessId, customerId: toDeactivate.id } });
    assert.equal(convCount, 1, "10: conversation still linked after deactivation");
    const stillThere = await customerService.getCustomer({ businessId: a.businessId, customerId: toDeactivate.id });
    assert.ok(stillThere, "10: inactive customer still accessible by id");

    // ===== 2-4: service list filters =====
    const onlyActive = await customerService.listCustomers({ businessId: a.businessId, status: "active" });
    assert.ok(onlyActive.every((c) => c.isActive), "2: active → only isActive true");
    assert.ok(onlyActive.some((c) => c.id === active.id) && !onlyActive.some((c) => c.id === toDeactivate.id), "2: correct membership");
    const onlyInactive = await customerService.listCustomers({ businessId: a.businessId, status: "inactive" });
    assert.ok(onlyInactive.every((c) => !c.isActive), "3: inactive → only isActive false");
    assert.ok(onlyInactive.some((c) => c.id === toDeactivate.id), "3: contains deactivated");
    const all = await customerService.listCustomers({ businessId: a.businessId, status: "all" });
    assert.ok(all.some((c) => c.id === active.id) && all.some((c) => c.id === toDeactivate.id), "4: all → both");

    // ===== 1: default (no status) = all (backward compatible for non-CRM callers) =====
    const dflt = await customerService.listCustomers({ businessId: a.businessId });
    assert.equal(dflt.length, all.length, "1: default list = all (unchanged for Billing/legacy)");

    // ===== 7: reactivate =====
    const reactivated = await customerService.setCustomerActiveStatus({ businessId: a.businessId, customerId: toDeactivate.id, isActive: true });
    assert.equal(reactivated.isActive, true, "7: reactivate works");
    await customerService.setCustomerActiveStatus({ businessId: a.businessId, customerId: toDeactivate.id, isActive: false }); // restore for route tests

    // ===== ROUTES =====
    // GET status filters + toListRow includes isActive
    const gaJson = await (await listReq(tokenA, "active")).json();
    assert.ok(gaJson.customers.every((c: { isActive: boolean }) => c.isActive === true), "route GET active");
    assert.ok(gaJson.customers.every((c: Record<string, unknown>) => "isActive" in c), "route GET row exposes isActive");
    const giJson = await (await listReq(tokenA, "inactive")).json();
    assert.ok(giJson.customers.every((c: { isActive: boolean }) => c.isActive === false), "route GET inactive");
    const glRes = await listReq(tokenA, "all");
    assert.equal(glRes.status, 200, "route GET all 200");

    // 5: invalid filter → 400 validation
    const bogus = await listReq(tokenA, "banana");
    assert.equal(bogus.status, 400, "5: invalid status → 400");

    // PATCH isActive via route
    const pRes = await patchReq(toDeactivate.id, tokenA, { isActive: true });
    const pJson = await pRes.json();
    assert.equal(pRes.status, 200, "route PATCH isActive 200");
    assert.equal(pJson.customer.isActive, true, "route PATCH returns updated isActive");

    // route: lifecycle + basics in one request → 400 (no non-atomic multi-service update)
    const mixed = await patchReq(toDeactivate.id, tokenA, { isActive: true, name: "לא אמור לעבור" });
    assert.equal(mixed.status, 400, "route: mixed lifecycle+basics → 400");
    // route: edit-only request still routes to basics (isActive untouched)
    const editOnly = await patchReq(toDeactivate.id, tokenA, { city: "אשדוד" });
    const editJson = await editOnly.json();
    assert.equal(editOnly.status, 200, "route: basics-only edit still works");
    assert.equal(editJson.customer.city, "אשדוד", "route: basics edit applied");

    // 8: non-existent → 404
    assert.equal((await patchReq(999999999, tokenA, { isActive: false })).status, 404, "8: non-existent → 404");
    // 9: cross-tenant → same 404
    assert.equal((await patchReq(active.id, tokenB, { isActive: false })).status, 404, "9: cross-tenant → 404");

    // service-level tenant guard
    await assert.rejects(
      () => customerService.setCustomerActiveStatus({ businessId: b.businessId, customerId: active.id, isActive: false }),
      NotFoundError,
      "cross-tenant service update → NotFound"
    );
    // invalid isActive type → validation
    await assert.rejects(
      () => customerService.setCustomerActiveStatus({ businessId: a.businessId, customerId: active.id, isActive: "nope" as unknown as boolean }),
      ValidationError,
      "invalid isActive type → ValidationError"
    );

    console.log("customer-lifecycle.c2.test.ts: ok");
  } finally {
    await prisma.conversation.deleteMany({ where: { businessId: { in: [a.businessId, b.businessId] } } });
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
