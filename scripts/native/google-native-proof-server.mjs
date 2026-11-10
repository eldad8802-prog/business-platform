// DIAGNOSTIC ONLY (branch diag/android-google-native) — proof for the proposed Google-in-app flow.
// A dependency-free stand-in for the Dubiz server on localhost:3000 (the debug APK's server.url),
// reproducing only the transport: WebView start → system-browser "Google" → existing callback path →
// back to the app → completion with the WebView's own httpOnly cookie. No real Google, no Dubiz code.
import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";

const KEY = randomBytes(32);
const LOG = process.argv[2] || "proof-server.log";
const used = new Set(); // single-use authorization codes (stands in for Google's own single-use rule)
const issued = new Map(); // code → state it was issued for (stands in for Google binding code to the request)
const log = (line) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
const seal = (o) => { const b = Buffer.from(JSON.stringify(o)).toString("base64url"); return `${b}.${createHmac("sha256", KEY).update(b).digest("base64url")}`; };
const open = (s) => { if (!s) return null; const [b, m] = s.split("."); const want = createHmac("sha256", KEY).update(b || "").digest("base64url"); if (!m || m.length !== want.length || !timingSafeEqual(Buffer.from(m), Buffer.from(want))) return null; const o = JSON.parse(Buffer.from(b, "base64url").toString()); return o.exp > Date.now() ? o : null; };
const cookies = (req) => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), c.slice(i + 1)]; }));
const html = (res, body) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:18px sans-serif;padding:24px">${body}</body>`); };
const json = (res, status, o, headers = {}) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => r(s)); });

const APP_JS = `
const inApp = typeof window.CapacitorSystemBarsAndroidInterface !== "undefined";
const P = window.Capacitor && window.Capacitor.Plugins;
const say = (t) => { document.getElementById("s").textContent = t; window.__proof = (window.__proof||[]).concat(t); };
// The app receives the App Link URL (query) and navigates the WebView to the same path with the code
// moved into the FRAGMENT, so the WebView never requests a URL that carries the code.
function follow(url) { try { const u = new URL(url); if (u.pathname === "/native/google/return") { const p = u.hash ? u.hash.slice(1) : u.searchParams.toString(); P.Browser && P.Browser.close().catch(()=>{}); location.replace("/native/google/return#" + p); } } catch (e) {} }
if (inApp && P && P.App) { P.App.addListener("appUrlOpen", (e) => follow(e.url)); P.App.getLaunchUrl().then((r) => r && r.url && follow(r.url)).catch(()=>{}); }
`;

createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost:3000");
  // What a request log would show: method + full URL as received by the server.
  log(`REQ ${(req.headers["user-agent"] || "").includes("; wv)") ? "WEBVIEW" : "BROWSER"} ${req.method} ${req.url}`);
  if (u.pathname === "/") {
    return html(res, `<h2>proof</h2><div id="s">ready</div><button id="g" style="font-size:22px">המשך עם Google</button>
<script>${APP_JS}
document.getElementById("g").onclick = async () => {
  const r = await fetch("/native/start", { method: "POST", credentials: "include" }); const j = await r.json();
  say("started"); await P.Browser.open({ url: j.authorizeUrl });
};</script>`);
  }
  if (u.pathname === "/native/start" && req.method === "POST") {
    // Same shape as lib/auth/google-oauth.ts: state + nonce + PKCE verifier, sealed, httpOnly, SameSite=Lax.
    const st = { state: randomBytes(16).toString("base64url"), verifier: randomBytes(32).toString("base64url"), exp: Date.now() + 10 * 60_000 };
    log(`START state=${st.state.slice(0, 4)}…`);
    return json(res, 200, { authorizeUrl: `http://localhost:3000/fake-google?state=${st.state}` }, { "set-cookie": `dz_g_start=${seal(st)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600` });
  }
  if (u.pathname === "/fake-google") {
    const code = randomBytes(12).toString("base64url");
    issued.set(code, u.searchParams.get("state"));
    return html(res, `<h2>Google (stand-in)</h2><a id="go" style="font-size:22px" href="/api/auth/google/callback?code=${code}&state=${u.searchParams.get("state")}">Continue as test user</a>`);
  }
  if (u.pathname === "/api/auth/google/callback") {
    // Existing callback path. A native-flow state is NOT exchanged here (the verifier is not in this
    // browser): forward code + state, untouched, to the App Link path. 303, no body, no logging of values.
    // Forwarded in the FRAGMENT: a browser never sends it to a server, so the code is in no request log.
    res.writeHead(303, { location: `/native/google/return#${u.searchParams.toString()}`, "cache-control": "no-store" });
    return res.end();
  }
  if (u.pathname === "/native/google/return") {
    return html(res, `<div id="s">return</div><a id="back" style="font-size:22px;display:none">חזרה לאפליקציה</a>
<script>${APP_JS}
(async () => {
  if (!inApp) {
    // System browser (App Link did not fire): never exchange here — hand the URL to the app, explicitly by package.
    const a = document.getElementById("back"); a.style.display = "block";
    a.href = "intent://localhost:3000/native/google/return?" + location.hash.slice(1) + "#Intent;scheme=http;package=il.co.promaxgroup.dubiz;end";
    say("in-browser: back-to-app button shown"); return;
  }
  const f = new URLSearchParams(location.hash.slice(1));
  if (!f.get("code")) { say("in-app: waiting for code"); return; }
  history.replaceState(null, "", "/native/google/return"); // drop the code from the address bar/history
  const r = await fetch("/native/complete", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: f.get("code"), state: f.get("state") }) });
  say("complete " + r.status + " " + JSON.stringify(await r.json()));
  const again = await fetch("/native/complete", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: f.get("code"), state: f.get("state") }) });
  say("replay " + again.status + " " + JSON.stringify(await again.json()));
})();</script>`);
  }
  if (u.pathname === "/native/complete" && req.method === "POST") {
    const b = JSON.parse((await body(req)) || "{}");
    const st = open(cookies(req).dz_g_start);
    const verdict = { cookieReceived: !!st, stateMatches: !!st && b.state === st.state, codeKnown: issued.get(b.code) === b.state, codeUnused: !used.has(b.code) };
    const ok = verdict.cookieReceived && verdict.stateMatches && verdict.codeKnown && verdict.codeUnused;
    if (verdict.codeKnown) used.add(b.code); // spent on first presentation, success or not
    log(`COMPLETE ok=${ok} ${JSON.stringify(verdict)}`); // verdict only — never the code or state
    // Success clears the start cookie (single use), exactly as the real callback does.
    return json(res, ok ? 200 : 400, { ok, ...verdict }, ok ? { "set-cookie": "dz_g_start=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" } : {});
  }
  res.writeHead(404); res.end();
}).listen(3000, () => log("listening"));
