// C2 client test: getCustomers sends the lifecycle filter; updateCustomer sends isActive.
// Framework-free; stubs global fetch. Run: npx tsx lib/api/customers-lifecycle.test.ts

import assert from "node:assert/strict";
import { getCustomers, setCustomerActiveStatus } from "@/lib/api/customers";

async function main() {
  const realFetch = globalThis.fetch;
  let lastUrl = "";
  let lastInit: RequestInit | undefined;
  function stub(body: unknown, status = 200) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      lastUrl = String(input);
      lastInit = init;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  }

  try {
    // 12: default filter → active
    stub({ customers: [] });
    await getCustomers();
    assert.ok(/[?&]status=active(&|$)/.test(lastUrl), `12: default sends status=active (got ${lastUrl})`);

    // 12: explicit inactive + query
    stub({ customers: [] });
    await getCustomers({ query: "דנה", status: "inactive" });
    assert.ok(/[?&]status=inactive(&|$)/.test(lastUrl), "12: sends status=inactive");
    assert.ok(/[?&]q=/.test(lastUrl), "12: sends query");

    // list row exposes isActive
    stub({ customers: [{ id: 1, name: "A", phone: null, email: null, city: null, isActive: false }] });
    const rows = await getCustomers({ status: "all" });
    assert.equal(rows[0].isActive, false, "list row carries isActive");

    // 15: setCustomerActiveStatus sends { isActive } only (dedicated lifecycle path)
    stub({ customer: { id: 5, name: "A", phone: null, email: null, city: null, legalName: null, taxId: null, taxIdType: null, notes: null, isActive: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" } });
    const updated = await setCustomerActiveStatus(5, false);
    assert.equal(lastUrl, "/api/customers/5", "15: URL by id");
    assert.equal(lastInit?.method, "PATCH", "15: PATCH");
    assert.deepEqual(JSON.parse(String(lastInit?.body)), { isActive: false }, "15: payload is isActive only");
    assert.equal(updated.isActive, false, "15: returns updated isActive");

    console.log("customers-lifecycle.test.ts: ok");
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
