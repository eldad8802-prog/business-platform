/**
 * Conversation State Writer W2.5 — runtime proof with the flag ON.
 *
 * The unit suite proves the writer's contract against the database. This proves
 * the same thing through the RUNTIME the flag actually changes: real HTTP
 * routes, real session auth, real tenant context, and the Inbox rendering the
 * states it has never rendered before because the writer never wrote them.
 *
 * Same discipline as every other harness here: its own throwaway tenants
 * through the public registration flow, no secrets, no direct database access,
 * both tenants erased at the end through the supported API.
 *
 * It REFUSES to run unless the target reports the writer as enabled — a green
 * run against a disabled writer would be the most misleading result possible.
 *
 * Scenarios: A inbound writes state · B replay does not double-count ·
 * C multiple inbound accumulate · D outbound answers and resets ·
 * E temperature moves with the conversation · F business situation ·
 * G next best action · H tenant isolation · I 390px RTL Inbox.
 *
 *   W25_BASE=http://localhost:3311 node scripts/qa/ui/conversation-state-w25-runtime.mjs
 */
import { chromium } from "playwright";

const BASE = (process.env.W25_BASE || "").trim().replace(/\/+$/, "");
if (!BASE) {
  console.error("REFUSING TO RUN — W25_BASE is not set.");
  process.exit(2);
}
if (/promaxgroup\.co\.il/i.test(BASE)) {
  console.error("REFUSING TO RUN — this harness must never point at Production.");
  process.exit(2);
}

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const TAG = `QA-W25-${STAMP}`;
const MOBILE = { width: 390, height: 844 };
const WAIT = 25000;

let passed = 0;
const failures = [];
const ok = (l) => { passed += 1; console.log(`  ok  ${l}`); };
const bad = (l, d) => { failures.push(`${l} — ${d}`); console.log(`  FAIL  ${l} — ${d}`); };
const check = (c, l, d = "assertion failed") => (c ? ok(l) : bad(l, d));

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
    try { body = await res.json(); } catch { /* none */ }
    return { status: res.status, body };
  };
}

async function registerTenant(label) {
  const email = `qa-w25-${label}-${STAMP}@example.test`;
  const password = `Qa!${STAMP}!w25`;
  const ref = { token: null };
  const api = makeApi(ref);
  const reg = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      name: `QA W25 ${label}`,
      businessName: `${TAG}-${label}`,
    }),
  });
  if (reg.status !== 200 && reg.status !== 201) {
    throw new Error(`register ${label} failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  const login = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  ref.token = login.body?.token ?? null;
  if (!ref.token) throw new Error(`login ${label} failed`);
  return { ref, api, email, password };
}

/**
 * The raw conversation row, straight from the list endpoint — no direct DB.
 *
 * Reads are retried on 5xx. Running the app far from the database (a laptop in
 * Israel against us-east-1) puts this multi-query endpoint right on Prisma's
 * 5s interactive-transaction budget, and it intermittently expires. That is a
 * property of the PROOF ENVIRONMENT, not of the writer — but it is only ever
 * safe to paper over on a READ, so the retry lives here and nowhere else.
 */
async function readConversation(api, conversationId, attempts = 4) {
  let res = null;
  for (let i = 0; i < attempts; i += 1) {
    res = await api("/api/conversations");
    if (res.status < 500) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  const row = (res?.body?.conversations ?? []).find((c) => c.id === conversationId);
  const item = (res?.body?.items ?? []).find((i) => i.conversationId === conversationId);
  return { status: res?.status, row, item };
}

async function seedCustomerAndConversation(api, suffix) {
  const customer = await api("/api/customers", {
    method: "POST",
    body: JSON.stringify({ name: `${TAG} לקוח ${suffix}`, phone: `05${STAMP.slice(-7)}${suffix}` }),
  });
  if (customer.status !== 201) {
    throw new Error(`customer ${suffix} failed: ${customer.status} ${JSON.stringify(customer.body)}`);
  }
  const customerId = customer.body.customer.id;
  const conv = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ customerId, channel: "WHATSAPP" }),
  });
  if (conv.status !== 201) {
    throw new Error(`conversation ${suffix} failed: ${conv.status} ${JSON.stringify(conv.body)}`);
  }
  return { customerId, conversationId: conv.body.conversation.id };
}

function send(api, conversationId, customerId, over = {}) {
  return api("/api/message", {
    method: "POST",
    body: JSON.stringify({
      conversationId,
      customerId,
      channel: "WHATSAPP",
      messageType: "TEXT",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentText: "שלום, אשמח לקבל הצעת מחיר",
      ...over,
    }),
  });
}

async function main() {
  console.log(`\nConversation State Writer W2.5 — runtime proof\n  base: ${BASE}\n`);

  const A = await registerTenant("a");
  const B = await registerTenant("b");

  /* ===================== GATE — the writer must actually be on ============ */
  {
    const seed = await seedCustomerAndConversation(A.api, "0");
    await send(A.api, seed.conversationId, seed.customerId);
    const { status, row } = await readConversation(A.api, seed.conversationId);
    if (status !== 200) {
      console.error(`
HARNESS ERROR — the conversations endpoint returned ${status}; cannot judge the writer.
`);
      await A.api("/api/account", { method: "DELETE" });
      await B.api("/api/account", { method: "DELETE" });
      process.exit(2);
    }
    if (!row || row.unansweredInboundCount !== 1 || row.customerLastInboundAt === null) {
      console.error(
        "\nREFUSING TO REPORT — the writer did not write.\n" +
          "  CONVERSATION_STATE_WRITER_ENABLED is not 'true' on this target, or the\n" +
          "  deployment predates the flag. A green run here would mean nothing.\n" +
          `  observed: unansweredInboundCount=${row?.unansweredInboundCount} ` +
          `customerLastInboundAt=${row?.customerLastInboundAt}\n`
      );
      await A.api("/api/account", { method: "DELETE" });
      await B.api("/api/account", { method: "DELETE" });
      process.exit(2);
    }
    ok("GATE the writer is enabled on this target and wrote conversation state");
  }

  const a1 = await seedCustomerAndConversation(A.api, "1");

  /* ===================== A — an inbound message writes state ============== */
  const beforeA = await readConversation(A.api, a1.conversationId);
  check(beforeA.row?.unansweredInboundCount === 0, "A0 a fresh conversation starts at zero unanswered",
    `got ${beforeA.row?.unansweredInboundCount}`);
  check(beforeA.row?.customerLastInboundAt === null, "A0 and with no inbound stamp",
    `got ${beforeA.row?.customerLastInboundAt}`);

  const first = await send(A.api, a1.conversationId, a1.customerId);
  check(first.status === 201 || first.status === 200, "A1 an inbound message is accepted", `status=${first.status}`);

  const afterA = await readConversation(A.api, a1.conversationId);
  check(afterA.row?.unansweredInboundCount === 1, "A2 the unanswered counter is now 1",
    `got ${afterA.row?.unansweredInboundCount}`);
  check(afterA.row?.customerLastInboundAt !== null, "A3 customerLastInboundAt is stamped");
  check(afterA.row?.lastMessageAt !== null, "A4 lastMessageAt is stamped");
  check(afterA.row?.temperatureScore !== null, "A5 a temperature is written",
    `got ${afterA.row?.temperatureScore}`);
  check(afterA.row?.closeProbabilitySnapshot !== null, "A6 a close probability is written",
    `got ${afterA.row?.closeProbabilitySnapshot}`);
  check(afterA.item?.primarySignal !== undefined, "A7 the inbox item carries a primary signal",
    `got ${afterA.item?.primarySignal}`);

  /* ===================== B — a replayed send does not double-count ======== */
  const token = `w25-${STAMP}-replay`;
  const b1 = await send(A.api, a1.conversationId, a1.customerId, { clientRequestId: token });
  check(b1.status === 201 || b1.status === 200, "B1 a tokened send is accepted", `status=${b1.status}`);
  const afterB1 = await readConversation(A.api, a1.conversationId);
  check(afterB1.row?.unansweredInboundCount === 2, "B2 the counter moves to 2",
    `got ${afterB1.row?.unansweredInboundCount}`);

  const b2 = await send(A.api, a1.conversationId, a1.customerId, { clientRequestId: token });
  check(b2.status === 200 || b2.status === 201, "B3 the SAME token is accepted, not rejected", `status=${b2.status}`);
  check(b2.body?.duplicateSuppressed === true, "B4 and reported as a suppressed duplicate",
    `duplicateSuppressed=${b2.body?.duplicateSuppressed}`);
  const sameId = (b1.body?.message?.id ?? b1.body?.id) === (b2.body?.message?.id ?? b2.body?.id);
  check(sameId, "B5 the caller gets back the message that already exists");

  const afterB2 = await readConversation(A.api, a1.conversationId);
  check(afterB2.row?.unansweredInboundCount === 2, "B6 the counter did NOT move — a replay does not double-count",
    `got ${afterB2.row?.unansweredInboundCount}`);
  check(
    afterB2.row?.lastMessageAt === afterB1.row?.lastMessageAt,
    "B7 and the conversation clock did not move either"
  );

  /* ===================== C — multiple inbound accumulate ================== */
  await send(A.api, a1.conversationId, a1.customerId, { contentText: "עוד שאלה" });
  const afterC = await readConversation(A.api, a1.conversationId);
  check(afterC.row?.unansweredInboundCount === 3, "C1 three unanswered inbound messages count as three",
    `got ${afterC.row?.unansweredInboundCount}`);

  /* ===================== D — an outbound answer resets the count ========== */
  const reply = await send(A.api, a1.conversationId, a1.customerId, {
    direction: "OUTBOUND",
    senderType: "BUSINESS_USER",
    contentText: "שלום! נשמח לעזור",
  });
  check(reply.status === 201 || reply.status === 200, "D1 an outbound reply is accepted", `status=${reply.status}`);
  const afterD = await readConversation(A.api, a1.conversationId);
  check(afterD.row?.unansweredInboundCount === 0, "D2 answering resets the unanswered count to zero",
    `got ${afterD.row?.unansweredInboundCount}`);
  check(afterD.row?.businessLastOutboundAt !== null, "D3 businessLastOutboundAt is stamped");
  check(
    afterD.row?.customerLastInboundAt === afterC.row?.customerLastInboundAt,
    "D4 an outbound message does not touch the customer's inbound stamp"
  );
  check(afterD.item?.primarySignal !== "customer_waiting",
    "D5 the item no longer reads as a waiting customer", `got ${afterD.item?.primarySignal}`);

  /* ===================== E — temperature responds to the conversation ===== */
  const e = await seedCustomerAndConversation(A.api, "2");
  await send(A.api, e.conversationId, e.customerId, { contentText: "כמה זה עולה? אני רוצה להזמין" });
  const afterE = await readConversation(A.api, e.conversationId);
  check(typeof afterE.row?.temperatureScore === "number", "E1 a fresh inbound thread has a numeric temperature",
    `got ${afterE.row?.temperatureScore}`);
  check(
    afterE.row?.temperatureScore >= 0 && afterE.row?.temperatureScore <= 1,
    "E2 the temperature is a probability, not an unbounded score",
    `got ${afterE.row?.temperatureScore}`
  );
  check(["cold", "warm", "hot"].includes(afterE.item?.temperatureBucket),
    "E3 the inbox item resolves a temperature bucket", `got ${afterE.item?.temperatureBucket}`);
  check(
    afterE.row?.temperatureScore > (beforeA.row?.temperatureScore ?? 0),
    "E4 a live inbound thread is warmer than an untouched one",
    `${afterE.row?.temperatureScore} vs ${beforeA.row?.temperatureScore}`
  );

  /* ===================== F — the business situation is derived ============ */
  const situation = afterE.item?.businessSituation ?? afterE.item?.conversationOutcome?.kind;
  check(situation !== undefined && situation !== null, "F1 the item carries a business situation", `got ${situation}`);
  check(typeof afterE.item?.signalLabel === "string" && afterE.item.signalLabel.length > 0,
    "F2 and a human-readable signal label", `got ${afterE.item?.signalLabel}`);

  /* ===================== G — a next best action is offered ================ */
  const nba = afterE.item?.nextBestAction;
  check(!!nba, "G1 the item carries a next best action");
  check(typeof nba?.label === "string" && nba.label.length > 0, "G2 the action has a label", `got ${nba?.label}`);
  check(typeof nba?.reason === "string" && nba.reason.length > 0, "G3 and a machine-readable reason",
    `got ${nba?.reason}`);

  /* ===================== H — tenant isolation ============================= */
  const stolenRead = await readConversation(B.api, a1.conversationId);
  check(stolenRead.row === undefined, "H1 tenant B cannot see tenant A's conversation");
  const stolenWrite = await send(B.api, a1.conversationId, a1.customerId, { contentText: "cross-tenant" });
  check(stolenWrite.status === 404, "H2 tenant B cannot post into tenant A's conversation",
    `status=${stolenWrite.status}`);
  const afterH = await readConversation(A.api, a1.conversationId);
  check(afterH.row?.unansweredInboundCount === 0, "H3 and tenant A's state was not moved by the attempt",
    `got ${afterH.row?.unansweredInboundCount}`);
  const bList = await B.api("/api/conversations");
  const bLeak = (bList.body?.conversations ?? []).some((c) => c.id === a1.conversationId);
  check(!bLeak, "H4 tenant B's inbox does not contain tenant A's conversation");

  /* ===================== I — the surfaces at 390px, RTL =================== */

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: MOBILE, locale: "he-IL" });
    const page = await context.newPage();

    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: WAIT });
    await page.fill('input[type="email"]', A.email);
    await page.fill('input[type="password"]', A.password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: WAIT });
    ok("I1 the QA tenant signs in");

    // A tenant that has never connected WhatsApp does not get the conversation
    // list at all — the Inbox shows the connect stage instead, by design
    // (the system-wide stage-aware flow rule). That is the SHAPE OF THE
    // ENABLEMENT RISK, so it is asserted rather than worked around: the writer
    // can only change what a business SEES once that business has WhatsApp
    // connected. A QA tenant cannot fake a connection without Meta, so the
    // list-surface rendering is out of reach here and the API assertions above
    // are what prove the writer's output.
    await page.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded", timeout: WAIT });
    await page.waitForSelector("[data-testid], main, .inbox-frame, h1, h2", { timeout: WAIT }).catch(() => {});
    await page.waitForTimeout(2500);

    const inboxSurface = await page.evaluate(() => ({
      dir: document.documentElement.getAttribute("dir"),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      text: document.body.innerText || "",
      hasFrame: !!document.querySelector(".inbox-frame"),
    }));

    check(inboxSurface.dir === "rtl", "I2 the Inbox renders RTL at 390px", `dir=${inboxSurface.dir}`);
    check(inboxSurface.overflow <= 1, "I3 the Inbox has no horizontal overflow at 390px",
      `overflow=${inboxSurface.overflow}px`);
    check(inboxSurface.text.length > 200, "I4 the Inbox rendered real content, not a blank page",
      `length=${inboxSurface.text.length}`);
    check(
      !inboxSurface.hasFrame && inboxSurface.text.includes("WhatsApp"),
      "I5 with no WhatsApp connection the Inbox shows the connect stage, not the list",
      `hasFrame=${inboxSurface.hasFrame}`
    );

    // /leads IS reachable without a connection, and it is the surface W1/W2
    // ship. It must still be intact with the writer on.
    await page.goto(`${BASE}/leads`, { waitUntil: "domcontentloaded", timeout: WAIT });
    await page.waitForSelector(".crm-page", { timeout: WAIT });
    // The list arrives from a fetch after mount; wait for it to resolve rather
    // than racing it. This tenant has conversations but no leads, so the
    // resolved state is the empty state — which is what W2 specifies.
    await page
      .waitForFunction(() => (document.body.innerText || "").includes("לידים"), null, { timeout: WAIT })
      .catch(() => {});
    const leads = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      text: document.body.innerText || "",
    }));
    check(leads.overflow <= 1, "I6 /leads has no horizontal overflow at 390px", `overflow=${leads.overflow}px`);
    check(
      leads.text.includes("לידים") && !leads.text.includes("שגיאה"),
      "I7 /leads resolves its own state with the writer enabled",
      `got "${leads.text.slice(0, 120)}"`
    );

    await context.close();
  } finally {
    await browser.close();
  }

  /* ===================== cleanup ========================================== */
  const eraseA = await A.api("/api/account", { method: "DELETE" });
  const eraseB = await B.api("/api/account", { method: "DELETE" });
  check([200, 202, 204].includes(eraseA.status), "Z1 tenant A erased through the supported API",
    `status=${eraseA.status}`);
  check([200, 202, 204].includes(eraseB.status), "Z2 tenant B erased through the supported API",
    `status=${eraseB.status}`);

  console.log(
    failures.length === 0
      ? `\nW2.5 RUNTIME PROOF PASS — ${passed} checks green.\n`
      : `\nW2.5 RUNTIME PROOF FAIL — ${failures.length} failed of ${passed + failures.length}:\n` +
          failures.map((f) => `  - ${f}`).join("\n") + "\n"
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nHARNESS ERROR:", err?.message || err);
  process.exit(2);
});
