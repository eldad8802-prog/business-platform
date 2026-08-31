/**
 * Leads W1 — deployment smoke + E2E against a RUNNING environment.
 *
 * This is the harness that verified Leads W1 on Production after the W1
 * release. It is kept so the next Leads change can be verified the same way
 * instead of by hand.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 * Creates its OWN throwaway tenant through the product's PUBLIC registration
 * flow, exercises Leads end to end inside that tenant, smokes the pre-existing
 * domains read-only, and then erases the tenant through the supported
 * `DELETE /api/account` endpoint.
 *
 * ── Safety properties (deliberate, please keep them) ─────────────────────────
 *  1. NO secrets. It holds no credentials, cookies, bearer tokens, database
 *     URLs or signing keys. It mints nothing: it registers a tenant and logs in
 *     through the real auth routes, exactly as a user would.
 *  2. NO impersonation. It never signs a token for an existing user and never
 *     reads another tenant's data.
 *  3. NO direct database access. Every read and write goes through a public
 *     product API. There is no SQL here, destructive or otherwise, and no
 *     fallback that reaches around the application.
 *  4. NO hardcoded ids. Every id it touches comes from a response to a request
 *     it made itself in this run.
 *  5. Synthetic-only data, all of it tagged `QA-W1-<env>-<timestamp>`, with
 *     `example.test` addresses (a reserved TLD that cannot receive mail).
 *  6. Fail-closed target selection — see below.
 *  7. Fail-closed cleanup: if erasure does not succeed the run FAILS loudly and
 *     prints what was left behind. It never tries a second, unsupported route.
 *
 * ── Running it ──────────────────────────────────────────────────────────────
 * The target is never defaulted, because a smoke harness that defaults to
 * Production is one careless `node` away from writing there.
 *
 *   LEADS_SMOKE_BASE=http://localhost:3000 node scripts/qa/leads-w1-prod-smoke.mjs
 *
 * Pointing it at a production-looking host additionally requires an explicit,
 * typed-out opt-in:
 *
 *   LEADS_SMOKE_BASE=https://promaxgroup.co.il \
 *   LEADS_SMOKE_ALLOW_PRODUCTION=yes-write-synthetic-qa-data \
 *     node scripts/qa/leads-w1-prod-smoke.mjs
 *
 * Requires `playwright` (a devDependency) for the UI assertions.
 */
import { chromium } from "playwright";

/* ────────────────────────────────── target selection (fail closed) ──────── */

const BASE = (process.env.LEADS_SMOKE_BASE || "").trim().replace(/\/+$/, "");
const PROD_OPT_IN = "yes-write-synthetic-qa-data";

/** Hosts we treat as "real" and therefore gate behind an explicit opt-in. */
function looksLikeProduction(url) {
  try {
    const { hostname } = new URL(url);
    if (hostname === "localhost" || hostname === "127.0.0.1") return false;
    if (hostname.endsWith(".local")) return false;
    // A Vercel *preview* deployment is disposable; the aliased domain is not.
    if (/^business-platform-[a-z0-9]+-.*\.vercel\.app$/.test(hostname)) return false;
    return true;
  } catch {
    return true; // unparseable → treat as dangerous
  }
}

function refuse(reason) {
  console.error(`REFUSING TO RUN — ${reason}\n`);
  console.error("  LEADS_SMOKE_BASE=http://localhost:3000 node scripts/qa/leads-w1-prod-smoke.mjs");
  console.error("");
  console.error("  For a production-looking host, additionally set:");
  console.error(`  LEADS_SMOKE_ALLOW_PRODUCTION=${PROD_OPT_IN}`);
  process.exit(2);
}

if (!BASE) {
  refuse("LEADS_SMOKE_BASE is not set. The target is never defaulted.");
}
if (!/^https?:\/\//.test(BASE)) {
  refuse(`LEADS_SMOKE_BASE must be an absolute http(s) URL (got "${BASE}").`);
}
if (looksLikeProduction(BASE) && process.env.LEADS_SMOKE_ALLOW_PRODUCTION !== PROD_OPT_IN) {
  refuse(
    `"${BASE}" looks like a real environment. This harness REGISTERS A TENANT and ` +
      `WRITES synthetic data there.\n  Set LEADS_SMOKE_ALLOW_PRODUCTION=${PROD_OPT_IN} to proceed on purpose.`
  );
}

/* ────────────────────────────────────────────── synthetic identity ──────── */

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const ENV_HINT = looksLikeProduction(BASE) ? "PROD" : "LOCAL";
const TAG = `QA-W1-${ENV_HINT}-${STAMP}`;

// Structural guard: every row this harness creates must be identifiable as QA
// at a glance, in any database, forever. If the tag is ever edited into
// something that does not announce itself, refuse rather than write.
if (!/^QA-W1-/.test(TAG)) {
  refuse("the synthetic tag no longer starts with QA-W1- — refusing to write unlabelled data.");
}

const MOBILE = { width: 390, height: 844 };

let passed = 0;
const failures = [];
const createdLeadIds = [];
let TOKEN = null;
let qaBusinessId = null;

const ok = (l) => { passed += 1; console.log(`  ok  ${l}`); };
const bad = (l, d) => { failures.push(`${l} — ${d}`); console.log(`  FAIL  ${l} — ${d}`); };
const check = (c, l, d = "assertion failed") => (c ? ok(l) : bad(l, d));

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, body };
}

const listLen = (b, ...keys) => {
  if (Array.isArray(b)) return b.length;
  for (const k of keys) if (Array.isArray(b?.[k])) return b[k].length;
  return -1;
};

/* ───────────────────────────────────────────────────────────── the run ──── */

async function main() {
  console.log(`Leads W1 smoke against ${BASE}`);
  console.log(`synthetic tag: ${TAG}\n`);

  /* ── isolated QA tenant, via the product's own public flow ────────────── */
  const email = `qa-w1-${STAMP}@example.test`;
  const password = `Qa!${STAMP}!w1`;

  const reg = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "QA W1 Smoke", businessName: TAG }),
  });
  check(
    reg.status === 200 || reg.status === 201,
    "SETUP QA tenant registered through the public flow",
    `status=${reg.status} ${JSON.stringify(reg.body).slice(0, 120)}`
  );
  if (reg.status !== 200 && reg.status !== 201) {
    throw new Error("registration failed — aborting before any further writes");
  }

  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  TOKEN = login.body?.token ?? null;
  check(login.status === 200 && !!TOKEN, "SETUP login through the real auth path", `status=${login.status}`);
  if (!TOKEN) throw new Error("no session token — aborting");

  const me = await api("/api/auth/me");
  qaBusinessId = me.body?.user?.businessId ?? me.body?.businessId ?? null;
  check(me.status === 200, "AUTH /api/auth/me resolves the QA session", `status=${me.status}`);

  /* ── existing domains, READ-ONLY ──────────────────────────────────────── */
  for (const [label, path] of [
    ["Home", "/api/home"],
    ["Customers", "/api/customers?status=all"],
    ["Documents inbox", "/api/documents/inbox"],
    ["Search", "/api/search?limit=10"],
    ["Reports summary", "/api/reports/summary"],
    ["Payments providers", "/api/payments/providers"],
    ["Payments connections", "/api/payments/connections"],
    ["Billing collection", "/api/billing/collection/awaiting"],
    ["Billing documents", "/api/billing/documents"],
  ]) {
    const r = await api(path);
    check(r.status === 200, `SMOKE ${label} responds 200`, `status=${r.status}`);
  }
  const anon = await fetch(`${BASE}/api/home`);
  check(anon.status === 401, "SMOKE unauthenticated access is still refused", `status=${anon.status}`);

  /* ── B. create ────────────────────────────────────────────────────────── */
  const phone = `05${STAMP.slice(-8)}`;
  const create = await api("/api/leads", {
    method: "POST",
    body: JSON.stringify({
      name: `${TAG} lead`,
      phone,
      email: `lead-${STAMP}@example.test`,
      sourceChannel: "MANUAL",
      intentSnapshot: "QA synthetic — Leads W1 deployment smoke",
    }),
  });
  check(create.status === 201, "B1 a lead is created", `status=${create.status} ${JSON.stringify(create.body).slice(0, 140)}`);
  const leadId = create.body?.lead?.id;
  if (Number.isInteger(leadId)) createdLeadIds.push(leadId);
  check(Number.isInteger(leadId), "B2 the response carries the new lead id", `id=${leadId}`);
  if (!Number.isInteger(leadId)) throw new Error("no lead id — aborting");

  const card0 = await api(`/api/leads/${leadId}`);
  check(card0.status === 200, "B3 the lead card loads", `status=${card0.status}`);
  check(!!card0.body?.customer?.id, "B4 a Customer relation was resolved/created");
  check(card0.body?.lead?.status === "NEW", "B5 the lead opens in NEW", `status=${card0.body?.lead?.status}`);
  check(listLen((await api("/api/leads")).body, "leads") >= 1, "B6 it appears in the Leads Inbox");

  /* ── D. validation ────────────────────────────────────────────────────── */
  const badEmail = await api("/api/leads", {
    method: "POST",
    body: JSON.stringify({ name: `${TAG} invalid`, email: "not-an-email" }),
  });
  check(badEmail.status === 400, "D1 an invalid email is REJECTED (400)", `status=${badEmail.status}`);
  const afterBad = await api("/api/leads?status=all");
  check(
    !(afterBad.body?.leads ?? []).some((l) => (l.name || "").includes("invalid")),
    "D2 the rejected lead left no garbage behind"
  );

  /* ── G. duplicate protection ──────────────────────────────────────────── */
  const dup = await api("/api/leads", { method: "POST", body: JSON.stringify({ name: `${TAG} dup`, phone }) });
  check(
    dup.status === 409 && dup.body?.code === "OPEN_LEAD_EXISTS",
    "G1 the partial unique index blocks a 2nd OPEN lead on the same phone",
    `status=${dup.status} ${JSON.stringify(dup.body).slice(0, 120)}`
  );

  /* ── E. status ────────────────────────────────────────────────────────── */
  const quoted = await api(`/api/leads/${leadId}`, { method: "PATCH", body: JSON.stringify({ status: "QUOTED" }) });
  check(quoted.status === 200 && quoted.body?.lead?.status === "QUOTED", "E1 status change accepted", `status=${quoted.status}`);
  check((await api(`/api/leads/${leadId}`)).body?.lead?.status === "QUOTED", "E2 status persists on a fresh read");

  /* ── F. follow-up ─────────────────────────────────────────────────────── */
  const future = new Date(Date.now() + 3 * 86400000).toISOString();
  const fu = await api(`/api/leads/${leadId}`, {
    method: "PATCH",
    body: JSON.stringify({ followUpAt: future, followUpNote: "QA follow-up" }),
  });
  check(fu.status === 200 && fu.body?.followUp?.kind === "scheduled", "F1 a follow-up is set and reads as scheduled", JSON.stringify(fu.body?.followUp));
  check(fu.body?.needsAttention === false, "F2 a future follow-up does not demand attention yet");

  const past = new Date(Date.now() - 2 * 86400000).toISOString();
  const od = await api(`/api/leads/${leadId}`, { method: "PATCH", body: JSON.stringify({ followUpAt: past }) });
  check(od.body?.followUp?.kind === "overdue", "F3 a past follow-up is DERIVED as overdue at read time", JSON.stringify(od.body?.followUp));
  check(od.body?.needsAttention === true, "F4 an overdue lead reports needsAttention");
  check(((await api("/api/leads?needsAction=true")).body?.leads ?? []).some((l) => l.id === leadId), "F5 it surfaces in the needs-action queue");

  const done = await api(`/api/leads/${leadId}`, { method: "PATCH", body: JSON.stringify({ followUpAt: null }) });
  check(done.body?.followUp?.kind === "none", "F6 marking it done clears the follow-up");
  check(!((await api("/api/leads?needsAction=true")).body?.leads ?? []).some((l) => l.id === leadId), "F7 it leaves the needs-action queue immediately");

  /* ── H. close ─────────────────────────────────────────────────────────── */
  const won = await api(`/api/leads/${leadId}`, { method: "PATCH", body: JSON.stringify({ status: "WON" }) });
  check(won.status === 200 && won.body?.lead?.status === "WON", "H1 the lead closes as WON", `status=${won.status}`);
  check(!!won.body?.lead?.closedAt, "H2 closedAt is stamped");
  check((await api(`/api/leads/${leadId}`)).status === 200, "H3 the closed lead still exists — no deletion");
  check(!((await api("/api/leads")).body?.leads ?? []).some((l) => l.id === leadId), "H4 it left the open work queue");
  check(((await api("/api/leads?status=closed")).body?.leads ?? []).some((l) => l.id === leadId), "H5 history preserved under the closed filter");

  const reuse = await api("/api/leads", { method: "POST", body: JSON.stringify({ name: `${TAG} second`, phone }) });
  check(reuse.status === 201, "H6 the same phone may start a NEW lead once the previous one is closed", `status=${reuse.status}`);
  if (Number.isInteger(reuse.body?.lead?.id)) createdLeadIds.push(reuse.body.lead.id);

  /* ── A + C. UI at 390px, RTL ──────────────────────────────────────────── */
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: MOBILE, locale: "he-IL" });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await page.evaluate((t) => localStorage.setItem("token", t), TOKEN);

    await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
    check(
      (await page.getAttribute('a:has-text("לידים")', "href")) === "/leads",
      "A1 the home לידים tile points at /leads"
    );

    await page.goto(`${BASE}/leads`, { waitUntil: "networkidle" });
    await page.waitForSelector(".crm-hd__title", { timeout: 20000 });
    check((await page.textContent(".crm-page")).includes("לידים"), "A2 /leads renders the Leads Inbox");
    const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    check(o.s <= o.c + 1, "A3 no horizontal overflow at 390px", `${o.s} > ${o.c}`);
    check(
      (await page.evaluate(() => getComputedStyle(document.querySelector(".crm-scope")).direction)) === "rtl",
      "A4 the surface renders RTL"
    );

    await page.goto(`${BASE}/leads/${leadId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".crm-id__name", { timeout: 20000 });
    const cardText = await page.textContent("body");
    check(cardText.includes(TAG), "C1 the lead card shows the lead identity");
    check(cardText.includes("QA synthetic"), "C2 the card shows the recorded intent");
    check(cardText.includes("כרטיס הלקוח"), "C3 the card links across to the Customer record");
    check(cardText.includes("הערות") || cardText.includes("קבצים"), "C4 notes / files surfaces are present");
    await ctx.close();
  } finally {
    await browser.close();
  }

  /* ── cleanup, through the supported erasure path only ─────────────────── */
  console.log("");
  const del = await api("/api/account", { method: "DELETE" });
  check(
    del.status === 200 && del.body?.ok === true,
    "CLEANUP the QA tenant was erased through the supported path",
    `status=${del.status} ${JSON.stringify(del.body).slice(0, 120)}`
  );
  check(
    [401, 403].includes((await api("/api/leads")).status),
    "CLEANUP the QA session is dead after erasure"
  );

  if (del.status !== 200 || del.body?.ok !== true) {
    // Fail-closed: say exactly what is left, and do NOT reach around the API to
    // remove it. An unsupported cleanup path is worse than a documented leftover.
    console.error("");
    console.error(`!! CLEANUP DID NOT SUCCEED — leftover QA data needs a human:`);
    console.error(`   tenant: ${TAG}  businessId=${qaBusinessId ?? "unknown"}`);
    console.error(`   leads:  ${createdLeadIds.join(", ") || "none"}`);
  }
}

main()
  .then(() => {
    console.log("");
    if (failures.length) {
      console.log(`LEADS W1 SMOKE FAIL — ${passed} passed, ${failures.length} failed`);
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
    console.log(`LEADS W1 SMOKE PASS — ${passed} checks green.`);
  })
  .catch((err) => {
    console.error("");
    console.error("LEADS W1 SMOKE ABORTED:", err?.message ?? err);
    console.error(`  tenant: ${TAG}  businessId=${qaBusinessId ?? "not created"}`);
    console.error(`  leads:  ${createdLeadIds.join(", ") || "none"}`);
    console.error("  If a tenant was created, erase it with DELETE /api/account as that user.");
    process.exit(1);
  });
