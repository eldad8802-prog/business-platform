/**
 * Document review screen — back control while loading, and its shape.
 *
 * Found by the Production chains of #656: on a slow document fetch the review
 * screen showed its loading skeleton with NO back control (the user could not
 * leave until the fetch finished), and once loaded, the top bar's grid column
 * (minmax(120px, auto)) stretched the round control into a 120px-wide bar.
 *
 * Run: build, `npx next start -p 3527`, then `node scripts/qa/back-nav-review-qa.mjs`.
 * Data is injected at the network layer; the document fetch is HELD so the
 * loading state can be observed deterministically.
 */
import { chromium } from "playwright";

const BASE = process.env.QA_BASE ?? "http://localhost:3527";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "mobile", width: 390, height: 844 },
];
let pass = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) pass++;
  else failures.push(name);
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
};
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const b64url = (s) => Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const TOKEN = `v1.${b64url(JSON.stringify({ sub: 9, iat: 1, exp: 4102444800 }))}.qa`;
const NOW = "2026-10-06T09:00:00.000Z";

const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    console.log(`\n=== ${vp.name} ${vp.width}x${vp.height} ===`);
    const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: vp.width, height: vp.height } });
    await ctx.addInitScript((t) => localStorage.setItem("token", t), TOKEN);
    await ctx.route("**/api/**", (r) => r.fulfill(json({ error: "qa-not-mocked" }, 404)));
    // The document fetch is HELD until `release()` — the screen stays in its
    // loading state for as long as the test needs.
    let release = () => {};
    let held = Promise.resolve();
    const hold = () => {
      held = new Promise((r) => (release = r));
    };
    let fetchesAnswered = 0;
    await ctx.route(/\/api\/documents\/77$/, async (r) => {
      await held;
      fetchesAnswered += 1;
      await r.fulfill(json({
        document: { id: 77, status: "processing", originalName: "קבלה.jpg", mimeType: "image/jpeg", createdAt: NOW, updatedAt: NOW },
        outputProfile: null,
        extracted: null,
      })).catch(() => {});
    });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/tools/money`, { waitUntil: "networkidle" });

    // 1. Loading state (fetch held): the back control is already there, and
    //    pressing it returns to the origin WITHOUT waiting for the load.
    hold();
    await p.evaluate(() => window.next.router.push("/documents/review/77"));
    await p.waitForURL("**/documents/review/77");
    const backVisible = await p
      .locator("[data-dz-back]:visible")
      .first()
      .waitFor({ state: "visible", timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    check("loading state shows the back control", backVisible);
    if (backVisible) {
      const mode = await p.locator("[data-dz-back]:visible").first().getAttribute("data-dz-back");
      check("loading back resolves to the verified origin", mode === "history", mode ?? "");
      const t0 = Date.now();
      await p.locator("[data-dz-back]:visible").first().click();
      const left = await p
        .waitForURL((u) => u.pathname === "/tools/money", { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      const ms = Date.now() - t0;
      check("back pressed DURING loading returns to the origin", left, new URL(p.url()).pathname);
      check("…without waiting for the document load (still held)", left && fetchesAnswered === 0, `answered=${fetchesAnswered}, ${ms}ms`);
    }
    release(); // let the abandoned request finish; it must not drag the user back
    await p.waitForTimeout(800);
    check("after the held load completes, the user stays on the origin", new URL(p.url()).pathname === "/tools/money", new URL(p.url()).pathname);

    // 2. A fresh entry, loaded (processing top bar): round 44×44, not stretched.
    hold();
    await p.evaluate(() => window.next.router.push("/documents/review/77"));
    await p.waitForURL("**/documents/review/77");
    release();
    await p.waitForLoadState("networkidle").catch(() => {});
    await p.waitForTimeout(800);
    const box = await p.locator("[data-dz-back]:visible").first().boundingBox().catch(() => null);
    check("loaded review top bar has the back control", !!box);
    if (box) check("back control is round 44×44 (not stretched by the grid)", box.width <= 46 && box.height >= 44 && box.height <= 46, `${Math.round(box.width)}×${Math.round(box.height)}`);

    // 3. And it goes back to where the review was opened.
    await p.locator("[data-dz-back]:visible").first().click();
    await p.waitForURL((u) => u.pathname === "/tools/money", { timeout: 10000 }).catch(() => {});
    check("back from the review returns to the origin", new URL(p.url()).pathname === "/tools/money", new URL(p.url()).pathname);
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
