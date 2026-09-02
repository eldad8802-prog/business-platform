/**
 * Leads W3 — Lead Intelligence Surface, end-to-end at 390px RTL.
 *
 * Proves the thing W3 exists for: what the system already understood about a
 * conversation now reaches the screen where the owner decides — and the owner's
 * decision stays theirs.
 *
 * Its own throwaway tenant through the public flow, no secrets, no direct
 * database access, erased at the end through `DELETE /api/account`.
 *
 * Requires a target where BOTH the Conversation State Writer and lead
 * auto-capture are enabled; it refuses to report otherwise, because a green run
 * against a disabled writer would say nothing.
 *
 *   W3_BASE=http://localhost:3311 node scripts/qa/ui/leads-w3-e2e.mjs
 */
import { chromium } from "playwright";

const BASE = (process.env.W3_BASE || "").trim().replace(/\/+$/, "");
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
  console.error("REFUSING TO RUN — set an absolute W3_BASE. The target is never defaulted.");
  process.exit(2);
}
if (looksLikeProduction(BASE) && process.env.W3_ALLOW_PRODUCTION !== PROD_OPT_IN) {
  console.error(`REFUSING TO RUN — "${BASE}" looks real. Set W3_ALLOW_PRODUCTION=${PROD_OPT_IN}.`);
  process.exit(2);
}

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const TAG = `QA-W3-${STAMP}`;
if (!/^QA-W3-/.test(TAG)) {
  console.error("REFUSING TO RUN — the synthetic tag no longer announces itself as QA.");
  process.exit(2);
}
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const WAIT = 30000;

let passed = 0;
const failures = [];
const notes = [];
const ok = (l) => { passed += 1; console.log(`  ok  ${l}`); };
const bad = (l, d) => { failures.push(`${l} — ${d}`); console.log(`  FAIL  ${l} — ${d}`); };
const check = (c, l, d = "assertion failed") => (c ? ok(l) : bad(l, d));
const note = (l) => { notes.push(l); console.log(`  ..  ${l}`); };

const ref = { token: null };
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(ref.token ? { Authorization: `Bearer ${ref.token}` } : {}),
      ...(init.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
};

const email = `qa-w3-${STAMP}@example.test`;
const password = `Qa!${STAMP}!w3`;

const send = (conversationId, customerId, over = {}) =>
  api("/api/message", {
    method: "POST",
    body: JSON.stringify({
      conversationId,
      customerId,
      channel: "WHATSAPP",
      messageType: "TEXT",
      direction: "INBOUND",
      senderType: "CUSTOMER",
      contentText: "שלום, כמה עולה השירות?",
      ...over,
    }),
  });

const leadsList = async () => (await api("/api/leads?status=all")).body?.leads ?? [];

async function main() {
  console.log(`\nLeads W3 — intelligence surface\n  base: ${BASE}\n  tag:  ${TAG}\n`);

  const reg = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name: "QA W3", businessName: TAG }),
  });
  if (![200, 201].includes(reg.status)) {
    console.error(`register failed: ${reg.status} ${JSON.stringify(reg.body).slice(0, 140)}`);
    process.exit(2);
  }
  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  ref.token = login.body?.token ?? null;
  check(!!ref.token, "A1 the QA tenant signs in");

  /* ══════════════ auto-capture: an inquiry becomes a lead ═════════════════ */

  const customer = await api("/api/customers", {
    method: "POST",
    body: JSON.stringify({ name: `${TAG} דניאל`, phone: `05${STAMP.slice(-7)}1` }),
  });
  check(customer.status === 201, "A2 a customer exists", `status=${customer.status}`);
  const customerId = customer.body?.customer?.id;

  const conv = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ customerId, channel: "WHATSAPP" }),
  });
  check(conv.status === 201, "A3 a conversation exists", `status=${conv.status}`);
  const conversationId = conv.body?.conversation?.id;

  check((await leadsList()).length === 0, "A4 no lead exists before the first message");

  await send(conversationId, customerId);

  const afterFirst = await leadsList();
  if (afterFirst.length !== 1) {
    console.error(
      "\nREFUSING TO REPORT — the first inbound message did not become a lead.\n" +
        "  LEADS_AUTO_CAPTURE_ENABLED is not true on this target, or the writer is off.\n" +
        `  leads=${afterFirst.length}\n`
    );
    await api("/api/account", { method: "DELETE" });
    process.exit(2);
  }
  ok("A5 GATE the first inbound message created a lead by itself");

  const leadId = afterFirst[0].id;
  const captured = afterFirst[0];
  check(captured.sourceChannel === "WHATSAPP", "A6 with the conversation's channel as its source", captured.sourceChannel);
  check(captured.status === "NEW", "A7 and the owner's status untouched at NEW", captured.status);

  // Replay + more inbound must not duplicate.
  await send(conversationId, customerId, { clientRequestId: `w3-${STAMP}`, contentText: "עוד שאלה" });
  await send(conversationId, customerId, { clientRequestId: `w3-${STAMP}`, contentText: "עוד שאלה" });
  await send(conversationId, customerId, { contentText: "מתי אתם פנויים?" });
  const afterMore = await leadsList();
  check(afterMore.length === 1, "A8 replays and further messages never create a second lead", `got ${afterMore.length}`);

  /* ══════════════ the intelligence reaches the list and the card ══════════ */

  const row = afterMore[0];
  check(row.intelligence != null, "B1 the list row carries conversation intelligence");
  check(
    row.intelligence?.unansweredInboundCount >= 2,
    "B2 with the real unanswered count",
    `got ${row.intelligence?.unansweredInboundCount}`
  );
  check(typeof row.intelligence?.waitingMinutes === "number", "B3 and the real waiting time");
  check(row.priority?.score > 0, "B4 the row explains why it is in the queue", `score=${row.priority?.score}`);
  check(
    row.priority?.label && !/[A-Z_]{4,}/.test(row.priority.label),
    "B5 in Hebrew, never an enum",
    row.priority?.label
  );

  const card = await api(`/api/leads/${leadId}`);
  check(card.status === 200, "B6 the lead card loads", `status=${card.status}`);
  check(card.body?.intelligence != null, "B7 and carries the same intelligence");
  check(
    card.body?.intelligence?.conversationId === conversationId,
    "B8 naming the conversation it describes",
    `got ${card.body?.intelligence?.conversationId}`
  );

  /* ══════════════ owner authority: evidence never moves status ════════════ */

  // Drive the thread to NEGOTIATION through supported product events only.
  await send(conversationId, customerId, {
    direction: "OUTBOUND",
    senderType: "BUSINESS_USER",
    contentText: 'המחיר הוא 450 ש"ח לחודש.',
  });
  await send(conversationId, customerId, { contentText: "מעולה, בוא נתקדם" });

  const advanced = await api(`/api/leads/${leadId}`);
  const stage = advanced.body?.intelligence?.conversationStage;
  note(`conversation stage reached: ${stage}`);
  check(
    stage === "QUOTED" || stage === "NEGOTIATION",
    "C1 the conversation advanced on its own evidence",
    `got ${stage}`
  );
  check(
    advanced.body?.lead?.status === "NEW",
    "C2 AND THE LEAD STATUS IS STILL THE OWNER'S — evidence never moved it",
    `got ${advanced.body?.lead?.status}`
  );

  // The owner decides; the API still accepts their decision.
  const decided = await api(`/api/leads/${leadId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "QUALIFIED" }),
  });
  check(decided.status === 200 && decided.body?.lead?.status === "QUALIFIED",
    "C3 the owner can still set the status themselves", `status=${decided.status}`);
  check(
    decided.body?.intelligence?.conversationStage === stage,
    "C4 and the conversation evidence is unchanged by their decision",
    `got ${decided.body?.intelligence?.conversationStage}`
  );

  /* ══════════════ a calm lead stays calm ═════════════════════════════════ */

  const calmCustomer = await api("/api/customers", {
    method: "POST",
    body: JSON.stringify({ name: `${TAG} שקט`, phone: `05${STAMP.slice(-7)}2` }),
  });
  const calmLead = await api("/api/leads", {
    method: "POST",
    body: JSON.stringify({ name: `${TAG} שקט`, phone: `05${STAMP.slice(-7)}2` }),
  });
  check([200, 201].includes(calmLead.status), "D1 a manual lead can still be created", `status=${calmLead.status}`);
  const calm = (await leadsList()).find((l) => l.id === calmLead.body?.lead?.id);
  check(calm?.intelligence == null, "D2 a lead with no conversation has no intelligence");
  check(
    (calm?.priority?.score ?? 0) < (row.priority?.score ?? 0),
    "D3 and does not outrank a lead with a waiting customer",
    `${calm?.priority?.score} vs ${row.priority?.score}`
  );
  void calmCustomer;

  /* ══════════════ UI at 390px and desktop ════════════════════════════════ */

  const browser = await chromium.launch();
  try {
    for (const [label, viewport] of [["390", MOBILE], ["desktop", DESKTOP]]) {
      const context = await browser.newContext({ viewport, locale: "he-IL" });
      const page = await context.newPage();
      // Per PAGE, not per session: /leads carries a pre-existing React #418
      // hydration error — verified on a production build of main with every W3
      // change stashed, so it is not this work's. Anything NEW still fails.
      const errorsByPath = {};
      let currentPath = "/login";
      page.on("pageerror", (e) => {
        (errorsByPath[currentPath] ||= []).push(String(e).slice(0, 80));
      });

      await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: WAIT });
      await page.fill('input[type="email"]', email);
      await page.fill('input[type="password"]', password);
      await page.click('button[type="submit"]');
      await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: WAIT });

      currentPath = "/leads";
      await page.goto(`${BASE}/leads?view=all`, { waitUntil: "domcontentloaded", timeout: WAIT });
      await page.waitForSelector(".crm-page", { timeout: WAIT });
      await page
        .waitForFunction(() => (document.body.innerText || "").includes("QA-W3"), null, { timeout: WAIT })
        .catch(() => {});

      const list = await page.evaluate(() => ({
        dir: document.documentElement.getAttribute("dir"),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        text: document.body.innerText || "",
      }));
      check(list.dir === "rtl", `E1 ${label} /leads renders RTL`, `dir=${list.dir}`);
      check(list.overflow <= 1, `E2 ${label} /leads has no horizontal overflow`, `overflow=${list.overflow}px`);
      check(list.text.includes("ממתין"), `E3 ${label} the row states the wait`, list.text.slice(0, 120));
      check(
        !/[A-Z_]{4,}/.test(list.text.replace(/QA-W3-\d+/g, "")),
        `E4 ${label} the list never prints an internal enum`,
        list.text.slice(0, 160)
      );

      currentPath = "/leads/[id]";
      await page.goto(`${BASE}/leads/${leadId}`, { waitUntil: "domcontentloaded", timeout: WAIT });
      // Both panes stay mounted on desktop, so ".crm-page" matches twice. The
      // card is the READING pane — the same scoping W1/W2 harnesses use.
      await page.waitForSelector(".crm-reading", { timeout: WAIT });
      await page
        .waitForFunction(() => (document.body.innerText || "").includes("סטטוס"), null, {
          timeout: WAIT,
        })
        .catch(() => {});
      const detail = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        text: document.body.innerText || "",
      }));
      check(detail.overflow <= 1, `E5 ${label} the card has no horizontal overflow`, `overflow=${detail.overflow}px`);
      check(detail.text.includes("מה קורה עכשיו"), `E6 ${label} the card shows "מה קורה עכשיו"`);
      check(detail.text.includes("סטטוס הליד נשאר שלך"), `E7 ${label} and states that the status stays the owner's`);
      check(detail.text.includes("מעקב"), `E8 ${label} the follow-up section is still present, not pushed out`);
      // Scoped to the section W3 added. The card's older "שיחות" list still
      // prints the raw channel enum ("WHATSAPP") — a pre-existing W1 leak that
      // is NOT in this increment's scope to fix, only to report.
      const nowSection = detail.text.split("מה קורה עכשיו")[1]?.split("מעקב")[0] ?? "";
      check(
        nowSection.length > 0 && !/[A-Z_]{4,}/.test(nowSection),
        `E9 ${label} the new "מה קורה עכשיו" section prints no internal enum`,
        nowSection.slice(0, 160)
      );
      if (/WHATSAPP/.test(detail.text)) {
        note(`${label} pre-existing: the card conversations list prints the raw channel enum`);
      }
      const cardErrors = errorsByPath["/leads/[id]"] ?? [];
      check(
        cardErrors.length === 0,
        `E10 ${label} the lead card raises no page errors`,
        cardErrors.join(" | ")
      );
      const listErrors = errorsByPath["/leads"] ?? [];
      const listNew = listErrors.filter((e) => !/#418/.test(e));
      check(
        listNew.length === 0,
        `E11 ${label} /leads raises no error beyond the known pre-existing #418`,
        listNew.join(" | ")
      );
      if (listErrors.length > 0) {
        note(`${label} /leads still carries the pre-existing hydration #418 (${listErrors.length})`);
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  /* ══════════════ cleanup ════════════════════════════════════════════════ */

  const erase = await api("/api/account", { method: "DELETE" });
  check([200, 202, 204].includes(erase.status), "Z1 the QA tenant is erased", `status=${erase.status}`);
  const relogin = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  check(relogin.status >= 400, "Z2 and can no longer sign in", `status=${relogin.status}`);

  console.log(
    failures.length === 0
      ? `\nLEADS W3 E2E PASS — ${passed} checks green${notes.length ? `, ${notes.length} noted` : ""}.\n`
      : `\nLEADS W3 E2E FAIL — ${failures.length} failed of ${passed + failures.length}:\n` +
          failures.map((f) => `  - ${f}`).join("\n") + "\n"
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nHARNESS ERROR:", err?.message || err);
  process.exit(2);
});
