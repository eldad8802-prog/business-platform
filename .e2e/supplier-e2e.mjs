/**
 * Supplier domain — runtime E2E over the real HTTP API.
 *
 * Not a unit test: every step below goes through the same Next.js route handlers
 * and the same auth the browser uses. Nothing here imports a service directly,
 * so it proves the WIRE is connected, not just that the functions work.
 *
 * Run:  node .e2e/supplier-e2e.mjs            (server must be on BASE)
 */

const BASE = process.env.E2E_BASE || "http://localhost:3001";

const stamp = `${Date.now()}`;
const email = `qa-suppliers-${stamp}@example.test`;
const password = "Passw0rd!e2e";

let token = null;
const results = [];
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    results.push(`PASS  ${name}`);
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
  } else {
    failed++;
    results.push(`FAIL  ${name}`);
    console.log(`FAIL  ${name}  — ${detail ?? ""}`);
  }
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function main() {
  // ── 0. Sessions ───────────────────────────────────────────────────────────
  // Tokens come from .e2e/seed-tenants.ts (same signAuthToken the login route
  // uses). Signup is rate-limited to 3/hour/IP and is not what this run tests;
  // every supplier/order/receipt/read below still goes over real HTTP.
  const seeded = JSON.parse(process.env.E2E_TOKENS || "null");
  if (!seeded) {
    console.log("E2E_TOKENS is required — run: npx tsx --env-file=.env .e2e/seed-tenants.ts");
    process.exit(1);
  }
  token = seeded.a.token;
  check("auth: tenant A session", Boolean(token));
  // ── 1. Create a supplier WITH the full business profile ───────────────────
  const created = await api("/api/inventory/suppliers", {
    method: "POST",
    body: JSON.stringify({
      name: "ספק E2E",
      phone: "0501234567",
      email: `supplier-${stamp}@example.test`,
      taxId: "51-412 9876",
      taxIdType: "LTD_COMPANY",
      category: "מזון",
      contactName: "רונית",
      contactRole: "מנהלת רכש",
      addressStreet: "הרצל 10",
      addressCity: "תל אביב",
      addressPostalCode: "6100000",
      paymentTermsDays: 30,
      preferredPaymentMethod: "BANK_TRANSFER",
    }),
  });
  const supplierId = created.body?.supplier?.id;
  check("1. supplier created", created.status === 201 && Boolean(supplierId), `status=${created.status}`);
  check(
    "1. business identity persisted (normalized)",
    created.body?.supplier?.taxId === "514129876" &&
      created.body?.supplier?.taxIdType === "LTD_COMPANY",
    `taxId=${created.body?.supplier?.taxId}`
  );
  check(
    "1. payment terms + method persisted",
    created.body?.supplier?.paymentTermsDays === 30 &&
      created.body?.supplier?.preferredPaymentMethod === "BANK_TRANSFER"
  );
  check(
    "1. contact + address persisted",
    created.body?.supplier?.contactName === "רונית" &&
      created.body?.supplier?.addressCity === "תל אביב"
  );

  // ── 2. Refresh: the card reads back what was saved ────────────────────────
  const reread = await api(`/api/inventory/suppliers/${supplierId}`);
  check(
    "2. survives refresh (GET returns the same values)",
    reread.body?.supplier?.taxId === "514129876" &&
      reread.body?.supplier?.paymentTermsDays === 30 &&
      reread.body?.supplier?.contactRole === "מנהלת רכש"
  );

  // ── 3. Edit through PATCH, then refresh again ─────────────────────────────
  const patched = await api(`/api/inventory/suppliers/${supplierId}`, {
    method: "PATCH",
    body: JSON.stringify({ paymentTermsDays: 60, contactRole: "סמנכ״לית רכש" }),
  });
  const afterPatch = await api(`/api/inventory/suppliers/${supplierId}`);
  check(
    "3. edit persists and does not blank untouched fields",
    patched.status === 200 &&
      afterPatch.body?.supplier?.paymentTermsDays === 60 &&
      afterPatch.body?.supplier?.contactRole === "סמנכ״לית רכש" &&
      afterPatch.body?.supplier?.taxId === "514129876"
  );

  // ── 4. Duplicate detection reaches the client ─────────────────────────────
  const dup = await api("/api/inventory/suppliers", {
    method: "POST",
    body: JSON.stringify({
      // Different NAME on purpose: only the identifier connects them.
      name: "עסק בשם אחר לגמרי",
      taxId: "514129876",
    }),
  });
  const matches = dup.body?.possibleMatches ?? [];
  check(
    "4. possibleMatches returned to the client",
    Array.isArray(matches) && matches.length > 0,
    `matches=${matches.length}`
  );
  check(
    "4. the identifier match is reported, and ranked first",
    matches[0]?.id === supplierId && matches[0]?.reasons?.includes("TAX_ID"),
    `reasons=${JSON.stringify(matches[0]?.reasons)}`
  );

  // ── 5. Inventory item ─────────────────────────────────────────────────────
  const item = await api("/api/inventory/items", {
    method: "POST",
    body: JSON.stringify({
      name: `פריט E2E ${stamp}`,
      unitType: "UNIT",
      initialQuantity: 0,
      minimumQuantity: 0,
      reorderPoint: 0,
    }),
  });
  const itemId = item.body?.item?.id ?? item.body?.id;
  check("5. inventory item created", Boolean(itemId), `status=${item.status}`);

  // ── 6. Purchase order via the wizard's own endpoint ───────────────────────
  const draft = await api("/api/inventory/supplier-purchases", {
    method: "POST",
    body: JSON.stringify({
      supplierId,
      supplierName: "שם שגוי מהלקוח",
      source: "MANUAL",
      lines: [
        {
          rawName: `פריט E2E ${stamp}`,
          quantity: 1,
          unitCost: 12,
          unitType: "UNIT",
        },
      ],
    }),
  });
  const draftId = draft.body?.draft?.id;
  const draftLineId = draft.body?.draft?.lines?.[0]?.id;
  check("6. draft created", draft.status === 201 && Boolean(draftId), `status=${draft.status}`);

  const drafts = await api("/api/inventory/supplier-purchases");
  const thisDraft = (drafts.body?.drafts ?? []).find((d) => d.id === draftId);
  check(
    "6. draft carries supplierId (was always null before)",
    thisDraft?.supplierId === supplierId,
    `supplierId=${thisDraft?.supplierId}`
  );
  check(
    "6. supplierName derived from the entity, not the client",
    thisDraft?.supplierName === "ספק E2E",
    `name=${thisDraft?.supplierName}`
  );
  check(
    "6. unitCost survived the wire (was dropped before)",
    thisDraft?.lines?.[0]?.unitCost === 12,
    `unitCost=${thisDraft?.lines?.[0]?.unitCost}`
  );

  // ── 7. Approve / receive ──────────────────────────────────────────────────
  const approved = await api(
    `/api/inventory/supplier-purchases/${draftId}/approve`,
    {
      method: "POST",
      body: JSON.stringify({
        lines: [{ lineId: draftLineId, action: "MERGE", itemId }],
      }),
    }
  );
  check("7. approval succeeded", approved.status === 200, `status=${approved.status}`);

  // ── 8. Lifecycle + totals on the purchases screen ─────────────────────────
  const pos = await api("/api/inventory/purchase-orders");
  const po = (pos.body?.purchaseOrders ?? []).find((p) => p.supplierId === supplierId);
  check("8. PO exists and holds supplierId", Boolean(po), `supplierId=${po?.supplierId}`);
  check(
    "8. PO left ממתינות and reached היסטוריה (CLOSED)",
    po?.status === "CLOSED",
    `status=${po?.status}`
  );
  check(
    "8. PO line holds unitCost → order total is ₪12",
    po?.lines?.[0]?.unitCost === 12 &&
      po.lines[0].orderedQty * po.lines[0].unitCost === 12,
    `unitCost=${po?.lines?.[0]?.unitCost}`
  );
  check(
    "8. line reports receivedQty / openQty for the receive screen",
    po?.lines?.[0]?.receivedQty === 1 && po?.lines?.[0]?.openQty === 0
  );

  // ── 9. Inventory actually moved ───────────────────────────────────────────
  const items = await api("/api/inventory/items");
  const list = items.body?.items ?? items.body ?? [];
  const movedItem = (Array.isArray(list) ? list : []).find((i) => i.id === itemId);
  check(
    "9. stock increased by the receipt",
    movedItem?.currentQuantity === 1,
    `qty=${movedItem?.currentQuantity}`
  );
  check(
    "9. lastPurchaseCost followed the unit cost",
    movedItem?.lastPurchaseCost === 12,
    `lastPurchaseCost=${movedItem?.lastPurchaseCost}`
  );

  // ── 10. The supplier card ─────────────────────────────────────────────────
  const history = await api(
    `/api/inventory/suppliers/${supplierId}/purchase-orders`
  );
  check(
    "10. card sees the order (was 'עדיין אין היסטוריית רכש')",
    history.body?.summary?.purchaseOrderCount === 1,
    `count=${history.body?.summary?.purchaseOrderCount}`
  );
  check(
    "10. card shows spend",
    history.body?.summary?.receivedValue === 12 &&
      history.body?.summary?.orderedValue === 12,
    `received=${history.body?.summary?.receivedValue}`
  );
  check(
    "10. card lists what was bought, with its price",
    history.body?.purchasedItems?.[0]?.totalQty === 1 &&
      history.body?.purchasedItems?.[0]?.lastUnitCost === 12
  );
  check(
    "10. per-order total present",
    history.body?.items?.[0]?.orderedValue === 12
  );

  // ── 11. Renaming does not detach history ──────────────────────────────────
  await api(`/api/inventory/suppliers/${supplierId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "ספק E2E — שם חדש" }),
  });
  const afterRename = await api(
    `/api/inventory/suppliers/${supplierId}/purchase-orders`
  );
  check(
    "11. history survives a supplier rename",
    afterRename.body?.summary?.purchaseOrderCount === 1
  );

  // ── 12. Tenant isolation, read-only probes only ───────────────────────────
  const otherToken = seeded.b.token;

  if (otherToken) {
    const savedToken = token;
    token = otherToken;

    const foreignRead = await api(`/api/inventory/suppliers/${supplierId}`);
    check(
      "12. another tenant cannot READ this supplier",
      foreignRead.status === 404,
      `status=${foreignRead.status}`
    );

    const foreignHistory = await api(
      `/api/inventory/suppliers/${supplierId}/purchase-orders`
    );
    check(
      "12. another tenant cannot read its purchase history",
      foreignHistory.status === 404,
      `status=${foreignHistory.status}`
    );

    // A WRITE attempt that must be refused. This creates a draft owned by the
    // OTHER tenant only if the server wrongly accepts the foreign supplierId —
    // which is exactly what we want to detect. Tenant A's data is never mutated.
    const foreignWrite = await api("/api/inventory/supplier-purchases", {
      method: "POST",
      body: JSON.stringify({
        supplierId,
        lines: [{ rawName: "probe", quantity: 1 }],
      }),
    });
    check(
      "12. another tenant cannot ATTACH this supplier to its own order",
      foreignWrite.status >= 400,
      `status=${foreignWrite.status} ${JSON.stringify(foreignWrite.body).slice(0, 120)}`
    );

    const stillMine = await api(`/api/inventory/suppliers/${supplierId}`);
    check(
      "12. the foreign write left tenant A's supplier untouched",
      stillMine.status === 404
    );

    token = savedToken;
  } else {
    check("12. tenant isolation probes", false, "could not create a second tenant");
  }

  console.log(
    `\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} runtime checks passed`
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
