/**
 * Revenue authentication-boundary audit (R0.1) — READ-ONLY, MUTATION-SAFE.
 *
 * The audit found that every Revenue route renders for an anonymous visitor.
 * That is not the same claim as "business data or actions are exposed". This
 * separates the two:
 *
 *   1. What does an anonymous visitor actually SEE on each page?
 *   2. What do the management APIs return without a session?
 *   3. Can an anonymous caller MUTATE anything?
 *
 * Mutation probes deliberately target ids that cannot exist, so a missing auth
 * gate is revealed by the status code (404/400 instead of 401) without any real
 * coupon or offer ever being touched. Nothing here can change state.
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3124";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".revenue-auth");
const TOKEN_FILE = process.env.AUDIT_TOKEN_FILE;

/** An id far outside any real sequence — nothing here can be mutated. */
const IMPOSSIBLE_ID = "999999999";
const IMPOSSIBLE_UUID = "00000000-0000-0000-0000-000000000000";

const PAGES = ["/revenue", "/revenue?view=create", "/revenue/redeem", "/coupon-design"];

const READS = [
  "/api/revenue/coupons/mine",
  "/api/revenue/coupons/my-business",
  "/api/offers",
  "/api/revenue/coupons/active",
  "/api/revenue/coupons/" + IMPOSSIBLE_UUID,
  "/api/revenue/coupons/" + IMPOSSIBLE_ID + "/code",
];

/** Every probe targets a non-existent entity: a missing gate shows as 404, not a change. */
const MUTATIONS = [
  ["POST", "/api/revenue/coupons/" + IMPOSSIBLE_ID + "/disable", null],
  ["POST", "/api/revenue/coupons/" + IMPOSSIBLE_ID + "/enable", null],
  ["POST", "/api/offers/" + IMPOSSIBLE_ID + "/coupon", null],
  ["POST", "/api/coupons/" + IMPOSSIBLE_UUID + "/redeem", null],
  ["POST", "/api/offers", { title: "", customerBenefitText: "", validUntil: "" }],
];

const results = [];
function record(kind, target, status, note) {
  results.push({ kind, target, status, note });
  console.log("  " + status + "  " + kind + " " + target + (note ? " — " + note : ""));
}

async function probe(page, list, label) {
  console.log("\n=== " + label + " ===");
  for (const entry of list) {
    const [method, url, body] = Array.isArray(entry) ? entry : ["GET", entry, null];
    const r = await page.evaluate(
      async ([m, u, b]) => {
        try {
          const res = await fetch(u, {
            method: m,
            headers: b ? { "content-type": "application/json" } : {},
            body: b ? JSON.stringify(b) : undefined,
          });
          const text = await res.text();
          return { status: res.status, len: text.length, head: text.slice(0, 120) };
        } catch (e) {
          return { status: 0, len: 0, head: String(e).slice(0, 80) };
        }
      },
      [method, url, body]
    );
    record(method, url, r.status, "len=" + r.len + " " + r.head.replace(/\s+/g, " ").slice(0, 80));
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  // ---------- ANONYMOUS ----------
  const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const anonPage = await anon.newPage();
  // Land on a neutral origin page first so relative fetches resolve, with no token.
  await anonPage.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await anonPage.evaluate(() => localStorage.clear());

  console.log("=== ANONYMOUS PAGE CONTENT ===");
  const pageViews = [];
  for (const p of PAGES) {
    const resp = await anonPage.goto(BASE + p, { waitUntil: "load", timeout: 60000 }).catch(() => null);
    await anonPage.waitForTimeout(2500);
    const seen = await anonPage.evaluate(() => ({
      url: location.pathname + location.search,
      text: (document.body.innerText || "").replace(/\s+/g, " ").trim(),
      // Anything that would be business data leaking before a 401.
      hasBusinessName: /חברת|בע"מ|עוסק/.test(document.body.innerText || ""),
      buttons: Array.from(document.querySelectorAll("button"))
        .filter((b) => b.offsetParent !== null)
        .map((b) => (b.textContent || "").trim().slice(0, 24)),
    }));
    pageViews.push({ route: p, status: resp ? resp.status() : null, ...seen });
    console.log(
      "  " + p + " -> " + (resp ? resp.status() : "?") + " landed=" + seen.url +
      " textLen=" + seen.text.length + " businessData=" + seen.hasBusinessName +
      " buttons=" + JSON.stringify(seen.buttons)
    );
    console.log("     text: " + seen.text.slice(0, 160));
  }

  await probe(anonPage, READS, "ANONYMOUS READS");
  await probe(anonPage, MUTATIONS, "ANONYMOUS MUTATION ATTEMPTS (impossible ids — cannot change state)");

  // ---------- AUTHENTICATED (control group) ----------
  const token = JSON.parse(await readFile(TOKEN_FILE, "utf8")).token;
  const authCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const authPage = await authCtx.newPage();
  await authPage.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await authPage.evaluate((t) => localStorage.setItem("token", t), token);
  // The app sends the bearer itself; here we replicate it so the control group
  // exercises the same routes with a session.
  await authPage.addInitScript((t) => {
    const orig = window.fetch;
    window.fetch = (input, init = {}) => {
      const headers = new Headers(init.headers || {});
      if (!headers.has("authorization")) headers.set("authorization", "Bearer " + t);
      return orig(input, { ...init, headers });
    };
  }, token);
  await authPage.goto(BASE + "/revenue", { waitUntil: "load" });
  await authPage.waitForTimeout(1500);
  await probe(authPage, READS, "AUTHENTICATED READS (control)");

  await writeFile(path.join(OUT, "auth-boundary.json"), JSON.stringify({ pageViews, results }, null, 1));

  // ---------- VERDICT ----------
  console.log("\n=== VERDICT ===");
  const anonReads = results.filter((r) => r.kind === "GET").slice(0, READS.length);
  const anonMut = results.filter((r) => r.kind === "POST").slice(0, MUTATIONS.length);

  const leakedReads = anonReads.filter((r) => r.status === 200 &&
    !r.target.includes("/active") && !r.target.includes(IMPOSSIBLE_UUID));
  console.log("management reads readable anonymously: " +
    (leakedReads.length ? leakedReads.map((r) => r.target + "=" + r.status).join(", ") : "NONE"));

  // A mutation is GATED if it was refused, whatever status it chose to say so
  // with. Two routes refuse correctly but with the wrong code — a redemption
  // attempt answers 400 carrying an "Unauthorized" body (its route throws a
  // ValidationError), and POST /api/offers answers 410 because the endpoint is
  // retired. Neither is an exposure, and calling them "ungated" would raise a
  // false blocker; they are reported separately as status-code findings.
  const refused = (r) =>
    r.status === 401 || r.status === 403 ||
    /Unauthorized|Forbidden/i.test(r.note) || r.status === 410;
  const ungated = anonMut.filter((r) => !refused(r));
  const wrongStatus = anonMut.filter(
    (r) => refused(r) && r.status !== 401 && r.status !== 403
  );
  console.log("mutations NOT refused anonymously: " +
    (ungated.length ? ungated.map((r) => r.target + "=" + r.status).join(", ") : "NONE — every mutation is refused"));
  console.log("refused, but with a non-auth status code: " +
    (wrongStatus.length ? wrongStatus.map((r) => r.target + "=" + r.status).join(", ") : "none"));

  const leakedPages = pageViews.filter((p) => p.hasBusinessName);
  console.log("pages showing business data anonymously: " +
    (leakedPages.length ? leakedPages.map((p) => p.route).join(", ") : "NONE"));

  const blocker = leakedReads.length > 0 || ungated.length > 0 || leakedPages.length > 0;
  console.log("\nSECURITY BLOCKER: " + (blocker ? "YES — see above" : "NO"));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
