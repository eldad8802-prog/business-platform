/**
 * Closed beta E2E — the billing screen: a beta owner clicks "issue" on a tax invoice that would need an
 * allocation number and gets the calm "בקרוב" notice; the draft stays a draft. Screenshots at 390 / 1440.
 * env: BASE, OWNER_URL, OUT_DIR. Argument: the beta owner's email.
 */
import path from "node:path";
import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE ?? "http://localhost:3077";
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

async function main() {
  const email = process.argv[2];
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "E2e-Password-123" }),
  }).then((r) => r.json());
  const businessId = login.user.businessId as number;
  const doc = ((await owner.$queryRawUnsafe(
    `SELECT id FROM "BillingDocument" WHERE "businessId" = $1 AND "subtotalAmount" = 8000 AND status::text = 'DRAFT' ORDER BY id DESC LIMIT 1`,
    businessId
  )) as { id: number }[])[0].id;
  const browser = await chromium.launch();
  let failed = 0;
  for (const [w, h] of [[390, 844], [1440, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: "he-IL" });
    await ctx.addInitScript(([t, u]) => {
      localStorage.setItem("token", t as string);
      localStorage.setItem("user", JSON.stringify(u));
    }, [login.token, login.user] as const);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/billing/${doc}`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: /הפק/ }).first().click();
    await page.getByRole("button", { name: "הפק חשבונית" }).last().click();
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: path.join(process.env.OUT_DIR!, `beta-issue-refused-${w}.png`), fullPage: false });
    const shown = text.includes("תתאפשר בקרוב");
    console.log(`  [${shown ? "PASS" : "FAIL"}] @${w}: the "בקרוב" notice is shown after clicking issue`);
    if (!shown) failed++;
    await ctx.close();
  }
  const st = ((await owner.$queryRawUnsafe(`SELECT status::text AS s FROM "BillingDocument" WHERE id = $1`, doc)) as { s: string }[])[0].s;
  console.log(`  [${st === "DRAFT" ? "PASS" : "FAIL"}] the document is still a DRAFT after the clicks (${st})`);
  if (st !== "DRAFT") failed++;
  await browser.close();
  await owner.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
