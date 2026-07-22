// S4-P5 unit tests for the supplier purchase-history section logic.
// Framework-free (node:assert) — the repo has no React/DOM test runner, so these
// cover the pure view helpers + the client wrapper (via a stubbed global fetch).
// Render-only behaviors (skeleton visible, error keeps the card alive, Notes/
// Attachments intact) are verified by the live Dev smoke, documented in the report.
// Run: npx tsx lib/inventory/supplier-purchase-history-view.test.ts

import assert from "node:assert/strict";
import {
  canLoadMore,
  formatLineCount,
  formatPurchaseDate,
  mergePurchaseOrderItems,
  statusBadge,
} from "@/lib/inventory/supplier-purchase-history-view";
import {
  getSupplierPurchaseHistory,
  type SupplierPurchaseOrderItem,
} from "@/lib/api/suppliers";

function item(id: number, over: Partial<SupplierPurchaseOrderItem> = {}): SupplierPurchaseOrderItem {
  return {
    id,
    supplierId: 7,
    supplierName: "ספק",
    status: "CONFIRMED",
    orderDate: null,
    createdAt: "2026-07-21T10:00:00.000Z",
    lineCount: 1,
    ...over,
  };
}

async function main() {
  // 6) status mapping — the exact approved statuses, no invented ones.
  assert.equal(statusBadge("DRAFT").label, "טיוטה", "DRAFT");
  assert.equal(statusBadge("CONFIRMED").label, "מאושרת", "CONFIRMED");
  assert.equal(statusBadge("SENT").label, "נשלחה", "SENT");
  assert.equal(statusBadge("AWAITING_DELIVERY").label, "בהמתנה לאספקה", "AWAITING_DELIVERY");
  assert.equal(statusBadge("CLOSED").label, "נסגרה", "CLOSED");
  assert.equal(statusBadge("CANCELLED").label, "בוטלה", "CANCELLED");
  assert.ok(statusBadge("DRAFT").className.startsWith("crm-badge"), "badge uses crm class");
  // unknown status never throws / never invented — falls back to the raw value.
  assert.equal(statusBadge("WHATEVER").label, "WHATEVER", "unknown status falls back");

  // 7) lineCount formatting.
  assert.equal(formatLineCount(3), "3 פריטים", "plural");
  assert.equal(formatLineCount(1), "פריט אחד", "singular");
  assert.equal(formatLineCount(0), "ללא פריטים", "zero");
  assert.equal(formatLineCount(NaN), "ללא פריטים", "NaN safe");

  // 8) orderDate = null does not produce a broken display.
  assert.equal(formatPurchaseDate(null), null, "null date → null");
  assert.equal(formatPurchaseDate("not-a-date"), null, "invalid date → null");
  assert.ok((formatPurchaseDate("2026-07-21T10:00:00.000Z") ?? "").includes("2026"), "valid date formatted");

  // 10) load-more only when hasMore, and 12) not while a page is loading.
  assert.equal(canLoadMore(true, false), true, "hasMore + idle → can load");
  assert.equal(canLoadMore(false, false), false, "no more → cannot load");
  assert.equal(canLoadMore(true, true), false, "loading in flight → cannot load (double-click guard)");

  // 11) append next page without duplicates, preserving server order.
  const page1 = [item(4), item(3)];
  const page2 = [item(2), item(1)];
  const merged = mergePurchaseOrderItems(page1, page2);
  assert.deepEqual(merged.map((i) => i.id), [4, 3, 2, 1], "append preserves order");
  const dupMerged = mergePurchaseOrderItems(merged, [item(2), item(1), item(0)]);
  assert.deepEqual(dupMerged.map((i) => i.id), [4, 3, 2, 1, 0], "re-sent rows are not duplicated");

  // --- client wrapper (stubbed fetch) ---
  const realFetch = globalThis.fetch;
  let lastUrl = "";
  function stub(body: unknown, status = 200) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      lastUrl = String(input);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }
  try {
    // 14) client builds a businessId+supplierId path; NEVER sends supplierName.
    // 4) parses summary + items straight from the API.
    stub({
      summary: { purchaseOrderCount: 2, openPurchaseOrderCount: 1, lastPurchaseOrderAt: "2026-07-21T10:00:00.000Z" },
      items: [item(4), item(3)],
      pagination: { limit: 10, offset: 0, total: 2, hasMore: false },
    });
    const res = await getSupplierPurchaseHistory(63, { limit: 10, offset: 0 });
    assert.equal(lastUrl, "/api/inventory/suppliers/63/purchase-orders?limit=10&offset=0", "14: URL by id, paginated");
    assert.ok(!/supplierName/i.test(lastUrl), "14: no supplierName in the request");
    assert.equal(res.summary.purchaseOrderCount, 2, "3/4: summary total parsed");
    assert.equal(res.summary.openPurchaseOrderCount, 1, "3: open parsed");
    assert.deepEqual(res.items.map((i) => i.id), [4, 3], "4: items parsed in server order");

    // 13) tenant-safe 404 surfaces as NOT_FOUND (handled by the card's existing flow).
    stub({ error: "Supplier not found" }, 404);
    await assert.rejects(() => getSupplierPurchaseHistory(999), (e) => e instanceof Error && e.message === "NOT_FOUND", "13: 404 → NOT_FOUND");

    // 401 surfaces as UNAUTHORIZED (section redirects to login).
    stub({ error: "unauthorized" }, 401);
    await assert.rejects(() => getSupplierPurchaseHistory(1), (e) => e instanceof Error && e.message === "UNAUTHORIZED", "401 → UNAUTHORIZED");
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("supplier-purchase-history-view.test.ts: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
