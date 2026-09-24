/**
 * sec-B M-8 — CSP proven in a real browser against a real production build.
 *
 *   npx next build && npx next start -p 3107 &
 *   BASE_URL=http://127.0.0.1:3107 node .secb/csp-browser-proof.mjs
 *
 * POSITIVE: key pages load under the enforcing policy with ZERO
 *   securitypolicyviolation events, every <script> carries the nonce, the app
 *   hydrates, and the shell's inline preboot script runs (it needs the nonce).
 * NEGATIVE: a script injected without the nonce does NOT run and IS reported
 *   as a violation — the policy is enforcing, not decorative.
 * HEADERS: CSP present with a per-request nonce, Permissions-Policy present,
 *   X-Powered-By absent.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3107";
let pass = 0;
let fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ok  - ${label}`); }
  else { fail += 1; console.error(`FAIL  - ${label}${detail ? ` — ${detail}` : ""}`); }
};

// A syntactically valid but unverifiable token: enough for the client shell to
// believe it is signed in (the preboot script and shell chrome render), while
// every API call it makes is refused server-side.
const FAKE_TOKEN = `v1.${Buffer.from(JSON.stringify({ sub: 1, iat: 0, exp: 4102444800, tv: 0, sid: "00000000-0000-4000-8000-000000000000" })).toString("base64url")}.AAAA`;

const PAGES = [
  { path: "/login", session: false },
  { path: "/register", session: false },
  { path: "/home", session: false },
  { path: "/app", session: true, expectPreboot: true },
  { path: "/settings/security", session: true },
  { path: "/inventory", session: true },
  { path: "/documents", session: true },
];

async function main() {
  // Header checks (plain HTTP).
  const r1 = await fetch(`${BASE}/login`, { redirect: "manual" });
  const r2 = await fetch(`${BASE}/login`, { redirect: "manual" });
  const csp1 = r1.headers.get("content-security-policy") ?? "";
  const csp2 = r2.headers.get("content-security-policy") ?? "";
  const n1 = /'nonce-([^']+)'/.exec(csp1)?.[1];
  const n2 = /'nonce-([^']+)'/.exec(csp2)?.[1];
  ok("HDR-CSP: the document response carries an ENFORCING CSP (not Report-Only)", csp1.includes("script-src") && !r1.headers.get("content-security-policy-report-only"));
  ok("HDR-CSP: nonce is fresh per request", !!n1 && !!n2 && n1 !== n2);
  ok("HDR-PERMISSIONS: Permissions-Policy present, camera=(self)", /camera=\(self\)/.test(r1.headers.get("permissions-policy") ?? ""));
  ok("HDR-POWEREDBY: X-Powered-By absent", r1.headers.get("x-powered-by") === null);
  const html = await r1.text();
  ok("HDR-CSP: the served HTML's scripts carry that response's nonce", n1 ? html.includes(`nonce="${n1}"`) : false);

  const browser = await chromium.launch();
  try {
    for (const p of PAGES) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.addInitScript(({ token, session }) => {
        window.__cspv = [];
        document.addEventListener("securitypolicyviolation", (e) => {
          window.__cspv.push({ d: e.violatedDirective, u: e.blockedURI, s: (e.sample || "").slice(0, 60) });
        });
        window.__prebootSeen = false;
        new MutationObserver(() => {
          if (document.documentElement.hasAttribute("data-dubiz-intro")) window.__prebootSeen = true;
        }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-dubiz-intro"] });
        if (session) {
          try { localStorage.setItem("token", token); } catch {}
        }
      }, { token: FAKE_TOKEN, session: p.session });
      const consoleCsp = [];
      page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) consoleCsp.push(m.text().slice(0, 200)); });
      const resp = await page.goto(`${BASE}${p.path}`, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => ({ error: e }));
      await page.waitForTimeout(1500);
      const v = await page.evaluate(() => window.__cspv ?? []);
      const status = resp && "status" in resp ? resp.status() : `error ${resp?.error}`;
      ok(`PAGE ${p.path}: loads (status ${status}) with ZERO CSP violations`, v.length === 0 && consoleCsp.length === 0, JSON.stringify(v.concat(consoleCsp)).slice(0, 400));
      const scripts = await page.evaluate(() => Array.from(document.scripts).map((s) => ({ src: s.src, hasNonce: !!s.nonce })));
      const unnonced = scripts.filter((s) => !s.hasNonce && !s.src.includes("facebook"));
      ok(`PAGE ${p.path}: every framework script carries the nonce`, unnonced.length === 0, JSON.stringify(unnonced).slice(0, 300));
      const hydrated = await page.evaluate(() => typeof self.__next_f !== "undefined" && document.readyState === "complete");
      ok(`PAGE ${p.path}: Next.js runtime executed (flight data present)`, hydrated);
      if (p.expectPreboot) {
        // The preboot sets data-dubiz-intro synchronously (observed above even
        // if the overlay removes it again). It only runs if its nonce matched.
        const ran = await page.evaluate(() => window.__prebootSeen === true);
        ok(`PAGE ${p.path}: the nonce'd inline preboot script actually ran`, ran);
      }
      if (p.path === "/login") {
        // NEGATIVE: an injected script without the nonce must not execute.
        await page.evaluate(() => {
          const s = document.createElement("script");
          s.textContent = "window.__injected = 1";
          document.head.appendChild(s);
        }).catch(() => {});
        // strict-dynamic extends trust to script-created EXTERNAL scripts only;
        // inline script text needs the nonce, so both injections must be blocked.
        await page.addScriptTag({ content: "window.__injected2 = 1" }).catch(() => {});
        await page.waitForTimeout(500);
        const injected = await page.evaluate(() => ({ a: window.__injected, b: window.__injected2 }));
        const v2 = await page.evaluate(() => window.__cspv ?? []);
        ok("NEGATIVE: an injected inline script (no nonce) does NOT run", injected.a === undefined && injected.b === undefined, JSON.stringify(injected));
        ok("NEGATIVE: and the browser reports it as a script-src violation", v2.some((x) => /script-src/.test(x.d)), JSON.stringify(v2));
      }
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
