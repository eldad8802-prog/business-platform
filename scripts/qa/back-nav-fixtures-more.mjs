/**
 * Additional fixtures for the flow chains: every committing call is COUNTED in
 * `posts`, so a chain can prove that going back never repeats it.
 */
const NOW = "2026-10-05T09:00:00.000Z";
const iso = (d) => new Date(Date.parse(NOW) + d * 86400000).toISOString();

export async function wireMore(context, { posts, json }) {
  const r = (pattern, fn) => context.route(pattern, fn);

  // Coupon publish
  await r("**/api/revenue/coupons", (x) => {
    if (x.request().method() !== "POST") return x.fulfill(json({ coupons: [] }));
    posts.couponPublish += 1;
    return x.fulfill(json({ coupon: { offerId: 9, publicId: "pub-9", token: "tok-9", qrValue: "q", benefit: "10% הנחה", description: null, expiresAt: iso(14), status: "ACTIVE" } }, 201));
  });

  // Pricing: save costs to an item
  await r(/\/api\/pricing\/profiles\/\d+$/, (x) => {
    if (x.request().method() === "GET") return x.fulfill(json({ profile: { id: 31 } }));
    posts.pricingSave += 1;
    return x.fulfill(json({ profile: { id: 31 } }));
  });

  // Secretary: complete / release
  await r(/\/api\/obligations\/\d+\/(complete|release)$/, (x) => {
    posts.obligationComplete += 1;
    return x.fulfill(json({ id: 41, state: "MET", metAt: NOW }));
  });

  // Billing draft document (unsaved-changes dialog)
  const BILL = {
    id: 12, documentType: "TAX_INVOICE", status: "DRAFT", documentNumber: null, documentNumberFormatted: null, customerId: null,
    customerNameSnapshot: "לקוח ישן", validUntil: null, convertedToInvoiceId: null, subtotalAmount: "100.00", vatAmount: "18.00",
    totalAmount: "118.00", currency: "ILS", issuedAt: null, createdAt: NOW, updatedAt: NOW,
    lines: [{ id: 1, lineIndex: 0, description: "שירות", quantity: "1", unitPrice: "100.00", vatRatePercent: "18", lineSubtotal: "100.00", vatAmount: "18.00", lineTotal: "118.00" }],
  };
  await r(/\/api\/billing\/documents\/12$/, (x) => {
    if (x.request().method() === "GET") return x.fulfill(json({ document: BILL }));
    posts.billingPatch += 1;
    return x.fulfill(json({ document: BILL }));
  });
  await r(/\/api\/billing\/documents\/12\/lines$/, (x) => {
    posts.billingLinesSave += 1;
    const body = JSON.parse(x.request().postData() ?? "{}");
    const desc = body?.lines?.[0]?.description ?? "שירות";
    return x.fulfill(json({ document: { ...BILL, lines: [{ ...BILL.lines[0], description: desc }] } }));
  });

  // Inventory: supplier order wizard
  const ITEM = (id, name) => ({
    id, name, sku: null, barcode: null, unitType: "UNIT", supplierName: "ספק א", currentQuantity: 2, minimumQuantity: 5, reorderPoint: 5,
    costPerUnit: 10, sellPricePerUnit: 20, lastPurchaseCost: 10, imageUrl: null, alerts: [], categoryId: null, category: null,
  });
  await r(/\/api\/inventory\/items$/, (x) => x.fulfill(json({ items: [ITEM(1, "קפה"), ITEM(2, "חלב")] })));
  await r(/\/api\/inventory\/categories$/, (x) => x.fulfill(json({ categories: [] })));
  await r(/\/api\/suppliers(\?.*)?$/, (x) => x.fulfill(json({ suppliers: [{ id: 5, name: "ספק א", phone: "0500000000", email: null, contactName: null, isActive: true }] })));
  await r(/\/api\/inventory\/supplier-purchases$/, (x) => {
    if (x.request().method() !== "POST") return x.fulfill(json({ purchases: [] }));
    posts.orderCreate += 1;
    return x.fulfill(json({ draft: { id: 77 } }, 201));
  });
  await r(/\/api\/inventory\/purchase-orders\/77$/, (x) =>
    x.fulfill(json({ purchaseOrder: { id: 77, supplierName: "ספק א", externalOrderId: null, status: "DRAFT", orderDate: null, createdAt: NOW, lines: [] } })));

  // Content render: every POST starts a quota-consuming render — counted.
  await r(/\/api\/content\/render$/, (x) => {
    posts.contentRender += 1;
    return x.fulfill(json({ renderId: "r1", status: "succeeded", url: "https://cdn.example.test/v.mp4", snapshotUrl: null }));
  });
  await r(/\/api\/content\/render\/status\/.*/, (x) => x.fulfill(json({ renderId: "r1", status: "succeeded", url: "https://cdn.example.test/v.mp4" })));
  await r("https://cdn.example.test/**", (x) => x.fulfill({ status: 200, contentType: "video/mp4", body: "" }));

  // Inbox (legacy list mode: plain conversations, no smart view-models)
  await r(/\/api\/conversations$/, (x) =>
    x.fulfill(json({ conversations: [7, 8].map((id) => ({ id, channel: "WHATSAPP", status: "OPEN", currentStage: "NEW", startedAt: NOW, lastMessageAt: NOW, updatedAt: NOW, customerId: null })) })));
  await r(/\/api\/message\?/, (x) =>
    x.fulfill(json({ messages: [{ id: 1, conversationId: 7, senderType: "CUSTOMER", content: "שלום", createdAt: NOW }], suggestions: [] })));
}
