/**
 * Supplier field — behaviour QA against the REAL Create and Edit inventory
 * screens.
 *
 * This is the other half of `components/inventory/supplier-field.test.ts`. The
 * repo has no DOM unit stack, so everything that needs a live document —
 * keyboard, focus, the quick-create dialog, the duplicate advisory, cancelling,
 * API failure — is proven here, in a browser, against the shipped components.
 *
 * Data is QA/SYNTHETIC and injected at the network layer, which also lets the
 * run force the cases a seeded database cannot be relied on to produce: a
 * validation rejection, a 500, and a duplicate advisory on demand.
 *
 *   node scripts/qa/ui/inventory-supplier-field-qa.mjs [--base http://localhost:3111] [--shots <dir>]
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const argOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = argOf("--base", "http://localhost:3111");
const SHOTS = argOf("--shots", null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const WIDTHS = [320, 360, 390, 768, 1024, 1280, 1920];

const LONG_HE = "מרכז השיווק והפצת מוצרי הבנייה והתשתיות בע״מ סניף ראשי דרום";
const LONG_EN = "Globex Industries International Trading And Distribution Limited";

/** Canonical suppliers — note NONE of them appears on the items below. */
const SUPPLIERS = [
  { id: 101, name: "שטראוס עילית", isActive: true, phone: "972501234567", email: "orders@strauss.example" },
  { id: 102, name: LONG_HE, isActive: true, phone: null, email: null },
  { id: 103, name: LONG_EN, isActive: true, phone: null, email: "ap@globex.example" },
];

/** An item whose supplierName has no Supplier record behind it. */
const ORPHAN_NAME = "ספק ישן שאינו רשום";
const ITEMS = [
  { id: 1, name: "מסנן שמן QA SYNTHETIC", sku: "OEM-1", barcode: "7290000000001", unitType: "UNIT", currentQuantity: 4, minimumQuantity: 12, reorderPoint: 12, costPerUnit: 10, sellPricePerUnit: 20, imageUrl: null, alerts: [], supplierName: ORPHAN_NAME, category: null },
];

const json = (b, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(b) });

/** Per-test knobs for the supplier POST. */
function makeRouter(opts) {
  const state = { createCalls: [], searchQueries: [] };
  const handler = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;

    if (p === "/api/inventory/suppliers" && req.method() === "GET") {
      state.searchQueries.push(url.searchParams.get("q") ?? "");
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      if (opts.searchFails) return route.fulfill(json({ error: "boom" }, 500));
      const rows = q
        ? SUPPLIERS.filter((s) => s.name.toLowerCase().includes(q))
        : SUPPLIERS;
      return route.fulfill(json({ suppliers: rows }));
    }

    if (p === "/api/inventory/suppliers" && req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}");
      state.createCalls.push(body);
      if (opts.createStatus && opts.createStatus !== 201) {
        return route.fulfill(json({ error: opts.createError ?? "שגיאת שרת" }, opts.createStatus));
      }
      const created = { id: 900, name: body.name, isActive: true, phone: body.phone ?? null, email: body.email ?? null, taxId: body.taxId ?? null };
      return route.fulfill(
        json({ supplier: created, possibleMatches: opts.possibleMatches ?? [] }, 201),
      );
    }

    if (p === "/api/inventory/items" && req.method() === "GET") return route.fulfill(json({ items: ITEMS }));
    if (p === "/api/inventory/items" && req.method() === "POST") {
      state.itemCreated = true;
      return route.fulfill(json({ item: ITEMS[0] }, 201));
    }
    if (/^\/api\/inventory\/items\/\d+$/.test(p)) return route.fulfill(json({ item: ITEMS[0] }));
    if (p === "/api/inventory/categories") return route.fulfill(json({ categories: [] }));
    if (p.startsWith("/api/inventory/movements")) return route.fulfill(json({ movements: [] }));
    if (p.startsWith("/api/inventory/alerts")) return route.fulfill(json({ alerts: [] }));
    if (/\/notes$/.test(p)) return route.fulfill(json({ notes: [] }));
    if (/\/attachments$/.test(p)) return route.fulfill(json({ attachments: [] }));
    return route.fulfill(json({}));
  };
  return { handler, state };
}

let failures = 0;
let total = 0;
function check(name, ok, extra = "") {
  total += 1;
  if (!ok) failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

const browser = await chromium.launch();

async function openScreen(opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: opts.width ?? 390, height: 900 },
    locale: "he-IL",
  });
  await ctx.addInitScript(() => {
    localStorage.setItem("token", "qa-synthetic-supplier-field");
    localStorage.setItem("user", JSON.stringify({ id: 1, name: "QA SYNTHETIC", businessId: 1 }));
  });
  const page = await ctx.newPage();
  const router = makeRouter(opts);
  await page.route("**/api/**", router.handler);
  const url = opts.screen === "edit" ? `${BASE}/inventory/items/1` : `${BASE}/inventory/items/create`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (opts.screen === "edit") {
    // The card opens in read mode; the supplier field lives in the edit sheet.
    await page.waitForSelector(".inv-dname", { timeout: 45000 });
    await page.getByRole("button", { name: "עריכה" }).first().click();
  }
  await page.waitForSelector("input[role=combobox]", { timeout: 45000 });
  return { ctx, page, state: router.state };
}

const combo = (page) => page.locator("input[role=combobox]").first();
const options = (page) => page.locator("[role=option]");

/**
 * The canonical list arrives after a 250ms debounce plus a round trip, while the
 * orphan option renders immediately from already-loaded props. Waiting for a
 * known canonical name is what separates "the search has not answered yet" from
 * "the search returned nothing" — an earlier version of this file asserted
 * before the answer and blamed the product for its own race.
 */
async function waitForCanonical(page, name = "שטראוס עילית") {
  await page.locator("[role=option]", { hasText: name }).first().waitFor({ timeout: 15000 });
}

/* ── 1. canonical selection, including a supplier never used on an item ───── */
console.log("\n[1] Canonical supplier selection");
{
  const { ctx, page, state } = await openScreen();
  await combo(page).click();
  await waitForCanonical(page);
  const texts = await options(page).allInnerTexts();
  check("canonical suppliers are listed", texts.some((t) => t.includes("שטראוס עילית")));
  check(
    "a supplier that never appeared on an item is listed",
    texts.some((t) => t.includes(LONG_EN)),
    "this is what the old datalist could not do",
  );
  check("the orphan snapshot name is also offered", texts.some((t) => t.includes(ORPHAN_NAME)));
  check("the orphan is labelled as unregistered", texts.some((t) => t.includes("לא רשום כספק")));

  await options(page).filter({ hasText: "שטראוס עילית" }).first().click();
  check("selecting fills the field", (await combo(page).inputValue()) === "שטראוס עילית");
  check("the list closes after selecting", (await options(page).count()) === 0);
  check("no item was created by picking a supplier", !state.itemCreated);
  await ctx.close();
}

/* ── 2. free typing stays legal ──────────────────────────────────────────── */
console.log("\n[2] Free text");
{
  const { ctx, page } = await openScreen();
  await combo(page).click();
  await combo(page).fill("ספק שכתבתי ביד");
  await page.waitForTimeout(500);
  check("the typed value is kept verbatim", (await combo(page).inputValue()) === "ספק שכתבתי ביד");
  const texts = await options(page).allInnerTexts();
  check("a create action is offered for it", texts.some((t) => t.includes("יצירת ספק חדש")));
  check("the create action quotes the typed name", texts.some((t) => t.includes("ספק שכתבתי ביד")));
  await page.keyboard.press("Escape");
  check("Escape closes the list", (await options(page).count()) === 0);
  check("Escape does not clear the typed name", (await combo(page).inputValue()) === "ספק שכתבתי ביד");
  await ctx.close();
}

/* ── 3. exact match offers no create ─────────────────────────────────────── */
console.log("\n[3] Exact match");
{
  const { ctx, page } = await openScreen();
  await combo(page).click();
  await combo(page).fill("שטראוס עילית");
  await page.waitForTimeout(500);
  const texts = await options(page).allInnerTexts();
  check("an exact canonical match offers no create action", !texts.some((t) => t.includes("יצירת ספק חדש")));
  await ctx.close();
}

/* ── 4. keyboard + focus ─────────────────────────────────────────────────── */
console.log("\n[4] Keyboard and focus");
{
  const { ctx, page } = await openScreen();
  await combo(page).click();
  await waitForCanonical(page);
  await page.keyboard.press("ArrowDown");
  const active1 = await page.evaluate(() => document.querySelector("input[role=combobox]")?.getAttribute("aria-activedescendant"));
  check("ArrowDown sets aria-activedescendant", !!active1);
  await page.keyboard.press("ArrowDown");
  const active2 = await page.evaluate(() => document.querySelector("input[role=combobox]")?.getAttribute("aria-activedescendant"));
  check("ArrowDown moves the active option", active1 !== active2);
  await page.keyboard.press("ArrowUp");
  const active3 = await page.evaluate(() => document.querySelector("input[role=combobox]")?.getAttribute("aria-activedescendant"));
  check("ArrowUp moves back", active3 === active1);
  const activeText = await page.evaluate(
    (id) => (id ? document.getElementById(id)?.innerText ?? "" : ""),
    active3,
  );
  await page.keyboard.press("Enter");
  check("Enter selects the active option", (await combo(page).inputValue()).length > 0 && activeText.includes(await combo(page).inputValue()));
  check("focus stays on the combobox", await page.evaluate(() => document.activeElement?.getAttribute("role") === "combobox"));
  check("the list closed", (await options(page).count()) === 0);
  check("aria-expanded is false when closed", (await combo(page).getAttribute("aria-expanded")) === "false");
  await ctx.close();
}

/* ── 5. quick-create success → auto-select, item state preserved ─────────── */
console.log("\n[5] Quick-create success");
{
  const { ctx, page, state } = await openScreen();
  // Fill item fields FIRST so the run proves they survive.
  await page.locator("input.inv-input").first().fill("פריט QA SYNTHETIC");
  await combo(page).click();
  await combo(page).fill("ספק חדש לגמרי");
  await page.waitForTimeout(500);
  await options(page).filter({ hasText: "יצירת ספק חדש" }).first().click();

  await page.waitForSelector("[data-supplier-quick-create]", { timeout: 15000 });
  check("a dialog opened", await page.locator("[data-supplier-quick-create]").isVisible());
  check("exactly one backdrop is present", (await page.locator(".crm-modal__backdrop").count()) === 1);
  const nameInput = page.locator("[role=dialog] input").first();
  check("the typed name is pre-filled", (await nameInput.inputValue()) === "ספק חדש לגמרי");
  check("focus moved into the dialog", await page.evaluate(() => !!document.querySelector("[data-supplier-quick-create]")?.contains(document.activeElement)));

  await page.getByRole("button", { name: "יצירת ספק" }).click();
  await page.waitForSelector("[data-supplier-quick-create]", { state: "detached", timeout: 15000 });
  check("the dialog closed on success", (await page.locator("[data-supplier-quick-create]").count()) === 0);
  check("the new supplier is auto-selected", (await combo(page).inputValue()) === "ספק חדש לגמרי");
  check("exactly one supplier was created", state.createCalls.length === 1);
  check("it was created by name", state.createCalls[0]?.name === "ספק חדש לגמרי");
  check("the item name survived", (await page.locator("input.inv-input").first().inputValue()) === "פריט QA SYNTHETIC");
  check("the ITEM was NOT created", !state.itemCreated, "only its own Save may do that");
  check("focus returned to the combobox", await page.evaluate(() => document.activeElement?.getAttribute("role") === "combobox"));
  check("the list did not spring open again", (await options(page).count()) === 0);
  await ctx.close();
}

/* ── 6. cancel preserves everything ──────────────────────────────────────── */
console.log("\n[6] Cancel");
{
  const { ctx, page, state } = await openScreen();
  await page.locator("input.inv-input").first().fill("פריט לפני ביטול");
  await combo(page).click();
  await combo(page).fill("ספק שלא ייווצר");
  await page.waitForTimeout(500);
  await options(page).filter({ hasText: "יצירת ספק חדש" }).first().click();
  await page.waitForSelector("[data-supplier-quick-create]");
  await page.getByRole("button", { name: "ביטול" }).click();
  await page.waitForSelector("[data-supplier-quick-create]", { state: "detached", timeout: 15000 });
  check("no supplier was created", state.createCalls.length === 0);
  check("the typed supplier text is intact", (await combo(page).inputValue()) === "ספק שלא ייווצר");
  check("the item name is intact", (await page.locator("input.inv-input").first().inputValue()) === "פריט לפני ביטול");
  check("focus returned to the combobox", await page.evaluate(() => document.activeElement?.getAttribute("role") === "combobox"));
  await ctx.close();
}
{
  const { ctx, page } = await openScreen();
  await combo(page).click();
  await combo(page).fill("ספק");
  await page.waitForTimeout(500);
  await options(page).filter({ hasText: "יצירת ספק חדש" }).first().click();
  await page.waitForSelector("[data-supplier-quick-create]");
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-supplier-quick-create]", { state: "detached", timeout: 15000 });
  check("Escape closes the quick-create dialog", (await page.locator("[data-supplier-quick-create]").count()) === 0);
  await ctx.close();
}

/* ── 7. validation failure ───────────────────────────────────────────────── */
console.log("\n[7] Validation failure");
{
  const { ctx, page, state } = await openScreen();
  await page.locator("input.inv-input").first().fill("פריט עם ולידציה");
  await combo(page).click();
  await combo(page).fill("ספק לבדיקה");
  await page.waitForTimeout(500);
  await options(page).filter({ hasText: "יצירת ספק חדש" }).first().click();
  await page.waitForSelector("[data-supplier-quick-create]");
  // Empty the required name — the shared validator must refuse before any POST.
  await page.locator("[role=dialog] input").first().fill("");
  await page.getByRole("button", { name: "יצירת ספק" }).click();
  await page.waitForTimeout(400);
  check("the dialog stayed open", (await page.locator("[data-supplier-quick-create]").count()) === 1);
  check("the shared validator's message is shown", (await page.locator(".crm-modal__error").innerText()).includes("יש להזין שם ספק"));
  check("nothing was posted", state.createCalls.length === 0);
  await page.getByRole("button", { name: "ביטול" }).click();
  await page.waitForSelector("[data-supplier-quick-create]", { state: "detached" });
  check("the item field is still intact after a validation failure", (await page.locator("input.inv-input").first().inputValue()) === "פריט עם ולידציה");
  await ctx.close();
}

/* ── 8. API failure ──────────────────────────────────────────────────────── */
console.log("\n[8] API failure");
{
  const { ctx, page } = await openScreen({ createStatus: 500, createError: "שגיאת שרת סינתטית" });
  await page.locator("input.inv-input").first().fill("פריט עם כשל שרת");
  await combo(page).click();
  await combo(page).fill("ספק שייכשל");
  await page.waitForTimeout(500);
  await options(page).filter({ hasText: "יצירת ספק חדש" }).first().click();
  await page.waitForSelector("[data-supplier-quick-create]");
  await page.getByRole("button", { name: "יצירת ספק" }).click();
  await page.waitForTimeout(800);
  check("the dialog stayed open", (await page.locator("[data-supplier-quick-create]").count()) === 1);
  check("the server's message is surfaced", (await page.locator(".crm-modal__error").innerText()).includes("שגיאת שרת סינתטית"));
  await page.getByRole("button", { name: "ביטול" }).click();
  await page.waitForSelector("[data-supplier-quick-create]", { state: "detached" });
  check("the item field survived the failure", (await page.locator("input.inv-input").first().inputValue()) === "פריט עם כשל שרת");
  check("the supplier text survived the failure", (await combo(page).inputValue()) === "ספק שייכשל");
  await ctx.close();
}

/* ── 9. search failure never blocks typing ───────────────────────────────── */
console.log("\n[9] Supplier search failure");
{
  const { ctx, page } = await openScreen({ searchFails: true });
  await combo(page).click();
  await combo(page).fill("ספק כלשהו");
  await page.waitForTimeout(700);
  check("the field still holds what was typed", (await combo(page).inputValue()) === "ספק כלשהו");
  const txt = await page.locator(".inv-sup__list").innerText().catch(() => "");
  check("the failure is stated, not silent", txt.includes("לא הצלחנו לטעון ספקים"));
  check("create is still offered", txt.includes("יצירת ספק חדש"));
  await ctx.close();
}

/* ── 10. duplicates: keep new ────────────────────────────────────────────── */
console.log("\n[10] Duplicate advisory — keep the new supplier");
{
  const matches = [{ id: 101, name: "שטראוס עילית", isActive: true, phone: "972501234567", email: null, taxId: null, reasons: ["NAME"] }];
  const { ctx, page, state } = await openScreen({ possibleMatches: matches });
  await combo(page).click();
  await combo(page).fill("שטראוס עלית");
  await page.waitForTimeout(500);
  await options(page).filter({ hasText: "יצירת ספק חדש" }).first().click();
  await page.waitForSelector("[data-supplier-quick-create]");
  await page.getByRole("button", { name: "יצירת ספק" }).click();
  await page.waitForTimeout(700);
  check("the advisory is shown", (await page.locator("[data-supplier-quick-create]").innerText()).includes("ייתכן שהספק כבר קיים"));
  check("still exactly one backdrop — no stacked modal", (await page.locator(".crm-modal__backdrop").count()) === 1);
  check("the supplier was created first (non-blocking policy)", state.createCalls.length === 1);
  await page.getByRole("button", { name: "להמשיך עם הספק החדש" }).click();
  await page.waitForSelector("[data-supplier-quick-create]", { state: "detached", timeout: 15000 });
  check("the NEW supplier's name is selected", (await combo(page).inputValue()) === "שטראוס עלית");
  await ctx.close();
}

/* ── 11. duplicates: choose the existing one ─────────────────────────────── */
console.log("\n[11] Duplicate advisory — choose the existing supplier");
{
  const matches = [{ id: 101, name: "שטראוס עילית", isActive: true, phone: "972501234567", email: null, taxId: null, reasons: ["NAME"] }];
  const { ctx, page } = await openScreen({ possibleMatches: matches });
  await combo(page).click();
  await combo(page).fill("שטראוס עלית");
  await page.waitForTimeout(500);
  await options(page).filter({ hasText: "יצירת ספק חדש" }).first().click();
  await page.waitForSelector("[data-supplier-quick-create]");
  await page.getByRole("button", { name: "יצירת ספק" }).click();
  await page.waitForTimeout(700);
  await page.locator("[role=dialog] .crm-row").first().click();
  await page.waitForSelector("[data-supplier-quick-create]", { state: "detached", timeout: 15000 });
  check("the EXISTING supplier's name is selected", (await combo(page).inputValue()) === "שטראוס עילית");
  await ctx.close();
}

/* ── 12. the edit screen uses the same field ─────────────────────────────── */
console.log("\n[12] Edit screen");
{
  const { ctx, page, state } = await openScreen({ screen: "edit" });
  check("the edit form shows the item's stored supplier", (await combo(page).inputValue()) === ORPHAN_NAME);
  await combo(page).click();
  // Opening a field that already holds a value must browse the full list, not
  // filter by the one name already in the box.
  await waitForCanonical(page);
  check("opening a pre-filled field still shows the stored value unchanged", (await combo(page).inputValue()) === ORPHAN_NAME);
  const texts = await options(page).allInnerTexts();
  check("canonical suppliers are searchable from Edit too", texts.some((t) => t.includes("שטראוס עילית")));
  await combo(page).fill("ספק חדש מהעריכה");
  await page.waitForTimeout(500);
  await options(page).filter({ hasText: "יצירת ספק חדש" }).first().click();
  await page.waitForSelector("[data-supplier-quick-create]");
  await page.getByRole("button", { name: "יצירת ספק" }).click();
  await page.waitForSelector("[data-supplier-quick-create]", { state: "detached", timeout: 15000 });
  check("quick-create works from Edit", (await combo(page).inputValue()) === "ספק חדש מהעריכה");
  check("one supplier created from Edit", state.createCalls.length === 1);
  check("the edit sheet is still open underneath", (await page.locator(".inv-sheet[role=dialog]").count()) === 1);

  // Nesting check: on Edit the quick-create sits inside the edit SHEET, which is
  // itself a dialog. Escape must close the inner one only — losing the whole
  // edit form because a supplier dialog was dismissed would be data loss.
  await combo(page).fill("עוד ספק");
  await page.waitForTimeout(500);
  await options(page).filter({ hasText: "יצירת ספק חדש" }).first().click();
  await page.waitForSelector("[data-supplier-quick-create]");
  check("quick-create paints above the edit sheet", await page.evaluate(() => {
    const q = document.querySelector(".crm-modal__backdrop");
    const sheet = document.querySelector(".inv-sheet");
    return parseInt(getComputedStyle(q).zIndex || "0", 10) > parseInt(getComputedStyle(sheet).zIndex || "0", 10);
  }));
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-supplier-quick-create]", { state: "detached", timeout: 15000 });
  check("Escape closed the quick-create", (await page.locator("[data-supplier-quick-create]").count()) === 0);
  check("Escape did NOT close the edit sheet", (await page.locator(".inv-sheet[role=dialog]").count()) === 1);
  check("the item's edit fields are intact", (await page.locator(".inv-sheet input.inv-input").first().inputValue()).length > 0);
  await ctx.close();
}

/* ── 13. layout across viewports ─────────────────────────────────────────── */
console.log("\n[13] Layout — list and dialog containment, RTL");
for (const width of WIDTHS) {
  const { ctx, page } = await openScreen({ width });
  await combo(page).click();
  await combo(page).fill(LONG_HE.slice(0, 10));
  await page.waitForTimeout(500);

  const listGeom = await page.evaluate(() => {
    const list = document.querySelector(".inv-sup__list");
    if (!list) return null;
    const r = list.getBoundingClientRect();
    const opts = [...document.querySelectorAll(".inv-sup__opt")].map((o) => {
      const or = o.getBoundingClientRect();
      const main = o.querySelector(".inv-sup__opt-main");
      const mr = main?.getBoundingClientRect();
      const cs = getComputedStyle(o);
      const inner = {
        left: or.left + parseFloat(cs.paddingLeft || "0"),
        right: or.right - parseFloat(cs.paddingRight || "0"),
      };
      return {
        h: Math.round(or.height),
        outOfViewport: Math.round(Math.max(or.right - window.innerWidth, -or.left)),
        textOut: mr ? Math.round(Math.max(mr.right - inner.right, inner.left - mr.left)) : 0,
      };
    });
    const de = document.documentElement, b = document.body;
    const ph = de.style.overflowX, pb = b.style.overflowX;
    de.style.overflowX = "visible"; b.style.overflowX = "visible";
    void b.offsetWidth;
    const hidden = de.scrollWidth > window.innerWidth + 1;
    de.style.overflowX = ph; b.style.overflowX = pb;
    return { listOut: Math.round(Math.max(r.right - window.innerWidth, -r.left)), opts, hidden, dir: getComputedStyle(document.documentElement).direction };
  });

  check(`${width}px — the list renders`, !!listGeom);
  if (listGeom) {
    check(`${width}px — the list stays inside the viewport`, listGeom.listOut <= 1, `out by ${listGeom.listOut}px`);
    check(`${width}px — no option text escapes its row`, listGeom.opts.every((o) => o.textOut <= 1));
    check(`${width}px — options keep a 44px touch target`, listGeom.opts.every((o) => o.h >= 44));
    check(`${width}px — no hidden horizontal overflow`, !listGeom.hidden);
  }

  await options(page).filter({ hasText: "יצירת ספק חדש" }).first().click().catch(() => {});
  const dlg = await page.waitForSelector("[data-supplier-quick-create]", { timeout: 10000 }).catch(() => null);
  if (dlg) {
    const dg = await page.evaluate(() => {
      const d = document.querySelector("[data-supplier-quick-create]");
      const r = d.getBoundingClientRect();
      return {
        out: Math.round(Math.max(r.right - window.innerWidth, -r.left)),
        belowFold: Math.round(r.bottom - window.innerHeight),
        actionsVisible: !!d.querySelector(".crm-modal__actions"),
      };
    });
    check(`${width}px — the dialog stays inside the viewport`, dg.out <= 1, `out by ${dg.out}px`);
    check(`${width}px — the dialog actions exist`, dg.actionsVisible);
    // Existing is not the same as reachable: on a short phone the dialog is
    // taller than its own max-height, so the actions are only usable if it
    // scrolls internally. Scroll to them and require a real, hittable button.
    await page.locator("[data-supplier-quick-create] .crm-modal__actions").scrollIntoViewIfNeeded();
    const act = await page.evaluate(() => {
      const btn = document.querySelector("[data-supplier-quick-create] .crm-modal__actions button");
      const r = btn.getBoundingClientRect();
      return { inView: r.top >= 0 && r.bottom <= window.innerHeight, h: Math.round(r.height) };
    });
    check(`${width}px — the primary action can be scrolled into view`, act.inView);
    check(`${width}px — and is a real touch target`, act.h >= 40);
    check(`${width}px — it is enabled`, await page.getByRole("button", { name: "יצירת ספק" }).isEnabled());
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `supfield-${width}.png`), fullPage: false });
  }
  await ctx.close();
}

await browser.close();
console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
