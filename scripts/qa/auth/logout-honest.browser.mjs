#!/usr/bin/env node
/**
 * Honest sign-out in a REAL browser: the client never reports a sign-out the
 * server did not perform, and a device cleared "anyway" finishes the job later
 * with the proof it already holds — an HttpOnly cookie no script can read.
 *
 *   node scripts/qa/auth/logout-honest.browser.mjs
 *
 * lib/client-session.ts is bundled as written and driven in Chromium against a
 * local server with the production cookie attributes (HttpOnly, SameSite=Strict,
 * Path=/api/auth/refresh), so the browser decides what is attached and what a
 * script can see.
 *
 * Synthetic. Zero network beyond 127.0.0.1, zero Production, zero secrets.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ok  - ${name}`); }
  else { fail += 1; console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`); }
};

const bundle = await build({
  entryPoints: [join(ROOT, "lib/client-session.ts")],
  bundle: true,
  format: "iife",
  globalName: "DubizSession",
  write: false,
  platform: "browser",
  target: "es2020",
});
const CLIENT_JS = bundle.outputFiles[0].text;

// ── server ─────────────────────────────────────────────────────────────────
const S = { sessions: new Map(), mode: { logout: "ok", revoke: "ok" }, seen: [] };
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const secret = () => Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function newSession(expSecondsFromNow = 3600, user = 1) {
  const sid = uuid();
  const s = { sid, secret: secret(), revoked: false, user };
  S.sessions.set(sid, s);
  return { ...s, token: `v1.${b64url({ sub: 1, tv: 0, sid, exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`, cookie: `${sid}.${s.secret}` };
}
const setCookie = (v) => `dubiz_rt=${v}; HttpOnly; SameSite=Strict; Path=/api/auth/refresh; Max-Age=${v ? 2592000 : 0}`;
const readCookie = (h) => {
  for (const part of (h ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "dubiz_rt") return v.join("=");
  }
  return null;
};
const body = (req) => new Promise((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => r(s)); });
const json = (res, status, obj, cookie) => {
  res.writeHead(status, { "content-type": "application/json", ...(cookie !== undefined ? { "set-cookie": setCookie(cookie) } : {}) });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/client.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(CLIENT_JS); }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/login")) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><meta charset="utf-8"><title>t</title><script src="/client.js"></script>`);
  }
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    S.seen.push({ path: "logout", cookie: readCookie(req.headers.cookie) });
    if (S.mode.logout === "drop") return req.socket.destroy();
    if (S.mode.logout === "500") return json(res, 500, { error: "Server error" });
    const auth = req.headers.authorization ?? "";
    let sid = null;
    try { sid = JSON.parse(Buffer.from(auth.split(".")[1], "base64url").toString()).sid; } catch { /* */ }
    const s = S.sessions.get(sid);
    if (!s || s.revoked) return json(res, 200, { success: true, alreadySignedOut: true }, "");
    s.revoked = true;
    return json(res, 200, { success: true, scope: "device" }, "");
  }
  if (req.method === "POST" && url.pathname === "/api/auth/refresh/revoke") {
    const cookie = readCookie(req.headers.cookie);
    const raw = await body(req);
    S.seen.push({ path: "revoke", cookie, body: raw });
    if (S.mode.revoke === "drop") return req.socket.destroy();
    if (S.mode.revoke === "hang") return; // never answers: the caller must not wait forever
    if (S.mode.revoke === "slow") { await new Promise((r) => setTimeout(r, 2000)); return json(res, 200, { revoked: false }, ""); } // answers late, CLEARING the cookie
    if (S.mode.revoke === "500") return json(res, 500, { error: "Server error" });
    if (S.mode.revoke === "unproven") return json(res, 200, { revoked: false }, ""); // e.g. a secret past its grace
    const expected = raw ? JSON.parse(raw).expectedSessionId ?? null : null;
    const [sid, sec] = (cookie ?? "").split(".");
    const s = S.sessions.get(sid);
    if (!s || s.secret !== sec || (expected && expected !== sid)) return json(res, 200, { revoked: false }, "");
    s.revoked = true;
    return json(res, 200, { revoked: true }, "");
  }
  if (req.method === "POST" && url.pathname === "/__login") {
    const s = newSession(3600, Number(url.searchParams.get("user") ?? 1));
    return json(res, 200, { token: s.token, sid: s.sid }, s.cookie);
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

async function signedIn({ expired = false } = {}) {
  const ctx = await browser.newContext();
  const s = newSession(expired ? -60 : 3600);
  await ctx.addCookies([{ name: "dubiz_rt", value: s.cookie, domain: "127.0.0.1", path: "/api/auth/refresh", httpOnly: true, sameSite: "Strict" }]);
  const p = await ctx.newPage();
  await p.goto(`${ORIGIN}/`);
  await p.evaluate((t) => localStorage.setItem("token", t), s.token);
  return { ctx, p, s };
}
const jar = async (ctx) => (await ctx.cookies(`${ORIGIN}/api/auth/refresh`)).find((c) => c.name === "dubiz_rt")?.value ?? null;
const ls = (p) => p.evaluate(() => ({ token: localStorage.getItem("token"), marker: localStorage.getItem("dubiz.auth.pendingRevoke"), all: JSON.stringify({ ...localStorage }), cookie: document.cookie }));
const reset = () => { S.mode = { logout: "ok", revoke: "ok" }; S.seen = []; };

// 1. healthy sign-out is unchanged
{
  reset();
  const { ctx, p, s } = await signedIn();
  const r = await p.evaluate(() => window.DubizSession.signOut());
  const st = await ls(p);
  ok("HEALTHY: signed_out", r === "signed_out", r);
  ok("...local token cleared", st.token === null);
  ok("...cookie cleared by the server", (await jar(ctx)) === null);
  ok("...and the server ended that session", S.sessions.get(s.sid).revoked === true);
  await ctx.close();
}

// 2. server 500 → nothing cleared, still signed in
{
  reset(); S.mode.logout = "500";
  const { ctx, p, s } = await signedIn();
  const r = await p.evaluate(() => window.DubizSession.signOut());
  const st = await ls(p);
  ok("SERVER 500: reported as server_failed (no false success)", r === "server_failed", r);
  ok("...the local session is KEPT", st.token === s.token);
  ok("...the cookie is kept", (await jar(ctx)) === s.cookie);
  ok("...the server session is alive, and the UI says so", S.sessions.get(s.sid).revoked === false);
  await ctx.close();
}

// 3. offline → nothing cleared
{
  reset(); S.mode.logout = "drop";
  const { ctx, p, s } = await signedIn();
  const r = await p.evaluate(() => window.DubizSession.signOut());
  ok("OFFLINE: reported as offline", r === "offline", r);
  ok("...the local session is KEPT", (await ls(p)).token === s.token);
  await ctx.close();
}

// 4. "clear anyway" → pending → finished later with the cookie as proof
{
  reset(); S.mode.logout = "500"; S.mode.revoke = "500";
  const { ctx, p, s } = await signedIn();
  await p.evaluate(() => window.DubizSession.signOut());
  await p.evaluate(() => window.DubizSession.forgetDeviceWithPendingRevoke());
  const st = await ls(p);
  const marker = JSON.parse(st.marker ?? "{}");
  ok("CLEAR ANYWAY: the local token is gone", st.token === null);
  ok("...a marker is stored with the session id only", marker.sid === s.sid && Object.keys(marker).sort().join(",") === "sid,since", st.marker);
  ok("...NO secret anywhere in localStorage", !st.all.includes(s.secret) && !/[0-9a-f]{64}/.test(st.all));
  ok("...the refresh cookie is invisible to scripts (HttpOnly)", !st.cookie.includes("dubiz_rt"));
  ok("...but still in the jar, as the proof", (await jar(ctx)) === s.cookie);

  const still = await p.evaluate(() => window.DubizSession.completePendingRevoke());
  ok("SERVER STILL FAILING: still_pending, marker kept, session alive",
    still === "still_pending" && (await ls(p)).marker !== null && S.sessions.get(s.sid).revoked === false, still);

  S.mode.revoke = "ok";
  S.seen = [];
  const done = await p.evaluate(() => window.DubizSession.completePendingRevoke());
  const sent = S.seen.find((x) => x.path === "revoke");
  ok("SERVER BACK: revoked", done === "revoked", done);
  ok("...the browser attached the HttpOnly cookie by itself", sent?.cookie === s.cookie);
  ok("...pinned to the intended session id", JSON.parse(sent?.body || "{}").expectedSessionId === s.sid);
  ok("...the server ended exactly that session", S.sessions.get(s.sid).revoked === true);
  ok("...marker removed, cookie cleared", (await ls(p)).marker === null && (await jar(ctx)) === null);
  await ctx.close();
}

// 5. signed in AGAIN before the pending sign-out completed → the new session survives
{
  reset(); S.mode.logout = "500"; S.mode.revoke = "drop";
  const { ctx, p, s: old } = await signedIn();
  await p.evaluate(() => window.DubizSession.signOut());
  await p.evaluate(() => window.DubizSession.forgetDeviceWithPendingRevoke());
  const fresh = await p.evaluate(async () => {
    const r = await fetch("/__login", { method: "POST", credentials: "same-origin" });
    const j = await r.json();
    localStorage.setItem("token", j.token);
    return j.sid;
  });
  S.mode.revoke = "ok";
  const r = await p.evaluate(() => window.DubizSession.completePendingRevoke());
  ok("RE-SIGNED-IN: the pending completion does NOT end the new session", S.sessions.get(fresh).revoked === false, r);
  ok("...reported unproven, and the marker is dropped", r === "unproven" && (await ls(p)).marker === null);
  ok("...the old session was never touched by a cookie it no longer has", S.sessions.get(old.sid).revoked === false);
  ok("...the person is still signed in", (await ls(p)).token !== null);
  await ctx.close();
}

// 6. expired access token → the cookie route signs out
{
  reset();
  const { ctx, p, s } = await signedIn({ expired: true });
  const r = await p.evaluate(() => window.DubizSession.signOut());
  ok("EXPIRED TOKEN: signed out through the cookie route", r === "signed_out" && S.seen.some((x) => x.path === "revoke") && !S.seen.some((x) => x.path === "logout"), r);
  ok("...that session ended, local cleared", S.sessions.get(s.sid).revoked === true && (await ls(p)).token === null);
  await ctx.close();
}

// 7. signOutAndRedirect navigates only on a confirmed sign-out
{
  reset(); S.mode.logout = "500";
  const { ctx, p } = await signedIn();
  const r = await p.evaluate(() => window.DubizSession.signOutAndRedirect());
  await p.waitForTimeout(300);
  ok("REDIRECT: no navigation on server_failed", r === "server_failed" && new URL(p.url()).pathname === "/", `${r} ${p.url()}`);
  S.mode.logout = "ok";
  await Promise.all([p.waitForURL(`${ORIGIN}/login`, { timeout: 5000 }).catch(() => {}), p.evaluate(() => window.DubizSession.signOutAndRedirect())]);
  ok("...navigates to /login once the server confirms", new URL(p.url()).pathname === "/login", p.url());
  await ctx.close();
}

// 8. expired token + a cookie the server cannot vouch for → cleared, but NOT reported as success
{
  reset(); S.mode.revoke = "unproven";
  const { ctx, p, s } = await signedIn({ expired: true });
  const r = await p.evaluate(() => window.DubizSession.signOut());
  ok("UNCONFIRMED: reported as unconfirmed, never signed_out", r === "unconfirmed", r);
  ok("...the device is cleared (nothing more it can do)", (await ls(p)).token === null);
  ok("...the server session was not claimed ended", S.sessions.get(s.sid).revoked === false);
  await ctx.close();
}
{
  reset(); S.mode.revoke = "unproven";
  const { ctx, p } = await signedIn({ expired: true });
  await Promise.all([
    p.waitForURL(`${ORIGIN}/login`, { timeout: 5000 }).catch(() => {}),
    p.evaluate(() => window.DubizSession.signOutAndRedirect()),
  ]);
  const flag = await p.evaluate(() => sessionStorage.getItem("dubiz.auth.signoutUnconfirmed"));
  ok("...signOutAndRedirect leaves a one-shot 'not confirmed' flag for the login screen", flag === "1", String(flag));
  ok("...which is consumed exactly once", (await p.evaluate(() => window.DubizSession.consumeSignOutUnconfirmed())) === true &&
    (await p.evaluate(() => window.DubizSession.consumeSignOutUnconfirmed())) === false);
  await ctx.close();
}

// Persistent profile helpers: closing it is closing the app (every request dies
// with it); reopening reads the cookie jar and localStorage back from disk.
async function persistentSignedIn(user = 1) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "dubiz-honest-"));
  const ctx = await chromium.launchPersistentContext(dir);
  const s = newSession(3600, user);
  await ctx.addCookies([{ name: "dubiz_rt", value: s.cookie, domain: "127.0.0.1", path: "/api/auth/refresh", httpOnly: true, sameSite: "Strict", expires: Math.floor(Date.now() / 1000) + 86_400 }]);
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  await p.goto(`${ORIGIN}/`);
  await p.evaluate((t) => localStorage.setItem("token", t), s.token);
  return { dir, ctx, p, s };
}
async function reopen(dir) {
  const ctx = await chromium.launchPersistentContext(dir);
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  await p.goto(`${ORIGIN}/login`);
  return { ctx, p };
}
async function pendingAfterFailedSignOut(user = 1) {
  S.mode.logout = "500"; S.mode.revoke = "drop";
  const h = await persistentSignedIn(user);
  await h.p.evaluate(() => window.DubizSession.signOut());
  await h.p.evaluate(() => window.DubizSession.forgetDeviceWithPendingRevoke());
  return h;
}

// 9. pending → the app is CLOSED and started again → finished on the next start
{
  reset();
  const { dir, ctx, s } = await pendingAfterFailedSignOut();
  await ctx.close();
  S.mode.revoke = "ok";
  const again = await reopen(dir);
  const st = await ls(again.p);
  ok("RESTART: the marker survived the restart", st.marker !== null && JSON.parse(st.marker).sid === s.sid);
  ok("...the cookie survived too (the proof)", (await jar(again.ctx)) === s.cookie);
  const r = await again.p.evaluate(() => window.DubizSession.completePendingRevoke());
  ok("...finished on the next start: revoked", r === "revoked" && S.sessions.get(s.sid).revoked === true, r);
  ok("...a second attempt finds nothing to do (idempotent)", (await again.p.evaluate(() => window.DubizSession.completePendingRevoke())) === "none");
  await again.ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 10. pending → ALL browsing data cleared → nothing to send, nothing claimed
{
  reset();
  const { dir, ctx, p, s } = await pendingAfterFailedSignOut();
  await ctx.clearCookies();
  await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  S.mode.revoke = "ok"; S.seen = [];
  const r = await p.evaluate(() => window.DubizSession.completePendingRevoke());
  ok("CLEARED ALL DATA: nothing pending (none), no request sent", r === "none" && !S.seen.some((x) => x.path === "revoke"), r);
  ok("...and nothing is claimed: the server session is untouched (idle expiry or 'all devices' ends it)", S.sessions.get(s.sid).revoked === false);
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 11. pending → only COOKIES cleared → the marker remains, but there is no proof
{
  reset();
  const { dir, ctx, p, s } = await pendingAfterFailedSignOut();
  await ctx.clearCookies();
  S.mode.revoke = "ok"; S.seen = [];
  const r = await p.evaluate(() => window.DubizSession.completePendingRevoke());
  const sent = S.seen.find((x) => x.path === "revoke");
  ok("CLEARED COOKIES: the attempt carries no cookie", sent !== undefined && sent.cookie === null);
  ok("...reported unproven ('could not confirm'), never success", r === "unproven", r);
  ok("...nothing revoked, marker dropped", S.sessions.get(s.sid).revoked === false && (await ls(p)).marker === null);
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 12. pending → only localStorage cleared → no marker; a later sign-in is untouched
{
  reset();
  const { dir, ctx, p } = await pendingAfterFailedSignOut();
  await p.evaluate(() => localStorage.clear());
  S.mode.revoke = "ok"; S.seen = [];
  const r = await p.evaluate(() => window.DubizSession.completePendingRevoke());
  ok("CLEARED STORAGE: no marker → none, no request", r === "none" && S.seen.length === 0, r);
  const fresh = await p.evaluate(async () => (await (await fetch("/__login?user=2", { method: "POST", credentials: "same-origin" })).json()).sid);
  await p.evaluate(() => window.DubizSession.completePendingRevoke());
  ok("...a later sign-in is never ended", S.sessions.get(fresh).revoked === false);
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 13. pending → sign in to a DIFFERENT account (then restart) → that account is never ended
{
  reset();
  const { dir, ctx, p, s: old } = await pendingAfterFailedSignOut(1);
  const other = await p.evaluate(async () => {
    const j = await (await fetch("/__login?user=2", { method: "POST", credentials: "same-origin" })).json();
    localStorage.setItem("token", j.token);
    return j.sid;
  });
  ok("setup: the new session belongs to another account", S.sessions.get(other).user === 2);
  await ctx.close();
  S.mode.revoke = "ok";
  const again = await reopen(dir);
  const r = await again.p.evaluate(() => window.DubizSession.completePendingRevoke());
  ok("NEW ACCOUNT: the pending sign-out does NOT end the other account's session", S.sessions.get(other).revoked === false, r);
  ok("...reported unproven, marker dropped, still signed in to the new account",
    r === "unproven" && (await ls(again.p)).marker === null && (await ls(again.p)).token !== null);
  ok("...the old account's session is untouched by a cookie the device no longer holds", S.sessions.get(old.sid).revoked === false);
  await again.ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 14. a NEW sign-in on a device with a pending sign-out (login / signup / Google)
//     a) the server is back: the old session is ended BEFORE the new cookie replaces the proof
{
  reset();
  const { dir, ctx, p, s: old } = await pendingAfterFailedSignOut(1);
  S.mode.revoke = "ok"; S.seen = [];
  await p.evaluate(() => window.DubizSession.finishPendingRevokeBeforeSignIn());
  ok("SIGN-IN WITH PENDING: the old session is ended first, with the cookie as proof",
    S.sessions.get(old.sid).revoked === true && S.seen.find((x) => x.path === "revoke")?.cookie === old.cookie);
  ok("...marker gone", (await ls(p)).marker === null);
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
//     b) the server hangs: the sign-in waits at most the bound, then the marker is dropped with the new session
{
  reset();
  const { dir, ctx, p, s: old } = await pendingAfterFailedSignOut(1);
  S.mode.revoke = "hang";
  const ms = await p.evaluate(async () => { const t = performance.now(); await window.DubizSession.finishPendingRevokeBeforeSignIn(800); return performance.now() - t; });
  ok("SIGN-IN, SERVER HANGS: never blocks longer than the bound", ms >= 700 && ms < 2500, String(Math.round(ms)));
  const fresh = await p.evaluate(async () => {
    const j = await (await fetch("/__login?user=2", { method: "POST", credentials: "same-origin" })).json();
    localStorage.setItem("token", j.token);
    window.DubizSession.clearPendingRevoke(); // what login / signup / Google now do once the new session is stored
    return j.sid;
  });
  S.mode.revoke = "ok"; S.seen = [];
  const r = await p.evaluate(() => window.DubizSession.completePendingRevoke());
  ok("...after sign-in no stale marker: nothing to complete, no request, no 'not confirmed' notice for the new account",
    r === "none" && !S.seen.some((x) => x.path === "revoke") && (await ls(p)).marker === null, r);
  ok("...the new account's session is alive, signed in", S.sessions.get(fresh).revoked === false && (await ls(p)).token !== null);
  ok("...the old session was not claimed ended", S.sessions.get(old.sid).revoked === false);
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 15. the revoke answers LATE (it clears the cookie): a sign-in that does not
//     wait for it must abort it, or its response deletes the NEW session's cookie
{
  reset();
  const { dir, ctx, p } = await pendingAfterFailedSignOut(1);
  S.mode.revoke = "slow";
  void p.evaluate(() => window.DubizSession.completePendingRevoke()); // the login screen's own attempt, already on the way
  await p.evaluate(() => window.DubizSession.finishPendingRevokeBeforeSignIn(500));
  const fresh = await p.evaluate(async () => {
    const j = await (await fetch("/__login?user=2", { method: "POST", credentials: "same-origin" })).json();
    localStorage.setItem("token", j.token);
    window.DubizSession.clearPendingRevoke();
    return j.sid;
  });
  await p.waitForTimeout(2600); // past the slow revoke's answer
  const c = await jar(ctx);
  ok("LATE REVOKE ANSWER after a sign-in: the NEW session's cookie survives", c !== null && c.startsWith(fresh), String(c && c.slice(0, 8)));
  ok("...and the new session is alive", S.sessions.get(fresh).revoked === false);
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

await browser.close();
server.close();
console.log(`\n[logout-honest.browser] PASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
