#!/usr/bin/env node
/**
 * Refresh client in a REAL browser: several pages, one origin, one HttpOnly
 * cookie jar.
 *
 *   node scripts/qa/auth/refresh-multitab.browser.mjs
 *
 * The unit suite (lib/auth/refresh-client.concurrency.test.ts) models the jar.
 * This drives the bundled module in Chromium against a local server that
 * implements the engine's rotation and grace rules and sets the cookie with the
 * production attributes (HttpOnly, SameSite=Strict, Path=/api/auth/refresh), so
 * the browser — not a model — decides which Set-Cookie wins.
 *
 * Scenarios, each repeated:
 *   WEB LOCKS      4 pages refresh in the same instant → ONE rotation, jar current
 *   LEASE          the same with navigator.locks removed (the fallback path)
 *   LOST RESPONSE  the server rotates and drops the connection → the retry
 *                  recovers inside the grace, jar current
 *   NAVIGATION     a page refreshes and navigates away mid-request → the
 *                  keepalive response still lands in the jar; the next refresh
 *                  works instead of being refused
 *
 * Synthetic. Zero network beyond 127.0.0.1, zero Production, zero secrets.
 */

import http from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GRACE_MS = 120_000;
const TRIALS = Number(process.env.MULTITAB_TRIALS ?? 10);
const PAGES = 4;

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ok  - ${name}`); }
  else { fail += 1; console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ── the module under test, bundled exactly as written ──────────────────────
const bundle = await build({
  entryPoints: [join(ROOT, "lib/auth/refresh-client.ts")],
  bundle: true,
  format: "iife",
  globalName: "DubizRefresh",
  write: false,
  platform: "browser",
  target: "es2020",
});
const CLIENT_JS = bundle.outputFiles[0].text;

// ── server: the engine's rules, a real Set-Cookie ──────────────────────────
const S = { current: "s0", history: new Map(), lastUsedAt: 0, revoked: false, rotations: 0, revocations: 0, n: 0, loseNext: 0, delayMs: 150 };
function reset() {
  Object.assign(S, { current: "s0", history: new Map(), lastUsedAt: 0, revoked: false, rotations: 0, revocations: 0, n: 0, loseNext: 0, delayMs: 150, arrivals: 0 });
}
function rotate() {
  S.history.set(S.current, Date.now() + GRACE_MS);
  S.n += 1;
  S.current = `s${S.n}x${Math.random().toString(36).slice(2, 8)}`;
  S.lastUsedAt = Date.now();
  S.rotations += 1;
  return S.current;
}
function decide(cookie) {
  if (S.revoked || !cookie) return { status: 401 };
  if (cookie === S.current) return { status: 200, secret: rotate() };
  const graceUntil = S.history.get(cookie);
  if (graceUntil === undefined) return { status: 401 };
  if (Date.now() <= graceUntil) return { status: 200, secret: rotate() };
  if (S.lastUsedAt > graceUntil) { S.revoked = true; S.revocations += 1; }
  return { status: 401 };
}
const readCookie = (h) => {
  for (const part of (h ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "dubiz_rt") return v.join("=");
  }
  return null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/client.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(CLIENT_JS);
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/next")) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><meta charset="utf-8"><title>t</title><script src="/client.js"></script>`);
  }
  if (req.method === "POST" && url.pathname === "/api/auth/refresh") {
    S.arrivals = (S.arrivals ?? 0) + 1;
    const cookie = readCookie(req.headers.cookie);
    await sleep(Math.floor(Math.random() * 60));
    const d = decide(cookie);
    await sleep(S.delayMs + Math.floor(Math.random() * 60));
    if (S.loseNext > 0) {
      S.loseNext -= 1;
      req.socket.destroy(); // rotated server-side; the response never arrives
      return;
    }
    if (d.status !== 200) {
      res.writeHead(d.status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "set-cookie": `dubiz_rt=${d.secret}; HttpOnly; SameSite=Strict; Path=/api/auth/refresh; Max-Age=2592000`,
    });
    return res.end(JSON.stringify({ success: true, token: `tok-${d.secret}` }));
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();

async function freshContext({ withoutLocks }) {
  const ctx = await browser.newContext();
  if (withoutLocks) {
    await ctx.addInitScript(() => {
      try { Object.defineProperty(Navigator.prototype, "locks", { get: () => undefined, configurable: true }); } catch { /* */ }
    });
  }
  await ctx.addCookies([{ name: "dubiz_rt", value: S.current, domain: "127.0.0.1", path: "/api/auth/refresh", httpOnly: true, sameSite: "Strict" }]);
  return ctx;
}
const jar = async (ctx) => (await ctx.cookies(`${ORIGIN}/api/auth/refresh`)).find((c) => c.name === "dubiz_rt")?.value ?? null;

async function multiTab(withoutLocks, label) {
  let bad = 0;
  let detail = "";
  let mechanism = "";
  for (let t = 0; t < TRIALS; t++) {
    reset();
    const ctx = await freshContext({ withoutLocks });
    const pages = [];
    for (let i = 0; i < PAGES; i++) {
      const p = await ctx.newPage();
      await p.goto(`${ORIGIN}/`);
      pages.push(p);
    }
    await pages[0].evaluate(() => localStorage.setItem("token", "tok-s0"));
    mechanism = (await pages[0].evaluate(() => (navigator.locks ? "web-locks" : "lease"))) ;
    const results = await Promise.all(pages.map((p) => p.evaluate(() => window.DubizRefresh.refreshAccessToken())));
    const token = await pages[0].evaluate(() => localStorage.getItem("token"));
    const j = await jar(ctx);
    const good = S.rotations === 1 && j === S.current && results.every((r) => r === "refreshed") && token === `tok-${S.current}`;
    if (!good) { bad += 1; detail ||= `trial ${t}: rotations=${S.rotations} jarCurrent=${j === S.current} results=${results}`; }
    await ctx.close();
  }
  ok(`${label} [${mechanism}]: ${PAGES} pages x ${TRIALS} trials → ONE rotation, jar current, every page refreshed`, bad === 0, detail);
}

await multiTab(false, "WEB LOCKS");
await multiTab(true, "LEASE FALLBACK");

// ── lost responses ──────────────────────────────────────────────────────────
//
// Chromium itself may resend a request whose connection dropped before any
// response byte arrived (a reused keep-alive socket). That is the browser
// recovering, not this module, so the server drops enough responses to exhaust
// any browser-level resend and force the CLIENT's own retry schedule — visible
// as an elapsed time past the first retry delay.
{
  reset();
  const ctx = await freshContext({ withoutLocks: false });
  const p = await ctx.newPage();
  await p.goto(`${ORIGIN}/`);
  await p.evaluate(() => localStorage.setItem("token", "tok-s0"));
  S.loseNext = 3;
  const started = Date.now();
  const r = await p.evaluate(() => window.DubizRefresh.refreshAccessToken());
  const elapsed = Date.now() - started;
  console.log(`  [measured] ${S.arrivals} arrivals, ${S.rotations} rotations, ${elapsed} ms`);
  ok("LOST RESPONSES: the session is recovered", r === "refreshed", r);
  ok("...by the client's own retry schedule (elapsed past the 1 s first retry)", elapsed >= 1_000, `${elapsed}`);
  ok("...every rotation but the last was lost, and the last one landed", S.rotations === S.arrivals && S.rotations >= 2, `${S.rotations}/${S.arrivals}`);
  ok("...the jar holds the CURRENT secret", (await jar(ctx)) === S.current);
  ok(`...inside the grace (${elapsed} ms < ${GRACE_MS})`, elapsed < GRACE_MS);
  ok("...nothing revoked", S.revocations === 0);
  await ctx.close();
}

// ── navigation mid-refresh: keepalive lets the response land ───────────────
{
  reset();
  S.delayMs = 600;
  const ctx = await freshContext({ withoutLocks: false });
  const p = await ctx.newPage();
  await p.goto(`${ORIGIN}/`);
  await p.evaluate(() => localStorage.setItem("token", "tok-s0"));
  await p.evaluate(() => { void window.DubizRefresh.refreshAccessToken(); });
  await sleep(80);
  await p.goto(`${ORIGIN}/next`); // the page that started the refresh is gone
  for (let i = 0; i < 40 && S.rotations === 0; i++) await sleep(50);
  await sleep(900);
  const afterNav = await jar(ctx);
  ok("NAVIGATION: the server rotated once", S.rotations === 1, `${S.rotations}`);
  ok("...and the keepalive response's Set-Cookie still reached the jar", afterNav === S.current);
  S.delayMs = 150;
  const r = await p.evaluate(() => window.DubizRefresh.refreshAccessToken());
  ok("...so the next refresh from the new page succeeds (not refused)", r === "refreshed", r);
  ok("...with the current secret, not a grace recovery of a stale one", S.rotations === 2 && (await jar(ctx)) === S.current);
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n[refresh-multitab.browser] PASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
