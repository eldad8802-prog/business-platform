// C1 client test: updateCustomer wire contract (URL/method/payload + error mapping).
// Framework-free; stubs global fetch. Run: npx tsx lib/api/customers-update.test.ts

import assert from "node:assert/strict";
import { updateCustomer } from "@/lib/api/customers";

async function main() {
  const realFetch = globalThis.fetch;
  let lastUrl = "";
  let lastInit: RequestInit | undefined;
  function stub(body: unknown, status = 200) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      lastUrl = String(input);
      lastInit = init;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  try {
    // URL, method, payload, and returned customer.
    stub({ customer: { id: 5, name: "עודכן", phone: "972501112222", email: null, city: "חיפה", legalName: null, taxId: null, taxIdType: null, notes: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" } });
    const res = await updateCustomer(5, { name: "עודכן", phone: "0501112222", city: "חיפה" });
    assert.equal(lastUrl, "/api/customers/5", "URL by id");
    assert.equal(lastInit?.method, "PATCH", "method PATCH");
    assert.deepEqual(JSON.parse(String(lastInit?.body)), { name: "עודכן", phone: "0501112222", city: "חיפה" }, "payload forwarded");
    assert.equal(res.city, "חיפה", "returns updated card-customer");

    // 401 → UNAUTHORIZED
    stub({ error: "unauthorized" }, 401);
    await assert.rejects(() => updateCustomer(5, { name: "x" }), (e) => e instanceof Error && e.message === "UNAUTHORIZED", "401 → UNAUTHORIZED");

    // 404 → NOT_FOUND
    stub({ error: "Customer not found" }, 404);
    await assert.rejects(() => updateCustomer(5, { name: "x" }), (e) => e instanceof Error && e.message === "NOT_FOUND", "404 → NOT_FOUND");

    // 409 validation/conflict → surfaces the server's friendly message
    stub({ error: "מספר הטלפון כבר משויך ללקוח אחר בעסק.", code: "PHONE_TAKEN" }, 409);
    await assert.rejects(() => updateCustomer(5, { phone: "0501112222" }), (e) => e instanceof Error && /טלפון/.test(e.message), "409 → friendly message shown");

    console.log("customers-update.test.ts: ok");
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
