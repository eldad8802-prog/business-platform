/**
 * sec-B M-8 — CSP proven in a real browser against a real production build.
 *
 *   npx next build && npx next start -p 3107 &
 *   BASE_URL=http://127.0.0.1:3107 node .secb/csp-browser-proof.mjs
 *
 * POSITIVE: key pages load under the enforcing policy with ZERO
 *   securitypolicyviolation events, every server-rendered <script> carries the
 *   response's nonce, the Next.js runtime executes, and the shell's inline
 *   preboot script (nonce'd) runs.
 * NEGATIVE: markup injected INTO THE SERVED HTML (a stored-XSS stand-in: an
 *   inline <script> and an inline event handler, neither with the nonce) does
 *   NOT execute, and the browser reports script-src violations. The injection
 *   is done by rewriting the HTTP response body in flight, keeping the server's
 *   CSP header — page.evaluate() is NOT used for this, because DevTools
 *   evaluation bypasses CSP and would prove nothing.
 * HEADERS: CSP present (enforcing) with a per-request nonce, Permissions-Policy
 *   present, X-Powered-By absent.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3107";
let pass = 0;
let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ok  - ${label}`); }
  else { fail += 1; console.error(`FAIL  - ${label}${detail ? ` — ${detail}` : ""}`); }
};

// Syntactically a token, verifiable by nobody: the client shell believes it is
// signed in (preboot, shell chrome), while every API call is refused.
const FAKE_TOKEN = `v1.${Buffer.from(JSON.stringify({ sub: 1, iat: 0, exp: 4102444800, tv: 0, sid: "00000000-0000-4000-8000-000000000000" })).toString("base64url")}.AAAA`;

const PAGES = [
  { path: "/login", session: false },
  { path: "/register", session: false },
  { path: "/home", session: false },
  { path: "/app", session: true },
  { path: "/settings/security", session: true },
  { path: "/inventory", session: true },
  { path: "/documents", session: true },
];

async function newWatchedPage(browser, session) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(({ token, session }) => {
    window.__cspv = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspv.push({ d: e.violatedDirective, u: e.blockedURI, s: (e.sample || "").slice(0, 60) });
    });
    if (session) {
      try { localStorage.setItem("token", token); } catch {}
    }
  }, { token: FAKE_TOKEN, session });
  const consoleCsp = [];
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) consoleCsp.push(m.text().slice(0, 200)); });
  return { ctx, page, consoleCsp };
}

async function main() {
  const r1 = await fetch(`${BASE}/login`, { redirect: "manual" });
  const r2 = await fetch(`${BASE}/login`, { redirect: "manual" });
  const csp1 = r1.headers.get("content-security-policy") ?? "";
  const n1 = /'nonce-([^']+)'/.exec(csp1)?.[1];
  const n2 = /'nonce-([^']+)'/.exec(r2.headers.get("content-security-policy") ?? "")?.[1];
  ok("HDR-CSP: the document response carries an ENFORCING CSP (not Report-Only)", csp1.includes("script-src") && !r1.headers.get("content-security-policy-report-only"));
  ok("HDR-CSP: nonce is fresh per request", !!n1 && !!n2 && n1 !== n2);
  ok("HDR-PERMISSIONS: Permissions-Policy present, camera=(self)", /camera=\(self\)/.test(r1.headers.get("permissions-policy") ?? ""));
  ok("HDR-POWEREDBY: X-Powered-By absent", r1.headers.get("x-powered-by") === null);
  const html = await r1.text();
  const tags = html.match(/<script\b[^>]*>/g) ?? [];
  const bare = tags.filter((t) => !t.includes(`nonce="${n1}"`));
  ok("HDR-CSP: every <script> in the served HTML carries that response's nonce", tags.length > 0 && bare.length === 0, bare.slice(0, 3).join(" "));

  const browser = await chromium.launch();
  try {
    for (const p of PAGES) {
      const { ctx, page, consoleCsp } = await newWatchedPage(browser, p.session);
      const resp = await page.goto(`${BASE}${p.path}`, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => ({ error: e }));
      await page.waitForTimeout(1500);
      const v = await page.evaluate(() => window.__cspv ?? []);
      const status = resp && "status" in resp ? resp.status() : `error ${resp?.error}`;
      ok(`PAGE ${p.path}: loads (status ${status}) with ZERO CSP violations`, v.length === 0 && consoleCsp.length === 0, JSON.stringify(v.concat(consoleCsp)).slice(0, 400));
      const inlineBare = await page.evaluate(() => Array.from(document.scripts).filter((s) => !s.src && !s.nonce).length);
      ok(`PAGE ${p.path}: every inline script in the DOM carries the nonce`, inlineBare === 0, `bare=${inlineBare}`);
      const ran = await page.evaluate(() => typeof self.__next_f !== "undefined" && document.readyState === "complete");
      ok(`PAGE ${p.path}: Next.js runtime executed (flight data present)`, ran);
      await ctx.close();
    }

    // The shell's nonce'd inline preboot: observed at DOMContentLoaded, before
    // the intro overlay can remove what it created.
    {
      const { ctx, page } = await newWatchedPage(browser, true);
      await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
      const ran = await page.evaluate(() => !!document.getElementById("dubiz-intro-preboot") || document.documentElement.hasAttribute("data-dubiz-intro"));
      const v = await page.evaluate(() => window.__cspv ?? []);
      ok("PREBOOT: the nonce'd inline preboot script ran under the policy", ran && v.length === 0);
      await ctx.close();
    }

    // NEGATIVE: markup injected into the served document.
    {
      const { ctx, page } = await newWatchedPage(browser, false);
      await page.route(`${BASE}/login`, async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          "</head>",
          `<script>window.__injected=1</script><img src="/__nope.png" onerror="window.__injected2=1"></head>`
        );
        await route.fulfill({ response, body });
      });
      const resp = await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
      ok("NEGATIVE: the injected response still carries the server's CSP", /script-src/.test(resp?.headers()["content-security-policy"] ?? ""));
      await page.waitForTimeout(1000);
      const injected = await page.evaluate(() => ({ a: window.__injected, b: window.__injected2 }));
      const v = await page.evaluate(() => window.__cspv ?? []);
      ok("NEGATIVE: an injected inline <script> without the nonce does NOT run", injected.a === undefined, JSON.stringify(injected));
      ok("NEGATIVE: an injected inline event handler does NOT run", injected.b === undefined, JSON.stringify(injected));
      ok("NEGATIVE: the browser reports both as script-src violations", v.filter((x) => /script-src/.test(x.d)).length >= 2, JSON.stringify(v));
      const hydrated = await page.evaluate(() => typeof self.__next_f !== "undefined");
      ok("NEGATIVE: the legitimate (nonce'd) app scripts still ran on that page", hydrated);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\nsec-B CSP browser proof: PASS=${pass} FAIL=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("CSP PROOF CRASH:", e);
  process.exit(3);
});
