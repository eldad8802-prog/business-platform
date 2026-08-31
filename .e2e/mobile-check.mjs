/**
 * Mobile verification at 390px — a real browser, not an assumption.
 *
 * Checks the two things a narrow RTL screen actually breaks on:
 *   1. horizontal overflow (the page body must never scroll sideways)
 *   2. tap targets and readable structure on the supplier surfaces
 *
 * Auth is injected the way the app itself stores it (localStorage "token"), so
 * no login form is driven and no rate limit is touched.
 *
 * Run: E2E_TOKENS='{...}' node .e2e/mobile-check.mjs
 */

import { chromium, devices } from "playwright";

const BASE = process.env.E2E_BASE || "http://localhost:3001";
const seeded = JSON.parse(process.env.E2E_TOKENS || "null");
const supplierId = process.env.E2E_SUPPLIER_ID || null;

if (!seeded) {
  console.log("E2E_TOKENS required");
  process.exit(1);
}

const results = [];
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`);
    results.push(true);
  } else {
    console.log(`FAIL  ${name}  — ${detail ?? ""}`);
    results.push(false);
    failed++;
  }
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices["iPhone 12"], // 390 × 844, the viewport the audit could not verify
    locale: "he-IL",
  });

  await context.addInitScript(
    ([token]) => {
      try {
        window.localStorage.setItem("token", token);
      } catch {
        /* ignore */
      }
    },
    [seeded.a.token]
  );

  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  const routes = [
    ["/suppliers", "רשימת ספקים"],
    ["/inventory/supplier-purchases", "רכש מספקים"],
    ["/inventory/supplier-purchases/new", "הזמנה חדשה"],
  ];
  if (supplierId) routes.push([`/suppliers/${supplierId}`, "כרטיס ספק"]);

  for (const [route, label] of routes) {
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(3500);

    const metrics = await page.evaluate(() => ({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      dir: document.documentElement.getAttribute("dir"),
      // Anything sticking out past the viewport, ignoring sub-pixel rounding.
      overflowing: Array.from(document.querySelectorAll("*"))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > window.innerWidth + 1;
        })
        .slice(0, 5)
        .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`),
    }));

    check(
      `${label} (${route}): viewport is 390px`,
      metrics.viewport === 390,
      `w=${metrics.viewport}`
    );
    check(
      `${label}: no horizontal overflow`,
      metrics.scrollWidth <= metrics.viewport + 1,
      `scrollWidth=${metrics.scrollWidth} overflowing=${JSON.stringify(metrics.overflowing)}`
    );
    check(
      `${label}: RTL direction is set`,
      metrics.dir === "rtl",
      `dir=${metrics.dir}`
    );
  }

  // The supplier form is the new surface — check it opens and is usable narrow.
  await page.goto(`${BASE}/suppliers`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1000);

  const newButton = page.getByRole("button", { name: /ספק חדש/ }).first();
  const hasButton = (await newButton.count()) > 0;
  check("supplier list: 'ספק חדש' reachable on mobile", hasButton);

  if (hasButton) {
    await newButton.click();
    await page.waitForTimeout(700);

    const nameInput = page.locator("#sup-new-name");
    check(
      "create form: name field present (fast creation path)",
      (await nameInput.count()) > 0
    );

    const sections = await page.locator("details > summary").allTextContents();
    check(
      "create form: optional detail is collapsed into sections",
      sections.length >= 5,
      `sections=${sections.length}: ${sections.map((s) => s.trim().split(" · ")[0]).join(", ")}`
    );

    const collapsedCount = await page.locator("details:not([open])").count();
    check(
      "create form: sections start collapsed (form stays short)",
      collapsedCount >= 5,
      `collapsed=${collapsedCount}`
    );

    // Progressive disclosure must actually work with a tap.
    await page.locator("details > summary").first().click();
    await page.waitForTimeout(300);
    const taxIdVisible = await page.locator("#sup-new-taxId").isVisible();
    check("create form: a section opens on tap and reveals its fields", taxIdVisible);

    const formOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    );
    check("create form: no horizontal overflow with a section open", formOverflow);

    // Tap-target sanity on the primary control.
    const saveBox = await page
      .getByRole("button", { name: /שמירה/ })
      .first()
      .boundingBox();
    check(
      "create form: primary action is a usable tap target (≥40px tall)",
      Boolean(saveBox && saveBox.height >= 40),
      `h=${saveBox?.height}`
    );
  }

  check("no uncaught page errors on the supplier surfaces", consoleErrors.length === 0, consoleErrors[0]);

  await browser.close();
  console.log(`\n${results.filter(Boolean).length}/${results.length} mobile checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
