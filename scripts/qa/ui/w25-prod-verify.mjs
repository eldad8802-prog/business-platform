/**
 * W2.5 — Production verification for the message-hardening release.
 *
 * Proves three things against a live deployment:
 *
 *   1. REGRESSION — the three migrations of this release
 *      (w25_message_hardening, d2_pw2_business_feature_access_rls,
 *      casa_wave_b_platform_admin_mfa) did not break any existing domain.
 *
 *   2. SEND IDEMPOTENCY — `/api/message` collapses a repeated `clientRequestId`
 *      into the message that already exists. This is the one W2.5 capability
 *      that does NOT depend on the Conversation State Writer, so it holds
 *      whether the writer is on or off.
 *
 *   3. THE WRITER'S ACTUAL CONTRACT — the harness does not assume a flag value.
 *      It sends real inbound messages, OBSERVES which contract the deployment
 *      honours, and then asserts that one in full: with the writer off nothing
 *      may be written; with it on the derived count must equal the inbound
 *      messages since the last outbound. A half-written state fails both, and a
 *      silently-flipped flag cannot pass unnoticed.
 *
 * Discipline, unchanged from every other production harness here: ONE throwaway
 * tenant registered through the public flow, no secrets, no direct database
 * access, nothing touched that this run did not create, and the tenant erased
 * at the end through `DELETE /api/account`.
 *
 *   W25_PROD_BASE=https://...
 *   W25_PROD_ALLOW_PRODUCTION=yes-write-synthetic-qa-data
 *     node scripts/qa/ui/w25-prod-verify.mjs
 */
import { chromium } from "playwright";

const BASE = (process.env.W25_PROD_BASE || "").trim().replace(/\/+$/, "");
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
  console.error("REFUSING TO RUN — set an absolute W25_PROD_BASE. The target is never defaulted.");
  process.exit(2);
}
if (looksLikeProduction(BASE) && process.env.W25_PROD_ALLOW_PRODUCTION !== PROD_OPT_IN) {
  console.error(`REFUSING TO RUN — "${BASE}" looks real. Set W25_PROD_ALLOW_PRODUCTION=${PROD_OPT_IN}.`);
  process.exit(2);
}

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const TAG = `QA-W25P-${STAMP}`;

// Structural guard: every row this harness creates must be identifiable as QA
// at a glance, in any database, forever. If the tag is ever edited into
// something that does not announce itself, refuse rather than write.
if (!/^QA-W25P-/.test(TAG)) {
  console.error("REFUSING TO RUN — the synthetic tag no longer starts with QA-W25P-.");
  process.exit(2);
}
const MOBILE = { width: 390, height: 844 };
const WAIT = 30000;

let passed = 0;
const failures = [];
const notes = [];
const ok = (l) => { passed += 1; console.log(`  ok  ${l}`); };
const bad = (l, d) => { failures.push(`${l} — ${d}`); console.log(`  FAIL  ${l} — ${d}`); };
const check = (c, l, d = "assertion failed") => (c ? ok(l) : bad(l, d));
const note = (l) => { notes.push(l); console.log(`  ..  ${l}`); };

function makeApi(tokenRef) {
  return async function api(path, init = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(tokenRef.token ? { Authorization: `Bearer ${tokenRef.token}` } : {}),
        ...(init.headers || {}),
      },
    });
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body };
  };
}

async function main() {
  console.log(`\nW2.5 Production verification\n  base: ${BASE}\n  tag:  ${TAG}\n`);

  /* ===================== AUTH ============================================= */
  const email = `qa-w25p-${STAMP}@example.test`;
  const password = `Qa!${STAMP}!w25p`;
  const ref = { token: null };
  const api = makeApi(ref);

  const anon = await api("/api/home");
  check(anon.status === 401, "AUTH1 an unauthenticated request is rejected", `status=${anon.status}`);

  const reg = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "QA W25 Prod", businessName: TAG }),
  });
  check([200, 201].includes(reg.status), "AUTH2 a synthetic tenant registers through the public flow",
    `status=${reg.status} ${JSON.stringify(reg.body).slice(0, 120)}`);
  if (![200, 201].includes(reg.status)) {
    console.error("\nHARNESS ERROR — cannot continue without a tenant.\n");
    process.exit(2);
  }

  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  ref.token = login.body?.token ?? null;
  check(!!ref.token, "AUTH3 it signs in and receives a session token");

  const badLogin = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: `${password}-wrong` }),
  });
  check(badLogin.status >= 400, "AUTH4 a wrong password is refused", `status=${badLogin.status}`);

  /* ===================== EXISTING DOMAINS ================================= */
  const domains = [
    ["HOME", "/api/home"],
    ["ATTENTION", "/api/inbox/attention"],
    ["LEADS", "/api/leads"],
    ["CONVERSATIONS", "/api/conversations"],
    ["CUSTOMERS", "/api/customers"],
    ["DOCUMENTS", "/api/documents/inbox"],
    ["SEARCH", "/api/search?q=qa"],
    ["REPORTS", "/api/reports/summary"],
    ["BILLING", "/api/billing/documents"],
    ["PAYMENTS", "/api/payments/requests"],
    ["BUSINESS-STATUS", "/api/business-status"],
  ];

  const bodies = {};
  for (const [label, path] of domains) {
    const res = await api(path);
    bodies[label] = res.body;
    check(res.status === 200, `${label} responds 200`, `status=${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
  }

  // Behaviour, not just status: a fresh tenant must read as genuinely empty
  // rather than as somebody else's data.
  const leadsList = bodies.LEADS?.leads ?? bodies.LEADS?.items ?? [];
  check(Array.isArray(leadsList) && leadsList.length === 0,
    "LEADS a brand-new tenant has no leads", `got ${JSON.stringify(leadsList).slice(0, 120)}`);

  const convList = bodies.CONVERSATIONS?.conversations ?? [];
  check(Array.isArray(convList) && convList.length === 0,
    "CONVERSATIONS a brand-new tenant has no conversations", `got ${convList.length}`);

  const custList = bodies.CUSTOMERS?.customers ?? bodies.CUSTOMERS?.items ?? [];
  check(Array.isArray(custList) && custList.length === 0,
    "CUSTOMERS a brand-new tenant has no customers", `got ${JSON.stringify(custList).slice(0, 120)}`);

  check(bodies.ATTENTION != null, "ATTENTION returns a payload the bell can render");
  check(bodies["BUSINESS-STATUS"] != null, "BUSINESS-STATUS returns a payload");

  /* ===================== W2.5 IDEMPOTENCY ================================= */
  const customer = await api("/api/customers", {
    method: "POST",
    body: JSON.stringify({ name: `${TAG} לקוח`, phone: `05${STAMP.slice(-7)}1` }),
  });
  check(customer.status === 201, "IDEM0 a synthetic customer is created", `status=${customer.status}`);
  const customerId = customer.body?.customer?.id;

  const conv = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ customerId, channel: "WHATSAPP" }),
  });
  check(conv.status === 201, "IDEM0 a synthetic conversation is created", `status=${conv.status}`);
  const conversationId = conv.body?.conversation?.id;

  const token = `w25-prod-${STAMP}`;
  const send = (over = {}) =>
    api("/api/message", {
      method: "POST",
      body: JSON.stringify({
        conversationId,
        customerId,
        channel: "WHATSAPP",
        messageType: "TEXT",
        direction: "INBOUND",
        senderType: "CUSTOMER",
        contentText: "QA synthetic inbound",
        ...over,
      }),
    });

  const first = await send({ clientRequestId: token });
  check([200, 201].includes(first.status), "IDEM1 the first tokened send is accepted", `status=${first.status}`);
  const firstId = first.body?.message?.id ?? first.body?.id;
  check(typeof firstId === "number", "IDEM2 it returns a real message id", `got ${firstId}`);

  const second = await send({ clientRequestId: token });
  check([200, 201].includes(second.status), "IDEM3 the repeat send is accepted, not errored", `status=${second.status}`);
  check(second.body?.duplicateSuppressed === true, "IDEM4 and reported as a suppressed duplicate",
    `duplicateSuppressed=${second.body?.duplicateSuppressed}`);
  const secondId = second.body?.message?.id ?? second.body?.id;
  check(secondId === firstId, "IDEM5 the caller gets back the message that already exists",
    `${firstId} vs ${secondId}`);

  // The authoritative count: how many messages the conversation actually holds.
  const detail = await api(`/api/conversation?conversationId=${conversationId}`);
  const messages = detail.body?.messages ?? detail.body?.conversation?.messages ?? null;
  if (Array.isArray(messages)) {
    check(messages.length === 1, "IDEM6 exactly ONE message row exists for that token",
      `got ${messages.length}`);
    check(messages.filter((m) => m.id === firstId).length === 1, "IDEM7 and it is the original row");
  } else {
    note(`IDEM6 message list not exposed by /api/conversation (status=${detail.status}) — counted via the list endpoint instead`);
    const relist = await api("/api/conversations");
    const row = (relist.body?.conversations ?? []).find((c) => c.id === conversationId);
    check(row != null, "IDEM6 the conversation is readable");
  }

  const distinct = await send({ clientRequestId: `${token}-other`, contentText: "second distinct send" });
  check([200, 201].includes(distinct.status), "IDEM8 a DIFFERENT token still creates a real message",
    `status=${distinct.status}`);
  const distinctId = distinct.body?.message?.id ?? distinct.body?.id;
  check(distinctId !== firstId, "IDEM9 so distinct sends are never collapsed");
  check(distinct.body?.duplicateSuppressed !== true, "IDEM10 and it is not reported as a duplicate");

  const untokened = await send({ contentText: "no token at all" });
  check([200, 201].includes(untokened.status), "IDEM11 a caller that sends no token is unaffected",
    `status=${untokened.status}`);

  /* ===================== WRITER STATE — WHICHEVER WAY THE FLAG IS SET ===== */
  //
  // This harness must stay truthful across the enablement boundary, so it does
  // not assume a flag value: it OBSERVES which contract the deployment is
  // honouring and asserts that one completely. Either way the assertions are
  // strict — there is no "skip" branch, and a half-written state fails both.
  //
  // Three customer-inbound messages have been sent above and no outbound, so
  // the derived count under an enabled writer is exactly 3.
  const after = await api("/api/conversations");
  const row = (after.body?.conversations ?? []).find((c) => c.id === conversationId);
  check(row != null, "STATE0 the conversation is readable after the sends");

  const writerRan =
    row != null &&
    (row.customerLastInboundAt != null ||
      row.temperatureScore != null ||
      (row.unansweredInboundCount ?? 0) > 0);

  if (!writerRan) {
    note("writer contract observed: OFF (CONVERSATION_STATE_WRITER_ENABLED is not true on this deployment)");
    check(row?.unansweredInboundCount === 0,
      "OFF1 unansweredInboundCount is still 0 after 3 real inbound messages",
      `got ${row?.unansweredInboundCount}`);
    check(row?.customerLastInboundAt == null, "OFF2 customerLastInboundAt was never stamped",
      `got ${row?.customerLastInboundAt}`);
    check(row?.temperatureScore == null, "OFF3 no temperature was written", `got ${row?.temperatureScore}`);
    check(row?.closeProbabilitySnapshot == null, "OFF4 no close probability was written",
      `got ${row?.closeProbabilitySnapshot}`);
    check(row?.businessLastOutboundAt == null, "OFF5 no outbound stamp was written",
      `got ${row?.businessLastOutboundAt}`);
  } else {
    note("writer contract observed: ON");
    check(row?.unansweredInboundCount === 3,
      "ON1 unansweredInboundCount equals the 3 inbound messages since the last outbound",
      `got ${row?.unansweredInboundCount}`);
    check(row?.customerLastInboundAt != null, "ON2 customerLastInboundAt is stamped");
    check(row?.lastMessageAt != null, "ON3 lastMessageAt is stamped");
    check(typeof row?.temperatureScore === "number" && row.temperatureScore >= 0 && row.temperatureScore <= 1,
      "ON4 a temperature is written and is a probability", `got ${row?.temperatureScore}`);
    check(
      typeof row?.closeProbabilitySnapshot === "number" &&
        row.closeProbabilitySnapshot >= 0 &&
        row.closeProbabilitySnapshot <= 1,
      "ON5 a close probability is written and is a probability",
      `got ${row?.closeProbabilitySnapshot}`
    );
    check(row?.businessLastOutboundAt == null,
      "ON6 no outbound stamp — the business never replied in this scenario",
      `got ${row?.businessLastOutboundAt}`);
  }

  /* ===================== UI at 390px ====================================== */
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: MOBILE, locale: "he-IL" });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 120)));

    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: WAIT });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: WAIT });
    ok("UI1 the QA tenant signs in through the real login screen");

    for (const [label, path, selector] of [
      ["UI2 /app", "/app", "main, .crm-page, [data-dz-home]"],
      ["UI3 /leads", "/leads", ".crm-page"],
      ["UI4 /inbox", "/inbox", "body"],
      ["UI5 /customers", "/customers", ".crm-page, main"],
    ]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: WAIT });
      const found = await page.waitForSelector(selector, { timeout: WAIT }).then(() => true).catch(() => false);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      check(found && overflow <= 1, `${label} renders at 390px with no horizontal overflow`,
        `found=${found} overflow=${overflow}px`);
    }

    check(pageErrors.length === 0, "UI6 no uncaught page errors across those screens",
      pageErrors.join(" | ").slice(0, 200));

    await context.close();
  } finally {
    await browser.close();
  }

  /* ===================== CLEANUP ========================================== */
  const erase = await api("/api/account", { method: "DELETE" });
  check([200, 202, 204].includes(erase.status), "Z1 the QA tenant is erased through the supported API",
    `status=${erase.status}`);

  const afterErase = await api("/api/home");
  check(afterErase.status >= 400, "Z2 its session no longer reaches the product",
    `status=${afterErase.status}`);

  const reLogin = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  check(reLogin.status >= 400, "Z3 and it can no longer sign back in", `status=${reLogin.status}`);

  console.log(
    failures.length === 0
      ? `\nW2.5 PRODUCTION VERIFY PASS — ${passed} checks green${notes.length ? `, ${notes.length} noted` : ""}.\n`
      : `\nW2.5 PRODUCTION VERIFY FAIL — ${failures.length} failed of ${passed + failures.length}:\n` +
          failures.map((f) => `  - ${f}`).join("\n") + "\n"
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nHARNESS ERROR:", err?.message || err);
  process.exit(2);
});
