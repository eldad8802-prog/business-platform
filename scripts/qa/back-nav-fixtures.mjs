/**
 * Network fixtures for the back-navigation flow QA. Shapes follow the client
 * types the screens read (lib/api/*, lib/obligations/secretary-client.ts,
 * app/pricing/page.tsx, lib/coupon/api.ts, collection screens). Every POST
 * that commits something is COUNTED, so a chain can prove that going back
 * never re-triggers a completed action.
 */
export const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const b64url = (s) => Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
export const tokenFor = (sub) => `v1.${b64url(JSON.stringify({ sub, iat: 1, exp: 4102444800 }))}.qa`;

import { wireMore } from "./back-nav-fixtures-more.mjs";

export const posts = {
  paymentRequest: 0, pricingCalc: 0, pricingCreate: 0, pricingSave: 0, couponPublish: 0, redeem: 0,
  obligationComplete: 0, billingLinesSave: 0, billingPatch: 0, orderCreate: 0, contentRender: 0,
};
export function resetPosts() {
  for (const k of Object.keys(posts)) posts[k] = 0;
}

const NOW = "2026-10-05T09:00:00.000Z";
const iso = (d) => new Date(Date.parse(NOW) + d * 86400000).toISOString();

/* --------------------------------------------------------------- CRM ---- */
export const CUSTOMERS = Array.from({ length: 80 }, (_, i) => ({
  id: i + 1, name: `לקוח ${i + 1}`, phone: `05000000${String(i).padStart(2, "0")}`, email: null, city: "תל אביב", isActive: i % 5 !== 0,
}));
const LEAD_ROW = (id) => ({
  id, name: `ליד ${id}`, phone: `0521234${String(id).padStart(3, "0")}`, email: null, status: "NEW", sourceChannel: "WHATSAPP",
  followUpNote: null, lastActivityAt: NOW, createdAt: NOW, followUp: { kind: "none" }, needsAttention: false,
  customer: id === 3 ? { id: 7, name: "לקוח 7" } : null, intelligence: null,
  priority: { score: 40, reason: "fresh", label: "ליד חדש", contributing: [] },
});
const LEAD_CARD = (id) => ({
  lead: {
    id, name: `ליד ${id}`, phone: "0521234003", email: null, status: "NEW", sourceChannel: "WHATSAPP", intentSnapshot: null,
    followUpNote: null, nextFollowUpAt: null, lastActivityAt: NOW, closedAt: null, lostReason: null, createdAt: NOW, updatedAt: NOW,
    lifecycleVersion: 1, nextActionKind: null, nextActionLabel: null, firstHandledAt: null, valueEstimate: null, finalPrice: null, currency: null,
  },
  followUp: { kind: "none" }, needsAttention: false,
  customer: { id: 7, name: "לקוח 7", phone: null, email: null, city: null, isActive: true },
  conversations: { items: [], total: 0 }, intelligence: null,
  priority: { score: 40, reason: "fresh", label: "ליד חדש", contributing: [] },
  lifecycle: { attention: { reason: null, label: null, summary: null, evidenceClass: null }, suggestion: null, history: [] },
});

/* ----------------------------------------------------------- collection -- */
const LONG = "עיריית תל אביב יפו";
const PAY_URL = "https://pay.example.test/checkout/abc123";
const INBOX = {
  businessName: "העסק של אלדד",
  summary: { toCollect: { amount: "2500.00", count: 1, currency: "ILS" }, waiting: { amount: "0", count: 0 }, attention: { count: 0 }, paidRecent: { amount: "0", count: 0 } },
  toCollect: [{ customerId: 1, customerName: LONG, customerPhone: "0501234567", totalOutstanding: "2500.00", currency: "ILS", awaitingSince: "2026-09-01T00:00:00.000Z", invoices: [{ id: 11, documentNumber: "000123", outstanding: "2500.00", currency: "ILS", isPartiallySettled: false }], openRequestCount: 0 }],
  waiting: [], attention: [], paid: [], paidNextBefore: null,
};
const THREAD = {
  businessName: "העסק של אלדד",
  customer: { id: 1, name: LONG, phone: "0501234567", email: null },
  totals: { outstanding: "2500.00", currency: "ILS", openInvoices: 1 },
  openInvoices: [{ id: 11, number: "000123", outstanding: "2500.00", currency: "ILS" }],
  events: [{ kind: "INVOICE_ISSUED", at: "2026-06-01T09:00:00.000Z", invoiceId: 11, number: "000123", amount: "2500.00", currency: "ILS", outstanding: "2500.00" }],
};

/* -------------------------------------------------------------- pricing -- */
const PRICING_ITEMS = [
  { id: 31, name: "תספורת", type: "SERVICE", category: "שיער", defaultMaterialCost: 10, defaultLaborMinutes: 30, defaultHourlyRate: 120, defaultOverheadPercent: 10, isActive: true },
  { id: 32, name: "צבע", type: "SERVICE", category: "שיער", defaultMaterialCost: 40, defaultLaborMinutes: 60, defaultHourlyRate: 120, defaultOverheadPercent: 10, isActive: true },
];
const PRICING_RESULT = {
  costBreakdown: { materialCost: 123, laborCost: 60, directCost: 183, overheadCost: 18.3, fullCost: 201.3 },
  priceOptions: { minimum: 220, recommended: 260, premium: 300 },
  profit: { amount: 58.7, percent: 22.5, indicator: "OK", label: "רווח סביר" },
  explanation: "המחיר המומלץ מכסה את העלות המלאה עם רווח סביר.",
};

/* ------------------------------------------------------------ secretary -- */
const OBL = (id, name, due) => ({
  id, obligeeName: name, amount: "1200.00", currency: "ILS", dueAt: iso(due), state: "OPEN", source: "OWNER", recurrence: "NONE",
  recurrenceSeriesId: null, note: null, followUpAt: null, settlementAssertedBy: null, metAt: null, releasedAt: null, createdAt: NOW, updatedAt: NOW, ledger: null,
});
const OBLIGATIONS = [OBL(41, "חברת החשמל", 2), OBL(42, "ועד הבית", 9), OBL(43, "ביטוח העסק", 20)];
const BRIEFING = {
  state: "BUSY", oriented: true,
  attention: [{ obligation: OBLIGATIONS[0], reason: "DUE_SOON" }],
  watching: OBLIGATIONS.slice(1),
  counts: { open: 3, attention: 1, breakToday: 0, watching: 2 },
  generatedAt: NOW,
};

/* -------------------------------------------------------------- search --- */
const SEARCH = [1, 2, 3].map((i) => ({
  id: i, documentId: 500 + i, vendorName: `דלק ${i}`, category: "fuel", amount: 100 * i, date: iso(-i), direction: "expense",
  document: { id: 500 + i, status: "approved", fileName: `f${i}.pdf` },
}));

export async function wire(context, { sub = 9 } = {}) {
  await context.addInitScript((t) => {
    try {
      if (!localStorage.getItem("token")) localStorage.setItem("token", t);
    } catch {
      /* about:blank / data: pages have no app storage */
    }
  }, tokenFor(sub));
  const r = (pattern, fn) => context.route(pattern, fn);
  // Unknown APIs: a quiet 404 (never 401 — that would bounce to /login).
  await r("**/api/**", (x) => x.fulfill(json({ error: "qa-not-mocked" }, 404)));

  // CRM
  await r("**/api/customers?*", (x) => {
    const u = new URL(x.request().url());
    const q = (u.searchParams.get("q") ?? "").trim();
    const st = u.searchParams.get("status") ?? "active";
    let rows = CUSTOMERS.filter((c) => (st === "all" ? true : st === "active" ? c.isActive : !c.isActive));
    if (q) rows = rows.filter((c) => c.name.includes(q) || (c.phone ?? "").includes(q));
    return x.fulfill(json({ customers: rows }));
  });
  await r(/\/api\/leads(\?.*)?$/, (x) => x.fulfill(json({ leads: [1, 2, 3, 4].map(LEAD_ROW), rankingTruncated: false })));
  await r(/\/api\/leads\/\d+$/, (x) => x.fulfill(json(LEAD_CARD(Number(x.request().url().split("/").pop())))));

  // Collection
  await r("**/api/collection/inbox*", (x) => x.fulfill(json(INBOX)));
  await r("**/api/collection/customers/*", (x) => {
    const id = Number(new URL(x.request().url()).pathname.split("/").pop());
    const name = CUSTOMERS.find((c) => c.id === id)?.name ?? LONG;
    return x.fulfill(json({ ...THREAD, customer: { ...THREAD.customer, id, name } }));
  });
  await r("**/api/collection/readiness", (x) => x.fulfill(json({ ready: true, blockers: [] })));
  await r("**/api/payments/requests", (x) => {
    if (x.request().method() !== "POST") return x.fulfill(json({ requests: [] }));
    posts.paymentRequest += 1;
    const amount = JSON.parse(x.request().postData() ?? "{}").amount;
    return x.fulfill(json({ id: 99, status: "PENDING", amount, currency: "ILS", paymentUrl: PAY_URL, description: null, provider: "CARDCOM", createdAt: NOW }, 201));
  });

  // Pricing
  await r("**/api/business/profile", (x) => x.fulfill(json({ hasProfile: true, profile: { id: 1, businessId: 9, category: "beauty", subCategory: null, businessModel: "service", createdAt: NOW, updatedAt: NOW } })));
  await r("**/api/pricing/profiles", (x) => {
    if (x.request().method() === "POST") {
      posts.pricingCreate += 1;
      return x.fulfill(json({ profile: { id: 33 } }, 201));
    }
    return x.fulfill(json({ profiles: PRICING_ITEMS }));
  });
  await r("**/api/pricing/calculate", (x) => {
    posts.pricingCalc += 1;
    return x.fulfill(json(PRICING_RESULT));
  });

  // Coupons
  await r("**/api/revenue/coupons/mine", (x) => x.fulfill(json({ coupons: [] })));
  await r("**/api/revenue/coupons/my-business", (x) => x.fulfill(json({ business: { name: "העסק של אלדד", logoUrl: null, address: "הרצל 1", city: "תל אביב", phone: "035555555", incomplete: [] } })));
  await r(/\/api\/coupons\/[^/]+\/redeem$/, (x) => {
    posts.redeem += 1;
    const token = x.request().url().split("/").slice(-2)[0];
    if (token === "BAD") return x.fulfill(json({ error: "COUPON_NOT_FOUND" }, 404));
    return x.fulfill(json({ coupon: { id: 1, token, status: "REDEEMED", offer: { title: "10% הנחה" } }, redemptionEvent: { id: 1, redeemedAt: NOW } }));
  });

  // Secretary
  await r("**/api/obligations/briefing", (x) => x.fulfill(json(BRIEFING)));
  await r(/\/api\/obligations(\?.*)?$/, (x) => x.fulfill(json({ obligations: OBLIGATIONS })));

  // Documents search
  await r(/\/api\/search(\?.*)?$/, (x) => x.fulfill(json({ results: SEARCH })));

  await wireMore(context, { posts, json });
}
