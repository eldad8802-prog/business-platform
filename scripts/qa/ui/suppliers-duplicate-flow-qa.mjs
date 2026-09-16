/**
 * /suppliers duplicate-flow regression, after SupplierDuplicateNotice was split
 * into a chrome-free body + a wrapper.
 *
 * The inventory quick-create reuses the BODY. This proves the ORIGINAL entry
 * point — the standalone dialog on the Suppliers screen — still renders the same
 * advisory and still behaves the same: create is never blocked, the advisory
 * appears after creation, "open existing" navigates to the existing supplier,
 * and "keep new" navigates to the created one.
 *
 * QA/SYNTHETIC data only, injected at the network layer. Nothing is written.
 */
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://localhost:3111";
const json = (b, s = 200) => ({ status: s, contentType: "application/json", body: JSON.stringify(b) });

const EXISTING = {
  id: 501,
  name: "שטראוס עילית",
  isActive: true,
  phone: "972501234567",
  email: "orders@strauss.example",
  taxId: "514123456",
  reasons: ["TAX_ID", "NAME"],
};

let failures = 0;
let total = 0;
const check = (name, ok, extra = "") => {
  total += 1;
  if (!ok) failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
};

const browser = await chromium.launch();

async function open({ width = 1280, possibleMatches = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: "he-IL" });
  await ctx.addInitScript(() => {
    localStorage.setItem("token", "qa-synthetic-suppliers-regression");
    localStorage.setItem("user", JSON.stringify({ id: 1, name: "QA SYNTHETIC", businessId: 1 }));
  });
  const page = await ctx.newPage();
  const state = { creates: [] };
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === "/api/inventory/suppliers" && req.method() === "GET") {
      return route.fulfill(json({ suppliers: [{ id: 501, name: EXISTING.name, isActive: true, phone: EXISTING.phone, email: EXISTING.email }] }));
    }
    if (p === "/api/inventory/suppliers" && req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}");
      state.creates.push(body);
      return route.fulfill(json({
        supplier: { id: 902, name: body.name, isActive: true, phone: null, email: null, taxId: null },
        possibleMatches,
      }, 201));
    }
    if (/^\/api\/inventory\/suppliers\/\d+$/.test(p)) {
      const id = Number(p.split("/").pop());
      return route.fulfill(json({ supplier: { id, name: id === 501 ? EXISTING.name : "ספק חדש סינתטי", isActive: true, phone: null, email: null, notes: null, defaultLeadTimeDays: null, legalName: null, taxId: null, taxIdType: null, category: null, website: null, contactName: null, contactRole: null, contactPhone: null, contactEmail: null, addressStreet: null, addressCity: null, addressPostalCode: null, paymentTermsDays: null, preferredPaymentMethod: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } }));
    }
    if (/purchase-orders$/.test(p)) return route.fulfill(json({ summary: { purchaseOrderCount: 0, openPurchaseOrderCount: 0, lastPurchaseOrderAt: null, receivedValue: 0, orderedValue: 0, linesWithoutCost: 0, totalLineCount: 0 }, items: [], purchaseOrders: [] }));
    if (/\/notes$/.test(p)) return route.fulfill(json({ notes: [] }));
    if (/\/attachments$/.test(p)) return route.fulfill(json({ attachments: [] }));
    return route.fulfill(json({}));
  });
  await page.goto(`${BASE}/suppliers`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".crm-row", { timeout: 45000 });
  return { ctx, page, state };
}

async function createSupplier(page, name) {
  await page.getByRole("button", { name: "+ ספק חדש" }).first().click();
  await page.waitForSelector('[role=dialog][aria-label="ספק חדש"]', { timeout: 15000 });
  await page.locator('[role=dialog][aria-label="ספק חדש"] input').first().fill(name);
  await page.getByRole("button", { name: "שמירה" }).click();
}

/* ── no duplicates: unchanged happy path ─────────────────────────────────── */
console.log("\n[A] /suppliers create with no duplicates");
{
  const { ctx, page, state } = await open({ possibleMatches: [] });
  await createSupplier(page, "ספק סינתטי ייחודי");
  await page.waitForURL(/\/suppliers\/\d+/, { timeout: 15000 });
  check("the supplier was created", state.creates.length === 1);
  check("no advisory was shown", (await page.locator("text=ייתכן שהספק כבר קיים").count()) === 0);
  check("it navigated to the new supplier", /\/suppliers\/902/.test(page.url()), page.url());
  await ctx.close();
}

/* ── duplicates: the advisory still renders, via the extracted body ──────── */
console.log("\n[B] /suppliers duplicate advisory renders");
{
  const { ctx, page, state } = await open({ possibleMatches: [EXISTING] });
  await createSupplier(page, "שטראוס עלית");
  await page.waitForSelector('[role=dialog][aria-label="ייתכן שהספק כבר קיים"]', { timeout: 15000 });
  const dlg = page.locator('[role=dialog][aria-label="ייתכן שהספק כבר קיים"]');
  const text = await dlg.innerText();
  check("the supplier was created first (never blocked)", state.creates.length === 1);
  check("the advisory dialog appeared", await dlg.isVisible());
  check("it still has its own backdrop", (await page.locator(".crm-modal__backdrop").count()) === 1);
  check("the strong-signal copy is used for a TAX_ID match", text.includes("אותו מספר עסקי"));
  check("the match is listed", text.includes(EXISTING.name));
  check("the match reasons are shown", text.includes("אותו מספר עוסק") || text.includes("שם זהה"));
  check("the phone is shown formatted", text.includes("050-123-4567"));
  check("the keep-new action is present", text.includes("להמשיך עם הספק החדש"));
  await ctx.close();
}

/* ── duplicates → open existing (the ORIGINAL navigation semantics) ──────── */
console.log("\n[C] /suppliers duplicate → open existing");
{
  const { ctx, page } = await open({ possibleMatches: [EXISTING] });
  await createSupplier(page, "שטראוס עלית");
  await page.waitForSelector('[role=dialog][aria-label="ייתכן שהספק כבר קיים"]', { timeout: 15000 });
  await page.locator('[role=dialog][aria-label="ייתכן שהספק כבר קיים"] .crm-row').first().click();
  await page.waitForURL(/\/suppliers\/501/, { timeout: 15000 });
  check("it navigates to the EXISTING supplier", /\/suppliers\/501/.test(page.url()), page.url());
  await ctx.close();
}

/* ── duplicates → keep new ───────────────────────────────────────────────── */
console.log("\n[D] /suppliers duplicate → keep new");
{
  const { ctx, page } = await open({ possibleMatches: [EXISTING] });
  await createSupplier(page, "שטראוס עלית");
  await page.waitForSelector('[role=dialog][aria-label="ייתכן שהספק כבר קיים"]', { timeout: 15000 });
  await page.getByRole("button", { name: "להמשיך עם הספק החדש" }).click();
  await page.waitForURL(/\/suppliers\/902/, { timeout: 15000 });
  check("it navigates to the NEWLY created supplier", /\/suppliers\/902/.test(page.url()), page.url());
  await ctx.close();
}

/* ── the advisory still lays out correctly on a phone ────────────────────── */
console.log("\n[E] /suppliers advisory layout at 390px");
{
  const { ctx, page } = await open({ width: 390, possibleMatches: [EXISTING] });
  await createSupplier(page, "שטראוס עלית");
  await page.waitForSelector('[role=dialog][aria-label="ייתכן שהספק כבר קיים"]', { timeout: 15000 });
  const geo = await page.evaluate(() => {
    const d = document.querySelector('[role=dialog][aria-label="ייתכן שהספק כבר קיים"]');
    const r = d.getBoundingClientRect();
    const row = d.querySelector(".crm-row");
    const rr = row.getBoundingClientRect();
    const name = row.querySelector(".crm-row__name").getBoundingClientRect();
    const de = document.documentElement, b = document.body;
    const ph = de.style.overflowX, pb = b.style.overflowX;
    de.style.overflowX = "visible"; b.style.overflowX = "visible";
    void b.offsetWidth;
    const hidden = de.scrollWidth > window.innerWidth + 1;
    de.style.overflowX = ph; b.style.overflowX = pb;
    return {
      dialogOut: Math.round(Math.max(r.right - window.innerWidth, -r.left)),
      nameOut: Math.round(Math.max(name.right - rr.right, rr.left - name.left)),
      hidden,
    };
  });
  check("the dialog stays inside the viewport", geo.dialogOut <= 1, `out by ${geo.dialogOut}px`);
  check("the match name stays inside its row", geo.nameOut <= 1, `out by ${geo.nameOut}px`);
  check("no hidden horizontal overflow", !geo.hidden);
  await ctx.close();
}

await browser.close();
console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
