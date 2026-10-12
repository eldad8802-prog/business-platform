/*
 * Local-only egress guard for the account-recovery E2E (preloaded with NODE_OPTIONS=--require).
 *
 *  1. globalThis.fetch is wrapped: any request to https://api.resend.com/ is answered HERE with
 *     200 {"id":"fake-<n>"} and its JSON body (to, subject, html, text) appended as one line to
 *     .aet-e2e/outbox.jsonl. It never leaves the process.
 *  2. Any other fetch to a host that is not localhost / 127.0.0.1 / ::1 is refused (thrown) and logged
 *     to .aet-e2e/blocked.jsonl — zero external calls.
 *  3. Defence in depth: dns.lookup / dns.promises.lookup refuse every non-local hostname (logged), so
 *     even a code path that bypassed the fetch wrapper could not resolve api.resend.com.
 * Synthetic only.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns");

const DIR = __dirname;
const OUTBOX = path.join(DIR, "outbox.jsonl");
const BLOCKED = path.join(DIR, "blocked.jsonl");
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
let seq = 0;
try {
  const prev = fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8").split("\n").filter(Boolean).length : 0;
  seq = prev;
} catch {}

function logBlocked(kind, target) {
  try {
    fs.appendFileSync(BLOCKED, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind, target }) + "\n");
  } catch {}
}

function urlOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === "string") return input.url;
  return String(input);
}

const originalFetch = globalThis.fetch;
async function guardedFetch(input, init) {
  const url = urlOf(input);
  if (url.startsWith("https://api.resend.com/")) {
    let raw = init && init.body;
    if (raw === undefined && input && typeof input.text === "function") raw = await input.clone().text();
    let body = {};
    try {
      body = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {}
    const id = `fake-${++seq}`;
    const line = {
      fakeId: id,
      at: new Date().toISOString(),
      url,
      to: body.to,
      from: body.from,
      subject: body.subject,
      html: body.html,
      text: body.text,
      idempotencyKey: init && init.headers ? (init.headers["Idempotency-Key"] || init.headers["idempotency-key"] || null) : null,
    };
    fs.appendFileSync(OUTBOX, JSON.stringify(line) + "\n");
    return new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  if (host && !LOCAL.has(host)) {
    logBlocked("fetch", url.slice(0, 200));
    throw new TypeError(`aet-e2e egress guard: blocked non-local fetch to ${host}`);
  }
  return originalFetch(input, init);
}
guardedFetch.__aetGuard = true;
globalThis.fetch = guardedFetch;

function isLocalName(h) {
  return LOCAL.has(h) || h === "" || /^127\./.test(h);
}
const origLookup = dns.lookup;
dns.lookup = function guardedLookup(hostname, options, callback) {
  if (!isLocalName(String(hostname))) {
    logBlocked("dns", String(hostname));
    const cb = typeof options === "function" ? options : callback;
    const err = Object.assign(new Error(`aet-e2e egress guard: getaddrinfo blocked ${hostname}`), { code: "ENOTFOUND", hostname });
    process.nextTick(() => cb(err));
    return {};
  }
  return origLookup.apply(this, arguments);
};
dns.lookup.__aetGuard = true;
const origPLookup = dns.promises.lookup;
dns.promises.lookup = async function guardedPLookup(hostname, options) {
  if (!isLocalName(String(hostname))) {
    logBlocked("dns.promises", String(hostname));
    throw Object.assign(new Error(`aet-e2e egress guard: getaddrinfo blocked ${hostname}`), { code: "ENOTFOUND", hostname });
  }
  return origPLookup.call(this, hostname, options);
};
