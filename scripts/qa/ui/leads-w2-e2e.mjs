/**
 * Leads W2 — Action Loop end-to-end proof at 390px, RTL.
 *
 * Same discipline as the W1 harness: its own throwaway tenant through the
 * public registration flow, no secrets, no direct database access, and the
 * tenant erased at the end through the supported API.
 *
 * Scenarios: A follow-up due → Home reflects it · B Attention shows it with the
 * right reason · C complete from Attention → it disappears · D reschedule →
 * disappears now · E conversation → Create Lead · F run again → no duplicate ·
 * G existing open lead is reused · H cross-tenant rejected · I persistence ·
 * J 390px RTL.
 *
 *   LEADS_SMOKE_BASE=http://localhost:3213 node scripts/qa/ui/leads-w2-e2e.mjs
 */
import { chromium } from "playwright";

const BASE = (process.env.LEADS_SMOKE_BASE || "").trim().replace(/\/+$/, "");
if (!BASE) {
  console.error("REFUSING TO RUN — LEADS_SMOKE_BASE is not set.");
  process.exit(2);
}

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const TAG = `QA-W2-${STAMP}`;
const MOBILE = { width: 390, height: 844 };
const WAIT = 20000;

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
  const email = `qa-w2-${label}-${STAMP}@example.test`;
  const password = `Qa!${STAMP}!w2`;
  const ref = { token: null };
  const api = makeApi(ref);
  const reg = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name: `QA W2 ${label}`, businessName: `${TAG}-${label}` }),
  });
  if (reg.status !== 200 && reg.status !== 201) {
    throw new Error(`register ${label} failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  ref.token = login.body?.token ?? null;
  if (!ref.token) throw new Error(`login ${label} failed`);
  return { ref, api };
}

async function expectText(page, selector, needle, label) {
  try {
    await page.waitForFunction(
      ([sel, want]) => {
        const el = document.querySelector(sel);
        return !!el && (el.textContent || "").includes(want);
      },
      [selector, needle],
      { timeout: WAIT }
    );
    ok(label);
  } catch {
    const actual = await page.textContent(selector).catch(() => "<missing>");
    bad(label, `"${needle}" not in ${selector} — got "${String(actual).slice(0, 140)}"`);
  }
}

async function expectTextGone(page, selector, needle, label) {
  try {
    await page.waitForFunction(
      ([sel, want]) => {
        const el = document.querySelector(sel);
        return !!el && !(el.textContent || "").includes(want);
      },
      [selector, needle],
      { timeout: WAIT }
    );
    ok(label);
  } catch {
    bad(label, `"${needle}" still present in ${selector}`);
  }
}

async function main() {
  const A = await registerTenant("a");
  const B = await registerTenant("b");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: MOBILE, locale: "he-IL" });
  const page = await ctx.newPage();

  try {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    await page.evaluate((t) => localStorage.setItem("token", t), A.ref.token);

    /* ============================ A — follow-up due → Home ================= */

    const phone = `05${STAMP.slice(-8)}`;
    const lead = await A.api("/api/leads", {
      method: "POST",
      body: JSON.stringify({ name: `${TAG} דנה`, phone, intentSnapshot: "QA W2" }),
    });
    check(lead.status === 201, "SETUP a lead exists", `status=${lead.status}`);
    const leadId = lead.body.lead.id;

    // Due today — the honest way to make it actionable without touching the DB.
    const due = await A.api(`/api/leads/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify({ followUpAt: new Date().toISOString(), followUpNote: "לבדוק מחיר" }),
    });
    check(due.body?.needsAttention === true, "A1 the lead now needs attention", JSON.stringify(due.body?.followUp));

    const home = await A.api("/api/home");
    check(
      home.body?.leadsAttention?.count === 1,
      "A2 Home reports exactly one lead needing attention",
      JSON.stringify(home.body?.leadsAttention)
    );
    check(
      home.body?.leadsAttention?.href === "/leads?view=needsAction",
      "A3 Home links to the attention-filtered Leads view"
    );

    await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
    await expectText(page, "body", "לידים", "A4 the Home tools strip renders");
    const tileHref = await page.getAttribute('a[aria-label*="לידים"]', "href").catch(() => null);
    check(
      tileHref === "/leads?view=needsAction",
      "A5 the לידים tile deep-links to the attention queue when work is waiting",
      `href=${tileHref}`
    );

    await page.goto(`${BASE}/leads?view=needsAction`, { waitUntil: "networkidle" });
    await page.waitForSelector(".crm-hd__title", { timeout: WAIT });
    await expectText(page, ".crm-page", `${TAG} דנה`, "A6 the deep-link lands on the attention queue");
    const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    check(o.s <= o.c + 1, "J1 no horizontal overflow at 390px", `${o.s} > ${o.c}`);
    check(
      (await page.evaluate(() => getComputedStyle(document.querySelector(".crm-scope")).direction)) === "rtl",
      "J2 the surface renders RTL"
    );

    /* ============================ B — Attention ============================ */

    await page.goto(`${BASE}/attention`, { waitUntil: "networkidle" });
    await expectText(page, "body", `${TAG} דנה`, "B1 the lead appears on Attention");
    await expectText(page, "body", "מעקב להיום", "B2 with the correct reason");
    await expectText(page, "body", "לבדוק מחיר", "B3 and the owner's own note as evidence");
    await expectText(page, "body", "לידים", "B4 labelled as the Leads domain");

    /* ============================ C — complete from Attention ============== */

    await page.click('button:has-text("טופל")');
    await expectTextGone(page, "body", `${TAG} דנה`, "C1 completing from Attention removes the item");

    const afterComplete = await A.api("/api/home");
    check(
      afterComplete.body?.leadsAttention?.count === 0,
      "C2 Home's count drops to zero",
      JSON.stringify(afterComplete.body?.leadsAttention)
    );
    const card = await A.api(`/api/leads/${leadId}`);
    check(card.body?.followUp?.kind === "none", "C3 the follow-up really is cleared");
    check(card.body?.lead?.status !== "WON", "C4 completing a follow-up did NOT close the lead");

    /* ============================ D — reschedule =========================== */

    await A.api(`/api/leads/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify({ followUpAt: new Date().toISOString() }),
    });
    await page.goto(`${BASE}/attention`, { waitUntil: "networkidle" });
    await expectText(page, "body", `${TAG} דנה`, "D1 it is back on Attention");
    await page.click('button:has-text("דחה")');
    await expectTextGone(page, "body", `${TAG} דנה`, "D2 rescheduling removes it from Attention now");

    const afterSnooze = await A.api(`/api/leads/${leadId}`);
    check(
      afterSnooze.body?.followUp?.kind === "scheduled",
      "D3 the follow-up moved into the future rather than being cleared",
      JSON.stringify(afterSnooze.body?.followUp)
    );
    check(afterSnooze.body?.needsAttention === false, "D4 and it no longer needs attention");

    /* ============================ E–G — conversation → lead ================ */

    const customer = await A.api("/api/customers", {
      method: "POST",
      body: JSON.stringify({ name: `${TAG} יוסי`, phone: `05${STAMP.slice(-7)}1` }),
    });
    check(customer.status === 201, "SETUP a customer exists", `status=${customer.status}`);

    const conv = await A.api("/api/conversation", {
      method: "POST",
      body: JSON.stringify({ customerId: customer.body.customer.id, channel: "WHATSAPP" }),
    });
    check(conv.status === 200 || conv.status === 201, "SETUP a conversation exists", `status=${conv.status}`);
    const convId = conv.body?.id ?? conv.body?.conversation?.id;

    const created = await A.api(`/api/conversations/${convId}/lead`, { method: "POST" });
    check(created.status === 201, "E1 Create Lead from a conversation returns 201", `status=${created.status}`);
    check(created.body?.outcome === "created", "E2 outcome is `created`", String(created.body?.outcome));
    check(
      created.body?.customer?.id === customer.body.customer.id,
      "E3 the lead is linked to the conversation's customer"
    );
    const convLeadId = created.body?.lead?.id;

    const again = await A.api(`/api/conversations/${convId}/lead`, { method: "POST" });
    check(again.status === 200, "F1 running it again returns 200, not a second creation", `status=${again.status}`);
    check(again.body?.outcome === "already_linked", "F2 outcome is `already_linked`", String(again.body?.outcome));
    check(again.body?.lead?.id === convLeadId, "F3 it is the SAME lead");

    const allLeads = await A.api("/api/leads?status=all");
    const forThisCustomer = (allLeads.body?.leads ?? []).filter(
      (l) => l.customer?.id === customer.body.customer.id
    );
    check(forThisCustomer.length === 1, "F4 exactly one lead exists for that contact", `count=${forThisCustomer.length}`);

    // G — a second conversation for the same customer adopts the open lead.
    const conv2 = await A.api("/api/conversation", {
      method: "POST",
      body: JSON.stringify({ customerId: customer.body.customer.id, channel: "WHATSAPP" }),
    });
    const conv2Id = conv2.body?.id ?? conv2.body?.conversation?.id;
    const adopted = await A.api(`/api/conversations/${conv2Id}/lead`, { method: "POST" });
    check(adopted.status === 200, "G1 a second conversation reuses the open lead", `status=${adopted.status}`);
    check(adopted.body?.outcome === "linked_existing", "G2 outcome is `linked_existing`", String(adopted.body?.outcome));
    check(adopted.body?.lead?.id === convLeadId, "G3 still the same lead — no duplicate");

    /* ============================ H — cross-tenant ========================= */

    const stolen = await B.api(`/api/conversations/${convId}/lead`, { method: "POST" });
    check(stolen.status === 404, "H1 tenant B cannot create a lead from tenant A's conversation", `status=${stolen.status}`);
    const bLeads = await B.api("/api/leads?status=all");
    check((bLeads.body?.leads ?? []).length === 0, "H2 nothing was created in tenant B");
    const aStill = await A.api(`/api/leads/${convLeadId}`);
    check(aStill.status === 200, "H3 tenant A's lead is untouched");

    /* ============================ I — persistence ========================== */

    await page.goto(`${BASE}/leads/${convLeadId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".crm-id__name", { timeout: WAIT });
    await page.reload({ waitUntil: "networkidle" });
    await expectText(page, ".crm-id__name", `${TAG} יוסי`, "I1 the lead survives a hard refresh");
    await expectText(page, "body", "וואטסאפ", "I2 the WhatsApp source is preserved");
    const o2 = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    check(o2.s <= o2.c + 1, "J3 the lead card has no horizontal overflow at 390px", `${o2.s} > ${o2.c}`);
  } catch (err) {
    bad("E2E RUN", err?.message ?? String(err));
  } finally {
    await ctx.close();
    await browser.close();
    for (const [label, t] of [["A", A], ["B", B]]) {
      const del = await t.api("/api/account", { method: "DELETE" });
      check(del.status === 200, `CLEANUP tenant ${label} erased through the supported path`, `status=${del.status}`);
    }
  }

  console.log("");
  if (failures.length) {
    console.log(`LEADS W2 E2E FAIL — ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`LEADS W2 E2E PASS — ${passed} checks green.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
