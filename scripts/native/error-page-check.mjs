// DIAGNOSTIC ONLY (branch diag/android-error-page) — issue 4 on a real emulator: the bundled load-error page
// against 404, 500, server down, no internet, connection coming back and a cold start with no history.
// A tiny stand-in server (spawned and stopped by this script) plays the Dubiz site on localhost:3000.
// usage: node scripts/native/error-page-check.mjs <outDir>
import { _android as android } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2];
const PKG = "il.co.promaxgroup.dubiz";
const BASE = "http://localhost:3000";
mkdirSync(join(OUT, "shots"), { recursive: true });
const results = [];
const log = (o) => { results.push(o); writeFileSync(join(OUT, "error-page.json"), JSON.stringify(results, null, 1)); console.log(JSON.stringify(o).slice(0, 600)); };
const adb = (...a) => { try { return execFileSync("adb", a, { timeout: 30000 }).toString(); } catch (e) { return `ERR ${e.message}`; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the stand-in site ──
const hits = [];
let server = null;
const page = (title, body) => `<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:20px sans-serif;padding:24px"><h1 id="site">${title}</h1>${body}</body>`;
const startServer = () => new Promise((resolve) => {
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url.split("?")[0]}`);
    const p = req.url.split("?")[0];
    if (p === "/" || p === "/app") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page("APP HOME", "")); }
    if (p === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"status":"ok"}'); }
    if (p === "/boom") { res.writeHead(500, { "content-type": "text/html" }); return res.end(page("500", "")); }
    res.writeHead(404, { "content-type": "text/html" }); res.end(page("404", ""));
  }).listen(3000, resolve);
});
const stopServer = () => new Promise((resolve) => { if (!server) return resolve(); server.closeAllConnections?.(); server.close(() => resolve()); server = null; });

const [device] = await android.devices();
const shot = async (n) => writeFileSync(join(OUT, "shots", `${n}.png`), await device.screenshot());
let pg;
const attach = async () => { const wv = await device.webView({ pkg: PKG }, { timeout: 45000 }); pg = await wv.page(); };
const state = () => pg.evaluate(() => ({
  url: location.href,
  site: document.getElementById("site")?.textContent ?? null,
  title: document.getElementById("title")?.textContent ?? null,
  msg: document.getElementById("msg")?.textContent ?? null,
  backShown: document.getElementById("back") ? !document.getElementById("back").hidden : null,
  historyLength: history.length,
  online: navigator.onLine,
  injected: typeof window.WEBVIEW_SERVER_URL === "string" ? window.WEBVIEW_SERVER_URL : null,
}));
const go = async (path) => { try { await pg.goto(BASE + path, { waitUntil: "commit", timeout: 15000 }); } catch {} };
const waitVerdict = async (ms = 9000) => { await sleep(ms); return state(); };
const tap = async (id) => { const b = await pg.evaluate((i) => { const r = document.getElementById(i)?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, dpr: devicePixelRatio } : null; }, id);
  if (!b) return false; adb("shell", "uiautomator", "dump", "/sdcard/ui.xml"); const x = adb("shell", "cat", "/sdcard/ui.xml");
  const m = x.match(/class="android\.webkit\.WebView"[^>]*?bounds="\[(\d+),(\d+)\]/); const top = m ? +m[2] : 0, left = m ? +m[1] : 0;
  adb("shell", "input", "tap", String(Math.round(left + b.x * b.dpr)), String(Math.round(top + b.y * b.dpr))); return true; };
const airplane = (on) => adb("shell", "cmd", "connectivity", "airplane-mode", on ? "enable" : "disable");

log({ check: "env", sdk: adb("shell", "getprop", "ro.build.version.sdk").trim() });
await startServer();
adb("shell", "am", "force-stop", PKG); await sleep(1500);
adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`); await sleep(9000);
await attach();
log({ check: "launch", ...(await state()) });

// 1. 404 — the server answers, the page does not exist.
try {
  await go("/missing");
  const s = await waitVerdict();
  await shot("1-404");
  const hitsBefore = hits.length;
  await sleep(10000);
  const idleHits = hits.slice(hitsBefore);
  const backTapped = await tap("back"); await sleep(4000);
  log({ check: "404", ...s, idleRequestsIn10s: idleHits, afterBack: await state(), backTapped });
} catch (e) { log({ check: "404", error: String(e).slice(0, 200) }); }

// 2. 500 — retry re-requests once (no loop), home leads into the app.
try {
  await go("/boom");
  const s = await waitVerdict();
  await shot("2-500");
  const boomBefore = hits.filter((h) => h === "GET /boom").length;
  await tap("retry"); await sleep(9000);
  const afterRetry = await state();
  await sleep(8000);
  const boomAfter = hits.filter((h) => h === "GET /boom").length;
  await tap("home"); await sleep(5000);
  log({ check: "500", ...s, retryRequestsForBoom: boomAfter - boomBefore, afterRetry, afterHome: await state() });
} catch (e) { log({ check: "500", error: String(e).slice(0, 200) }); }

// 3. The server is down (internet as the emulator has it).
try {
  await go("/");
  await sleep(3000);
  await stopServer();
  await go("/");
  const s = await waitVerdict(10000);
  await shot("3-server-down");
  log({ check: "server-down", ...s });
} catch (e) { log({ check: "server-down", error: String(e).slice(0, 200) }); }

// 4. No internet (airplane mode; the stand-in stays down — adb reverse would otherwise still reach it).
try {
  airplane(true); await sleep(5000);
  await go("/");
  const s = await waitVerdict(10000);
  await shot("4-offline");
  log({ check: "offline", ...s });

  // 5. The connection comes back: the page re-checks by itself (words only), then retry reaches the app.
  await startServer();
  airplane(false); await sleep(12000);
  const recovered = await state();
  await shot("5-recovered");
  const urlBeforeTap = recovered.url;
  await tap("retry"); await sleep(6000);
  log({ check: "recovery", recovered, stayedOnErrorPageUntilTap: urlBeforeTap === recovered.url, afterRetry: await state() });
} catch (e) { log({ check: "offline/recovery", error: String(e).slice(0, 200) }); airplane(false); }

// 6. Cold start with the server down: no history to go back to; retry / home still lead into the app.
try {
  await stopServer();
  adb("shell", "am", "force-stop", PKG); await sleep(1500);
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`); await sleep(9000);
  await attach();
  const s = await waitVerdict(8000);
  await shot("6-cold-no-server");
  await startServer();
  await tap("retry"); await sleep(6000);
  const afterRetry = await state();
  log({ check: "cold-start-no-history", ...s, afterRetry });
} catch (e) { log({ check: "cold-start-no-history", error: String(e).slice(0, 200) }); }

await stopServer();
await device.close();
