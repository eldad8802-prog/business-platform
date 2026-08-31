/**
 * Leads W2 — production post-deploy verification.
 *
 * Same discipline as the W1 deployment harness: registers its OWN throwaway
 * tenants through the public flow, holds no secrets, never touches the database
 * directly, never reads another tenant's data, and erases what it made through
 * `DELETE /api/account`.
 *
 * Registers exactly TWO tenants (the auth rate limit is 3/hour per IP), and the
 * existing-domain smoke reuses tenant A rather than spending a third.
 *
 *   LEADS_SMOKE_BASE=https://... LEADS_SMOKE_ALLOW_PRODUCTION=yes-write-synthetic-qa-data \
 *     node scripts/qa/ui/leads-w2-prod-verify.mjs
 */
import { chromium } from "playwright";

const BASE = (process.env.LEADS_SMOKE_BASE || "").trim().replace(/\/+$/, "");
const PROD_OPT_IN = "yes-write-synthetic-qa-data";

function looksLikeProduction(url) {
  try {
    const { hostname } = new URL(url);
    if (hostname === "localhost" || hostname === "127.0.0.1") return false;
    if (hostname.endsWith(".local")) return false;
    if (/^business-platform-[a-z0-9]+-.*\.vercel\.app$/.test(hostname)) return false;
    return true;
  } catch {
    return true;
  }
}
if (!BASE || !/^https?:\/\//.test(BASE)) {
  console.error("REFUSING TO RUN — set an absolute LEADS_SMOKE_BASE. The target is never defaulted.");
  process.exit(2);
}
if (looksLikeProduction(BASE) && process.env.LEADS_SMOKE_ALLOW_PRODUCTION !== PROD_OPT_IN) {
  console.error(`REFUSING TO RUN — "${BASE}" looks real. Set LEADS_SMOKE_ALLOW_PRODUCTION=${PROD_OPT_IN}.`);
  process.exit(2);
}

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const TAG = `QA-W2-PROD-${STAMP}`;

// Structural guard: every row this harness creates must be identifiable as QA
// at a glance, in any database, forever. If the tag is ever edited into
// something that does not announce itself, refuse rather than write.
if (!/^QA-W2-/.test(TAG)) {
  console.error("REFUSING TO RUN — the synthetic tag no longer starts with QA-W2-.");
  process.exit(2);
}
const MOBILE = { width: 390, height: 844 };
const WAIT = 25000;

let passed = 0;
const failures = [];
const ok = (l) => { passed += 1; console.log(`  ok  ${l}`); };
const bad = (l, d) => { failures.push(`${l} — ${d}`); console.log(`  FAIL  ${l} — ${d}`); };
const check = (c, l, d = "assertion failed") => (c ? ok(l) : bad(l, d));

const makeApi = (ref) => async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(ref.token ? { Authorization: `Bearer ${ref.token}` } : {}),
      ...(init.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* none */ }
  return { status: res.status, body };
};

async function registerTenant(label) {
  const email = `qa-w2p-${label}-${STAMP}@example.test`;
  const password = `Qa!${STAMP}!w2p`;
  const ref = { token: null };
  const api = makeApi(ref);
  const reg = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name: `QA W2P ${label}`, businessName: `${TAG}-${label}` }),
  });
  if (reg.status !== 200 && reg.status !== 201) {
    throw new Error(`register ${label}: ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  ref.token = login.body?.token ?? null;
  if (!ref.token) throw new Error(`login ${label} failed`);
  const me = await api("/api/auth/me");
  return { ref, api, businessId: me.body?.user?.businessId ?? me.body?.businessId ?? null };
}

async function expectText(page, sel, needle, label) {
  try {
    await page.waitForFunction(
      ([s, w]) => { const el = document.querySelector(s); return !!el && (el.textContent || "").includes(w); },
      [sel, needle], { timeout: WAIT }
    );
    ok(label);
  } catch {
    const actual = await page.textContent(sel).catch(() => "<missing>");
    bad(label, `"${needle}" not in ${sel} — got "${String(actual).slice(0, 140)}"`);
  }
}
async function expectGone(page, sel, needle, label) {
  try {
    await page.waitForFunction(
      ([s, w]) => { const el = document.querySelector(s); return !!el && !(el.textContent || "").includes(w); },
      [sel, needle], { timeout: WAIT }
    );
    ok(label);
  } catch { bad(label, `"${needle}" still in ${sel}`); }
}
async function noOverflow(page, where) {
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  check(o.s <= o.c + 1, `J no horizontal overflow — ${where}`, `${o.s} > ${o.c}`);
}

async function main() {
  console.log(`Leads W2 production verification against ${BASE}`);
  console.log(`synthetic tag: ${TAG}\n`);

  const A = await registerTenant("a");
  const B = await registerTenant("b");
  console.log(`  (QA tenants: A=${A.businessId} B=${B.businessId})\n`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: MOBILE, locale: "he-IL" });
  const page = await ctx.newPage();

  try {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await page.evaluate((t) => localStorage.setItem("token", t), A.ref.token);

    /* ===================== 5. existing-domain smoke (READ-ONLY) =========== */
    for (const [label, path] of [
      ["Home", "/api/home"],
      ["Attention", "/api/business-status"],
      ["Leads", "/api/leads"],
      ["Customers", "/api/customers?status=all"],
      ["Conversations", "/api/conversations"],
      ["Documents inbox", "/api/documents/inbox"],
      ["Search", "/api/search?limit=5"],
      ["Reports summary", "/api/reports/summary"],
      ["Payments providers", "/api/payments/providers"],
      ["Billing documents", "/api/billing/documents"],
      ["Billing collection", "/api/billing/collection/awaiting"],
    ]) {
      const r = await A.api(path);
      check(r.status === 200, `SMOKE ${label} responds 200`, `status=${r.status}`);
    }
    const anon = await fetch(`${BASE}/api/home`);
    check(anon.status === 401, "SMOKE unauthenticated access still refused", `status=${anon.status}`);

    /* ===================== A. follow-up due -> Home ======================= */
    const phone = `05${STAMP.slice(-8)}`;
    const created = await A.api("/api/leads", {
      method: "POST",
      body: JSON.stringify({ name: `${TAG} דנה`, phone, intentSnapshot: "QA W2 production" }),
    });
    check(created.status === 201, "SETUP a synthetic lead exists", `status=${created.status}`);
    const leadId = created.body.lead.id;

    const due = await A.api(`/api/leads/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify({ followUpAt: new Date().toISOString(), followUpNote: "לבדוק מחיר" }),
    });
    check(due.body?.needsAttention === true, "A1 the lead needs attention once the follow-up is due");

    const home = await A.api("/api/home");
    check(home.body?.leadsAttention?.count === 1, "A2 Home count reflects it", JSON.stringify(home.body?.leadsAttention));
    check(home.body?.leadsAttention?.href === "/leads?view=needsAction", "A3 Home links to the filtered view");

    await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
    const tile = await page.getAttribute('a[aria-label*="לידים"]', "href").catch(() => null);
    check(tile === "/leads?view=needsAction", "A4 the לידים tile deep-links to the attention queue", `href=${tile}`);
    await noOverflow(page, "home");

    await page.goto(`${BASE}/leads?view=needsAction`, { waitUntil: "networkidle" });
    await page.waitForSelector(".crm-hd__title", { timeout: WAIT });
    await expectText(page, ".crm-page", `${TAG} דנה`, "A5 the link lands on exactly those rows");
    await noOverflow(page, "filtered leads");
    check(
      (await page.evaluate(() => getComputedStyle(document.querySelector(".crm-scope")).direction)) === "rtl",
      "J RTL on the leads surface"
    );

    /* ===================== B. Attention =================================== */
    await page.goto(`${BASE}/attention`, { waitUntil: "networkidle" });
    await expectText(page, "body", `${TAG} דנה`, "B1 the lead appears on Attention");
    await expectText(page, "body", "מעקב להיום", "B2 with the correct reason");
    await expectText(page, "body", "קבעתם לחזור אליו היום", "B3 and its evidence");
    await expectText(page, "body", "לבדוק מחיר", "B4 including the owner's own note");
    await expectText(page, "body", "לידים", "B5 labelled as the Leads domain");
    await noOverflow(page, "attention");

    /* ===================== C. complete ==================================== */
    await page.click('button:has-text("טופל")');
    await expectGone(page, "body", `${TAG} דנה`, "C1 completing from Attention removes it");
    const afterComplete = await A.api("/api/home");
    check(afterComplete.body?.leadsAttention?.count === 0, "C2 the Home count drops to zero");
    const card = await A.api(`/api/leads/${leadId}`);
    check(card.body?.followUp?.kind === "none", "C3 the follow-up is cleared");
    check(card.body?.lead?.status !== "WON", "C4 completing did NOT close the lead");
    await page.reload({ waitUntil: "networkidle" });
    await expectGone(page, "body", `${TAG} דנה`, "C5 still gone after a refresh");

    /* ===================== D. reschedule ================================== */
    const resched = await A.api(`/api/leads/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify({ followUpAt: new Date(Date.now() + 4 * 86400000).toISOString() }),
    });
    check(resched.body?.followUp?.kind === "scheduled", "D1 the new follow-up is scheduled, not due");
    check(resched.body?.needsAttention === false, "D2 it does not demand attention now");
    const homeD = await A.api("/api/home");
    check(homeD.body?.leadsAttention?.count === 0, "D3 Home stays at zero");
    const rr = await A.api(`/api/leads/${leadId}`);
    check(rr.body?.followUp?.kind === "scheduled", "D4 persisted and derived consistently on re-read");

    /* ===================== E. conversation -> lead ======================== */
    const cust = await A.api("/api/customers", {
      method: "POST",
      body: JSON.stringify({ name: `${TAG} יוסי`, phone: `05${STAMP.slice(-7)}2` }),
    });
    check(cust.status === 201, "SETUP a synthetic customer exists", `status=${cust.status}`);
    const conv = await A.api("/api/conversation", {
      method: "POST",
      body: JSON.stringify({ customerId: cust.body.customer.id, channel: "WHATSAPP" }),
    });
    const convId = conv.body?.id ?? conv.body?.conversation?.id;
    check(!!convId, "SETUP a synthetic conversation exists", `status=${conv.status}`);

    const madeLead = await A.api(`/api/conversations/${convId}/lead`, { method: "POST" });
    check(madeLead.status === 201, "E1 Create Lead from a conversation returns 201", `status=${madeLead.status}`);
    check(madeLead.body?.outcome === "created", "E2 outcome is `created`", String(madeLead.body?.outcome));
    check(madeLead.body?.customer?.id === cust.body.customer.id, "E3 the Customer was resolved and linked");
    check(madeLead.body?.lead?.sourceChannel === "WHATSAPP", "E4 the source is preserved from the channel");
    const convLeadId = madeLead.body?.lead?.id;

    await page.goto(`${BASE}/leads/${convLeadId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".crm-id__name", { timeout: WAIT });
    await expectText(page, ".crm-id__name", `${TAG} יוסי`, "E5 the created lead opens and shows its identity");
    await noOverflow(page, "lead card");

    /* ===================== F. idempotency ================================= */
    const secondCall = await A.api(`/api/conversations/${convId}/lead`, { method: "POST" });
    check(secondCall.status === 200, "F1 a repeat call returns 200, not another creation", `status=${secondCall.status}`);
    check(secondCall.body?.outcome === "already_linked", "F2 outcome is `already_linked`");
    check(secondCall.body?.lead?.id === convLeadId, "F3 it returns the SAME lead");
    const allA = await A.api("/api/leads?status=all");
    const forCust = (allA.body?.leads ?? []).filter((l) => l.customer?.id === cust.body.customer.id);
    check(forCust.length === 1, "F4 exactly one lead exists for that contact", `count=${forCust.length}`);

    /* ===================== G. existing open lead ========================== */
    const conv2 = await A.api("/api/conversation", {
      method: "POST",
      body: JSON.stringify({ customerId: cust.body.customer.id, channel: "WHATSAPP" }),
    });
    const conv2Id = conv2.body?.id ?? conv2.body?.conversation?.id;
    const adopt = await A.api(`/api/conversations/${conv2Id}/lead`, { method: "POST" });
    check(adopt.status === 200 && adopt.body?.outcome === "linked_existing", "G1 a second conversation reuses the open lead", String(adopt.body?.outcome));
    check(adopt.body?.lead?.id === convLeadId, "G2 no duplicate lead");

    /* ===================== H. closed historical lead ====================== */
    await A.api(`/api/leads/${convLeadId}`, { method: "PATCH", body: JSON.stringify({ status: "WON" }) });
    const conv3 = await A.api("/api/conversation", {
      method: "POST",
      body: JSON.stringify({ customerId: cust.body.customer.id, channel: "WHATSAPP" }),
    });
    const conv3Id = conv3.body?.id ?? conv3.body?.conversation?.id;
    const afterClosed = await A.api(`/api/conversations/${conv3Id}/lead`, { method: "POST" });
    check(afterClosed.status === 201, "H1 a closed lead is NOT adopted — a new enquiry starts a new lead", `status=${afterClosed.status}`);
    check(afterClosed.body?.lead?.id !== convLeadId, "H2 it is a different lead");
    const closedStill = await A.api(`/api/leads/${convLeadId}`);
    check(closedStill.body?.lead?.status === "WON", "H3 the closed lead is preserved, not reopened");

    /* ===================== I. tenant isolation ============================ */
    const stolenLink = await B.api(`/api/conversations/${convId}/lead`, { method: "POST" });
    check(stolenLink.status === 404, "I1 cross-tenant Create Lead is refused (404)", `status=${stolenLink.status}`);
    const stolenRead = await B.api(`/api/leads/${convLeadId}`);
    check(stolenRead.status === 404, "I2 cross-tenant read is refused (404)", `status=${stolenRead.status}`);
    const stolenPatch = await B.api(`/api/leads/${convLeadId}`, { method: "PATCH", body: JSON.stringify({ status: "LOST" }) });
    check(stolenPatch.status === 404, "I3 cross-tenant update is refused (404)", `status=${stolenPatch.status}`);
    const bList = await B.api("/api/leads?status=all");
    check((bList.body?.leads ?? []).length === 0, "I4 tenant B sees none of tenant A's leads");
    const untouched = await A.api(`/api/leads/${convLeadId}`);
    check(untouched.body?.lead?.status === "WON", "I5 tenant A's lead is unchanged after every attempt");

    /* ===================== J. mobile actions ============================== */
    await A.api(`/api/leads/${leadId}`, { method: "PATCH", body: JSON.stringify({ followUpAt: new Date().toISOString() }) });
    await page.goto(`${BASE}/attention`, { waitUntil: "networkidle" });
    await expectText(page, "body", `${TAG} דנה`, "J1 the item is back on Attention at 390px");
    await page.click('button:has-text("דחה")');
    await expectGone(page, "body", `${TAG} דנה`, "J2 reschedule works from Attention at 390px");
    const snoozed = await A.api(`/api/leads/${leadId}`);
    check(snoozed.body?.followUp?.kind === "scheduled", "J3 the snooze moved it into the future");

    const tapTargets = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button")).map((b) => b.getBoundingClientRect().height).filter((h) => h > 0)
    );
    check(
      tapTargets.length === 0 || Math.min(...tapTargets) >= 30,
      "J4 touch targets are usable",
      `min=${tapTargets.length ? Math.min(...tapTargets) : "n/a"}`
    );
  } catch (err) {
    bad("E2E RUN", err?.message ?? String(err));
  } finally {
    await ctx.close();
    await browser.close();
    console.log("");
    const leftover = [];
    for (const [label, t] of [["A", A], ["B", B]]) {
      const del = await t.api("/api/account", { method: "DELETE" });
      const done = del.status === 200 && del.body?.ok === true;
      check(done, `CLEANUP tenant ${label} erased through the supported path`, `status=${del.status}`);
      if (!done) leftover.push(`${label}=${t.businessId}`);
    }
    console.log(`\nQA tenants: A=${A.businessId} B=${B.businessId}  (tag ${TAG})`);

    // Fail-closed: name exactly what survived, and stop. Reaching around the
    // API to remove it would be worse than a documented leftover.
    if (leftover.length) {
      console.error("");
      console.error(`!! CLEANUP DID NOT SUCCEED — leftover QA tenants need a human: ${leftover.join(", ")}`);
      console.error(`   tag: ${TAG}`);
    }
  }

  console.log("");
  if (failures.length) {
    console.log(`LEADS W2 PRODUCTION FAIL — ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`LEADS W2 PRODUCTION PASS — ${passed} checks green.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
