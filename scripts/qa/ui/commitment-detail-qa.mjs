/**
 * Commitment detail QA — /payables/[id], owner-approved redesign (25.10.2026).
 *
 * Drives the REAL Next.js app in Chromium. Every /api/payables/** request is
 * answered from the fixtures below; other shell /api calls reuse
 * main-screens-fixtures ("prod"). Nothing reaches a database. Write requests
 * are RECORDED (method, path, JSON body) and answered with a plausible success
 * so each action's payload can be checked against the client contract.
 *
 *   BASE_URL=http://localhost:3107 node scripts/qa/ui/commitment-detail-qa.mjs [--label=pr]
 *
 * Requires `npx next dev -p 3107` in the checkout under test. Evidence goes to
 * $QA_EVIDENCE_DIR/<label>/ (default qa-evidence/commitment-detail/<label>/):
 * <scenario>-<width>.png, sheet shots, results.json.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3) || null;
const LABEL = arg("label") || "local";
const OUT = path.join(process.env.QA_EVIDENCE_DIR ? path.resolve(process.env.QA_EVIDENCE_DIR) : path.join(ROOT, "qa-evidence", "commitment-detail"), LABEL);
mkdirSync(OUT, { recursive: true });
const BASE = (process.env.BASE_URL || "http://localhost:3107").replace(/\/$/, "");
if (/promaxgroup|vercel\.app|dubiz/i.test(BASE)) {
  console.error(`Refusing to run against ${BASE}: local dev server only.`);
  process.exit(2);
}

const { chromium } = await import("playwright");
const { resolveApi } = await import("./main-screens-fixtures.mjs");

const FROZEN_NOW = "2026-10-25T10:00:00+03:00";

/* ───────────────────────────── fixtures ───────────────────────────── */

const at = (d) => `${d}T09:00:00.000Z`;
function inst(id, seq, due, state, scheduled, extra = {}) {
  const paid = extra.paid ?? (state === "PAID" ? scheduled : "0.00");
  const remaining = extra.remaining ?? (["PAID", "CANCELLED", "SETTLED_LEGACY"].includes(state) ? "0.00" : scheduled);
  return {
    id,
    sequence: seq,
    dueAt: at(due),
    scheduled,
    paid,
    remaining,
    state,
    status: state === "CANCELLED" ? "CANCELLED" : state === "SETTLED_LEGACY" ? "SETTLED_LEGACY" : "SCHEDULED",
    legacyAssertedBy: state === "SETTLED_LEGACY" ? "בעל העסק" : null,
    legacyMetAt: state === "SETTLED_LEGACY" ? at(due) : null,
    allocations: extra.allocations ?? (state === "PAID" ? [alloc(id * 10, id + 4000, scheduled, due)] : []),
  };
}
function alloc(id, paymentId, amount, date, extra = {}) {
  return { id, paymentId, amount, active: true, reversedAt: null, reversalReason: null, paymentStatus: "RECORDED", paymentPaidAt: at(date), paymentMethod: extra.method ?? "STANDING_ORDER", ...extra };
}
function pay(id, amount, date, method, extra = {}) {
  return { id, amount, allocated: extra.allocated ?? amount, unallocated: extra.unallocated ?? "0.00", status: extra.status ?? "RECORDED", method, paidAt: at(date), externalReference: extra.ref ?? null };
}
const ev = (id, eventType, summary, date, source = "USER") => ({ id, eventType, source, summary, occurredAt: at(date) });
const base = { currency: "ILS", payeeId: null, recurrence: "NONE", status: "ACTIVE", endAt: null, note: null, total: null, paid: "0.00", remaining: null, isLegacy: false, legacy: null, payments: [], audit: [] };

const DETAILS = {
  101: {
    ...base,
    id: 101,
    title: "גולן טלקום",
    payeeNameSnapshot: "גולן טלקום",
    scheduleKind: "RECURRING",
    recurrence: "MONTHLY",
    note: "חשבונית נשלחת למייל של העסק",
    installments: [
      inst(1011, 1, "2026-05-25", "PAID", "120.00"),
      inst(1012, 2, "2026-06-25", "PAID", "120.00"),
      inst(1013, 3, "2026-07-25", "PAID", "120.00"),
      inst(1014, 4, "2026-08-25", "PAID", "120.00"),
      inst(1015, 5, "2026-09-25", "PAID", "120.00"),
      inst(1016, 6, "2026-10-25", "DUE", "120.00"),
    ],
    payments: [pay(5015, "120.00", "2026-09-25", "STANDING_ORDER"), pay(5014, "120.00", "2026-08-25", "STANDING_ORDER")],
    audit: [
      ev(1, "INSTALLMENT_CREATED", "Next recurring installment #6 materialised", "2026-09-26", "SYSTEM"),
      ev(2, "PAYMENT_RECORDED", "Manual payment of 120.00 ILS recorded", "2026-09-25"),
      ev(3, "ALLOCATION_CREATED", "Allocated 120.00 ILS", "2026-09-25"),
    ],
  },
  102: {
    ...base,
    id: 102,
    title: "שכר טרחת רו״ח 2026",
    payeeId: 77,
    payeeNameSnapshot: "משרד כהן ושות׳",
    scheduleKind: "INSTALLMENT_PLAN",
    recurrence: "MONTHLY",
    total: "9000.00",
    paid: "5000.00",
    remaining: "4000.00",
    installments: [
      inst(1021, 1, "2026-07-15", "PAID", "1500.00"),
      inst(1022, 2, "2026-08-15", "PAID", "1500.00"),
      inst(1023, 3, "2026-09-15", "PAID", "1500.00"),
      inst(1024, 4, "2026-10-15", "OVERDUE", "1500.00", { paid: "500.00", remaining: "1000.00", allocations: [alloc(7024, 5204, "500.00", "2026-10-02", { method: "BANK_TRANSFER" })] }),
      inst(1025, 5, "2026-11-15", "SCHEDULED", "1500.00"),
      inst(1026, 6, "2026-12-15", "SCHEDULED", "1500.00"),
    ],
    payments: [
      pay(5205, "50.00", "2026-10-03", "CASH", { allocated: "0.00", unallocated: "50.00" }),
      pay(5204, "500.00", "2026-10-02", "BANK_TRANSFER"),
      pay(5203, "1500.00", "2026-09-15", "CHECK"),
    ],
    audit: [
      ev(11, "PREPARATION_CREATED", "Payment of 1000.00 ILS prepared (nothing paid)", "2026-10-20"),
      ev(12, "PAYMENT_RECORDED", "Manual payment of 500.00 ILS recorded", "2026-10-02"),
      ev(13, "CHEQUE_CREATED", "Cheque #1043 for 1500.00 ILS recorded as ISSUED", "2026-09-01"),
    ],
  },
  103: {
    ...base,
    id: 103,
    title: "תיקון מזגן במשרד",
    payeeNameSnapshot: "קור־טק שירותים",
    scheduleKind: "ONE_OFF",
    total: "850.00",
    paid: "850.00",
    remaining: "0.00",
    note: "כולל החלפת מדחס",
    installments: [inst(1031, 1, "2026-10-12", "PAID", "850.00", { allocations: [alloc(10310, 5301, "850.00", "2026-10-12", { method: "CREDIT_CARD" })] })],
    payments: [pay(5301, "850.00", "2026-10-12", "CREDIT_CARD")],
    audit: [ev(21, "PAYMENT_RECORDED", "Manual payment of 850.00 ILS recorded", "2026-10-12"), ev(22, "COMMITMENT_CREATED", 'Commitment "תיקון מזגן במשרד" created with 1 installment(s)', "2026-10-03")],
  },
  104: {
    ...base,
    id: 104,
    title: "שכירות מחסן",
    payeeNameSnapshot: "א.ב. נכסים",
    scheduleKind: "RECURRING",
    recurrence: "MONTHLY",
    endAt: at("2026-09-30"),
    installments: [
      inst(1041, 1, "2026-07-01", "PAID", "2200.00"),
      inst(1042, 2, "2026-08-01", "PAID", "2200.00"),
      inst(1043, 3, "2026-09-01", "PAID", "2200.00"),
      inst(1044, 4, "2026-10-01", "CANCELLED", "2200.00"),
    ],
    payments: [pay(5043, "2200.00", "2026-09-01", "BANK_TRANSFER")],
    audit: [
      ev(31, "INSTALLMENT_CANCELLED", "Installment cancelled — the commitment ends 2026-09-30", "2026-09-28"),
      ev(32, "COMMITMENT_ENDED", 'Commitment "שכירות מחסן" ends 2026-09-30', "2026-09-28"),
    ],
  },
  105: {
    ...base,
    id: 105,
    title: "ארנונה",
    payeeNameSnapshot: "עיריית רמת גן",
    scheduleKind: "RECURRING",
    recurrence: "BIMONTHLY",
    status: "CLOSED",
    isLegacy: true,
    legacy: { assertedBy: "בעל העסק", metAt: at("2026-09-01") },
    installments: [inst(1051, 1, "2026-09-01", "SETTLED_LEGACY", "640.00")],
    audit: [
      ev(41, "COMMITMENT_UPDATED", "Recurring commitment total cleared (ledger invariant; migrated value)", "2026-10-03", "MIGRATION"),
      ev(42, "COMMITMENT_SYNCED_FROM_OBLIGATION", "Synced from BusinessObligation #212 (secretary cutover)", "2026-10-03", "MIGRATION"),
      ev(43, "COMMITMENT_MIGRATED_FROM_OBLIGATION", "Migrated from BusinessObligation #212 (secretary cutover)", "2026-10-03", "MIGRATION"),
    ],
  },
};

const ACCOUNT = { id: 61, label: "חשבון העסק", last4: "4821", masked: "••••4821", isActive: true, isDefault: true, note: null, createdAt: at("2026-01-01") };
function cheque(id, number, status, due, instId, actions) {
  return {
    id, chequeNumber: number, payeeId: 77, payeeNameSnapshot: "משרד כהן ושות׳", amount: "1500.00", currency: "ILS", issueDate: at("2026-09-01"), dueDate: at(due), status,
    sourceBankAccount: { id: 61, label: "חשבון העסק", masked: "••••4821", isActive: true }, commitment: { id: 102, title: "שכר טרחת רו״ח 2026" },
    installment: instId ? { id: instId, sequence: instId - 1020, dueAt: at(due) } : null,
    cleared: status === "CLEARED" ? { assertedAt: at("2026-09-15"), source: "OWNER_ASSERTED" } : null,
    cancelledAt: null, cancellationReason: null, replaces: null, replacedBy: null, payment: null, note: null, createdAt: at("2026-09-01"),
    actions,
  };
}
const CHEQUES = {
  102: [
    cheque(9001, "1043", "ISSUED", "2026-11-15", 1025, { advance: ["DELIVERED"], clear: true, bounce: false, cancel: true, replace: true }),
    cheque(9002, "1042", "CLEARED", "2026-09-15", 1023, { advance: [], clear: false, bounce: true, cancel: false, replace: false }),
  ],
};
const PREP = {
  id: 8001, status: "PREPARED", amount: "1000.00", currency: "ILS", method: "BANK_TRANSFER", payee: { id: 77, name: "משרד כהן ושות׳" }, commitment: { id: 102, title: "שכר טרחת רו״ח 2026" },
  installment: { id: 1024, sequence: 4, dueAt: at("2026-10-15") }, source: { id: 61, label: "חשבון העסק", masked: "••••4821", isActive: true },
  destination: { id: 71, label: "חשבון המשרד", beneficiaryName: "כהן ושות׳", masked: "••••3310", isActive: true, verification: "OWNER_ENTERED" },
  reference: null, note: null, approvedAt: null, cancelledAt: null, cancellationReason: null, completedAt: null, completionSource: null, paymentId: null, executions: [], createdAt: at("2026-10-20"),
  actions: { approve: true, cancel: true, reportCompleted: false, execute: false },
};
const PREPS = { 102: [PREP] };
const DEST = { id: 71, payeeId: 77, label: "חשבון המשרד", beneficiaryName: "כהן ושות׳", last4: "3310", masked: "••••3310", origin: "OWNER_ENTERED", verification: "OWNER_ENTERED", isActive: true, isDefault: true, replacesDestinationId: null, note: null, createdAt: at("2026-01-01") };

function getPayables(pathname, q) {
  let m = pathname.match(/^\/api\/payables\/commitments\/(\d+)$/);
  if (m) return DETAILS[m[1]] ? { commitment: DETAILS[m[1]] } : undefined;
  if (pathname === "/api/payables/commitments") return { commitments: [] };
  if (pathname === "/api/payables/cheques") return { cheques: CHEQUES[q.get("commitmentId")] ?? [] };
  if (pathname === "/api/payables/bank-accounts") return { accounts: [ACCOUNT], configured: true };
  if (pathname === "/api/payables/preparations") return { preparations: PREPS[q.get("commitmentId")] ?? [] };
  if (pathname === "/api/payables/outbound-providers") return { providers: [], live: false };
  if (pathname === "/api/payables/destinations") return { destinations: q.get("payeeId") === "77" ? [DEST] : [] };
  if (pathname === "/api/payables/payees") return { payees: [] };
  return undefined;
}

function writeResponse(pathname) {
  if (pathname === "/api/payables/payments") return { payment: { id: 6001, amount: "120.00" }, allocations: [], unallocated: "0.00", replayed: false };
  if (/\/payments\/\d+\/void$/.test(pathname)) return { payment: {} };
  if (/\/allocations\/\d+\/reverse$/.test(pathname)) return { allocation: {} };
  if (/\/installments\/\d+\/cancel$/.test(pathname)) return { installment: {} };
  if (/\/amount-change$/.test(pathname)) return { commitmentId: 101, firstChangedInstallmentId: 1016, effectiveDueAt: at("2026-10-25"), changedCount: 1 };
  if (/\/commitments\/\d+\/end$/.test(pathname)) return { commitment: {}, cancelledInstallmentIds: [] };
  if (pathname === "/api/payables/preparations") return { preparation: PREP };
  if (/\/preparations\/\d+\/(approve|cancel)$/.test(pathname)) return { preparation: PREP };
  if (pathname === "/api/payables/cheques") return { cheque: { ...CHEQUES[102][0], id: 9010, chequeNumber: "2001" } };
  if (/\/cheques\/\d+\/clear$/.test(pathname)) return { cheque: CHEQUES[102][0], unallocated: "0.00", replayed: false };
  if (/\/cheques\/\d+\/(cancel|advance|bounce)$/.test(pathname)) return { cheque: CHEQUES[102][0] };
  return undefined;
}

/* ───────────────────────────── harness ───────────────────────────── */

const VIEWPORTS = [
  { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true, expect: "mobile" },
  { name: "768", width: 768, height: 1024, isMobile: false, hasTouch: true, expect: "tablet" },
  { name: "820", width: 820, height: 1180, isMobile: false, hasTouch: true, expect: "tablet" },
  { name: "1440", width: 1440, height: 900, isMobile: false, hasTouch: false, expect: "desktop" },
];
const SCENARIOS = [
  { id: 101, slug: "recurring-due", hero: "OPEN" },
  { id: 102, slug: "plan-overdue-partial", hero: "OVERDUE" },
  { id: 103, slug: "oneoff-paid", hero: "PAID" },
  { id: 104, slug: "recurring-ended", hero: "ENDED" },
  { id: 105, slug: "legacy-handled", hero: "LEGACY" },
];

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_TOKEN = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: "qa-local", exp: 1893456000 })}.qa-local-signature`;
const json = (body, status = 200) => ({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });

const results = { label: LABEL, base: BASE, frozenNow: FROZEN_NOW, startedAt: new Date().toISOString(), checks: [], writes: [], unmocked: [], consoleErrors: [] };
let pass = 0;
let fail = 0;
function check(name, cond, info) {
  results.checks.push({ name, ok: !!cond, info: info ?? null });
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL ${name}${info ? ` — ${JSON.stringify(info).slice(0, 300)}` : ""}`);
  }
}

async function newPage(browser, vp, writes) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
  });
  await ctx.clock.setFixedTime(new Date(FROZEN_NOW));
  await ctx.addInitScript((token) => {
    try {
      window.localStorage.setItem("token", token);
      window.localStorage.setItem("user", JSON.stringify({ id: 9, name: "בעלים לדוגמה", businessName: "עסק לדוגמה" }));
    } catch {
      /* ignore */
    }
  }, FAKE_TOKEN);
  await ctx.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const method = req.method();
    if (method !== "GET") {
      let body = null;
      try {
        body = req.postData() ? JSON.parse(req.postData()) : null;
      } catch {
        body = req.postData();
      }
      writes.push({ method, path: url.pathname, body });
      const res = writeResponse(url.pathname);
      return route.fulfill(res ? json(res) : json({ error: "QA harness: write not mocked" }, 404));
    }
    const body = url.pathname.startsWith("/api/payables/") ? getPayables(url.pathname, url.searchParams) : resolveApi("prod", method, url.pathname, url.searchParams);
    if (body === undefined) {
      results.unmocked.push(`${method} ${url.pathname}`);
      return route.fulfill(json({ error: "not mocked" }, 404));
    }
    return route.fulfill(json(body));
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|404/.test(m.text())) results.consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => results.consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on("dialog", (d) => d.accept());
  return { ctx, page };
}

async function open(page, id, query = "") {
  await page.goto(`${BASE}/payables/${id}${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="detail"]', { timeout: 60000 });
  await page.waitForTimeout(250);
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => {
    const el = document.scrollingElement;
    const shell = document.querySelector(".shell-content");
    return {
      doc: el.scrollWidth - el.clientWidth,
      shell: shell ? shell.scrollWidth - shell.clientWidth : 0,
    };
  });
}

const dialog = (page) => page.locator("dialog[open]");
const lastWrite = (writes) => writes[writes.length - 1];
async function sheetOpen(page) {
  await dialog(page).waitFor();
  await page.waitForTimeout(320); // the rise animation, so screenshots show the settled sheet
}

const browser = await chromium.launch();
try {
  /* ── 1. every scenario × every width: layout, hero, overflow, screenshot ── */
  for (const vp of VIEWPORTS) {
    for (const sc of SCENARIOS) {
      const writes = [];
      const { ctx, page } = await newPage(browser, vp, writes);
      await open(page, sc.id);
      const key = `${sc.slug}@${vp.name}`;
      const layout = await page.getAttribute('[data-testid="detail"]', "data-layout");
      check(`${key} layout = ${vp.expect}`, layout === vp.expect, { layout });
      const kind = await page.getAttribute('[data-testid="hero"]', "data-kind");
      check(`${key} status box = ${sc.hero}`, kind === sc.hero, { kind });
      const overflow = await noHorizontalScroll(page);
      check(`${key} no horizontal scroll`, overflow.doc <= 0 && overflow.shell <= 0, overflow);
      const hasActions = (await page.locator('[data-testid="actions"]').count()) > 0;
      check(`${key} payment actions only when something is payable`, hasActions === (sc.id === 101 || sc.id === 102), { hasActions });
      const heroText = await page.locator('[data-testid="hero"]').innerText();
      if (sc.hero !== "OPEN" && sc.hero !== "OVERDUE") check(`${key} closed status box never says “ממתין”/“לתשלום”`, !/ממתין|לתשלום|הקרוב/.test(heroText), { heroText });
      if (sc.id === 105) check(`${key} handled-without-payment never reads “שולם”`, !/שולם/.test(heroText.replace("ואינו נספר כשולם", "")), { heroText });
      if (vp.expect === "desktop") {
        check(`${key} desktop shows details + management panels inline`, (await page.locator('[data-testid="panel-details"]').count()) === 1 && (await page.locator('[data-testid="panel-manage"]').count()) === 1);
        check(`${key} desktop schedule is a table with header`, (await page.locator('[data-testid="schedule"] [aria-hidden] >> text=נותר').count()) > 0);
      } else {
        check(`${key} details + management rows present`, (await page.locator('[data-testid="open-details"]').count()) === 1 && (await page.locator('[data-testid="open-manage"]').count()) === 1);
      }
      await page.screenshot({ path: path.join(OUT, `${sc.slug}-${vp.name}.png`), fullPage: true });
      await ctx.close();
    }
  }

  /* ── 2. layout transitions in one session ── */
  {
    const writes = [];
    const { ctx, page } = await newPage(browser, VIEWPORTS[3], writes);
    await open(page, 102);
    const seen = [];
    for (const vp of [VIEWPORTS[3], VIEWPORTS[2], VIEWPORTS[1], VIEWPORTS[0], VIEWPORTS[3]]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(400);
      seen.push(await page.getAttribute('[data-testid="detail"]', "data-layout"));
    }
    check("resize 1440→820→768→390→1440 switches layouts", JSON.stringify(seen) === JSON.stringify(["desktop", "tablet", "tablet", "mobile", "desktop"]), { seen });
    check("no writes while just viewing", writes.length === 0, writes);
    await ctx.close();
  }

  /* ── 2b. tablet: the management dialog with the two action rows ── */
  for (const vp of [VIEWPORTS[1], VIEWPORTS[2]]) {
    const writes = [];
    const { ctx, page } = await newPage(browser, vp, writes);
    await open(page, 101);
    await page.click('[data-testid="open-manage"]');
    await sheetOpen(page);
    const a = await dialog(page).locator('[data-testid="recurring-amount"]').boundingBox();
    const e = await dialog(page).locator('[data-testid="recurring-end"]').boundingBox();
    check(`tablet ${vp.name}: two separate action rows`, a && e && e.y >= a.y + a.height - 1, { a, e });
    const overflow = await noHorizontalScroll(page);
    check(`tablet ${vp.name}: no horizontal scroll with the dialog open`, overflow.doc <= 0 && overflow.shell <= 0, overflow);
    await page.screenshot({ path: path.join(OUT, `dialog-manage-recurring-${vp.name}.png`) });
    check(`tablet ${vp.name}: no writes`, writes.length === 0, writes);
    await ctx.close();
  }

  /* ── 3. actions (mobile sheets) ── */
  {
    const vp = VIEWPORTS[0];
    const writes = [];
    const { ctx, page } = await newPage(browser, vp, writes);

    // record payment
    await open(page, 101);
    await page.click('[data-testid="open-record"]');
    await sheetOpen(page);
    await page.screenshot({ path: path.join(OUT, `sheet-record-${vp.name}.png`) });
    const dim = await dialog(page).evaluate((d) => getComputedStyle(d).backgroundColor);
    check("the sheet dims the screen behind it", dim !== "rgba(0, 0, 0, 0)" && dim !== "transparent", { dim });
    await dialog(page).locator("#pm-amount").fill("120");
    await dialog(page).locator('input[type="checkbox"]').first().check();
    await dialog(page).locator('button[type="submit"]').click();
    await page.waitForTimeout(500);
    let w = lastWrite(writes);
    check("record payment → POST /api/payables/payments", w?.method === "POST" && w.path === "/api/payables/payments", w);
    check(
      "record payment body = contract",
      w?.body?.commitmentId === 101 && w.body.amount === "120" && w.body.method === "BANK_TRANSFER" && w.body.externalReference === null &&
        JSON.stringify(w.body.installmentIds) === "[1016]" && /^ui-/.test(w.body.idempotencyKey) && !Number.isNaN(Date.parse(w.body.paidAt)),
      w?.body,
    );
    check("record payment closes the sheet and shows the notice", (await dialog(page).count()) === 0 && (await page.locator('[data-testid="notice"]').count()) === 1);

    // details sheet: note, history Hebrew + original, void with confirm
    await page.click('[data-testid="open-details"]');
    await sheetOpen(page);
    check("details sheet shows the note", (await dialog(page).locator('[data-testid="note"]').innerText()).includes("חשבונית נשלחת"));
    const hist = await dialog(page).locator('[data-testid="history"]').innerText();
    check("history shows Hebrew labels", hist.includes("נרשם תשלום") && hist.includes("נוצר התשלום הבא בסדרה"), { hist });
    await dialog(page).locator('[data-testid="history"] summary').first().click();
    check("history keeps the original text behind “פרטים טכניים”", (await dialog(page).locator('[data-testid="history"] code').first().innerText()).includes("materialised"));
    await page.screenshot({ path: path.join(OUT, `sheet-details-${vp.name}.png`) });
    const before = writes.length;
    await dialog(page).locator('[data-testid="void-5015"]').click();
    check("void asks first (no request yet)", writes.length === before);
    await dialog(page).locator('[data-testid="void-confirm-5015"]').click();
    await page.waitForTimeout(400);
    w = lastWrite(writes);
    check("void → POST /payments/5015/void with the same reason", w?.path === "/api/payables/payments/5015/void" && w.body?.reason === "בוטל על ידי בעל העסק", w);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check("Esc closes the sheet", (await dialog(page).count()) === 0);

    // manage sheet: recurring amount change + end
    await page.click('[data-testid="open-manage"]');
    await sheetOpen(page);
    await page.screenshot({ path: path.join(OUT, `sheet-manage-recurring-${vp.name}.png`) });
    {
      const a = await dialog(page).locator('[data-testid="recurring-amount"]').boundingBox();
      const e = await dialog(page).locator('[data-testid="recurring-end"]').boundingBox();
      check("amount change and end are two separate full-width rows, end below", a && e && e.y >= a.y + a.height - 1 && Math.abs(a.width - e.width) < 2 && a.height >= 44 && e.height >= 44, { a, e });
      const colors = await dialog(page).evaluate(() => {
        const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
        return { amount: bg('dialog[open] [data-testid="recurring-amount"]'), end: bg('dialog[open] [data-testid="recurring-end"]'), primary: bg('[data-testid="open-record"]') };
      });
      check("neither action row is the primary green button", colors.amount !== colors.primary && colors.end !== colors.primary, colors);
      await dialog(page).locator('[data-testid="recurring-end"]').click();
      await page.waitForTimeout(150);
      const endBtn = await dialog(page).getByRole("button", { name: "סיים התחייבות" }).evaluate((b) => getComputedStyle(b).backgroundColor);
      check("the end-commitment confirm button is warning-toned, not primary green", endBtn !== colors.primary, { endBtn, primary: colors.primary });
      check("ending still needs the date form + confirm (no request on row tap)", !writes.some((w) => w.path.endsWith("/end")));
      await page.screenshot({ path: path.join(OUT, `sheet-manage-recurring-end-open-${vp.name}.png`) });
      await dialog(page).locator('[data-testid="recurring-end"]').click();
      await page.waitForTimeout(150);
    }
    await dialog(page).getByRole("button", { name: "שינוי סכום מתאריך" }).click();
    await dialog(page).locator("#rc-amount").fill("130.00");
    await dialog(page).getByRole("button", { name: "עדכן סכום" }).click();
    await page.waitForTimeout(400);
    w = lastWrite(writes);
    check("amount change → POST /commitments/101/amount-change {effectiveFrom, amount}", w?.path === "/api/payables/commitments/101/amount-change" && w.body?.amount === "130.00" && !Number.isNaN(Date.parse(w.body?.effectiveFrom)), w);
    await dialog(page).getByRole("button", { name: "סיום ההתחייבות" }).click();
    await dialog(page).getByRole("button", { name: "סיים התחייבות" }).click();
    await page.waitForTimeout(400);
    w = lastWrite(writes);
    check("end → POST /commitments/101/end {endsOn}", w?.path === "/api/payables/commitments/101/end" && !Number.isNaN(Date.parse(w.body?.endsOn)), w);
    await page.keyboard.press("Escape");

    // schedule: show all + row sheet
    await page.waitForTimeout(200);
    check("mobile schedule previews 4 rows", (await page.locator('[data-testid="schedule"] li').count()) === 4);
    await page.click('[data-testid="schedule-toggle"]');
    check("“הצג הכל” shows every installment", (await page.locator('[data-testid="schedule"] li').count()) === 6);

    // plan: ?pay deep link
    await open(page, 102, "?pay=1024");
    await dialog(page).waitFor({ timeout: 5000 }).catch(() => {});
    const preChecked = (await dialog(page).count()) === 1 && (await dialog(page).locator('input[type="checkbox"]').first().isChecked());
    check("?pay=1024 opens the payment sheet with installment 4 preselected", preChecked);
    await page.keyboard.press("Escape");

    // row → installment sheet → reverse allocation
    await page.click('[data-testid="row-1024"]');
    await sheetOpen(page);
    await page.screenshot({ path: path.join(OUT, `sheet-installment-${vp.name}.png`) });
    check("overdue installment explains it cannot be cancelled while money is allocated", (await dialog(page).innerText()).includes("לא ניתן לבטל"));
    await dialog(page).getByRole("button", { name: "בטל שיוך" }).click();
    await page.waitForTimeout(400);
    w = lastWrite(writes);
    check("reverse allocation → POST /allocations/7024/reverse with the same reason", w?.path === "/api/payables/allocations/7024/reverse" && w.body?.reason === "תוקן על ידי בעל העסק", w);
    await dialog(page).locator('[data-testid="pay-this"]').click();
    await page.waitForTimeout(200);
    check("“רשום תשלום לתשלום הזה” opens the form preselected", (await dialog(page).locator('input[type="checkbox"]').first().isChecked()) === true);
    await page.keyboard.press("Escape");

    // row → cancel an untouched installment
    await page.click('[data-testid="row-1026"]');
    await sheetOpen(page);
    await dialog(page).getByRole("button", { name: "בטל תשלום" }).click();
    await page.waitForTimeout(400);
    w = lastWrite(writes);
    check("cancel installment → POST /installments/1026/cancel with the same reason", w?.path === "/api/payables/installments/1026/cancel" && w.body?.reason === "בוטל על ידי בעל העסק", w);
    await page.keyboard.press("Escape");

    // surplus + preparation strip
    check("surplus notice shown", (await page.locator('[data-testid="surplus"]').count()) === 1);
    check("open prepared payment strip shown", (await page.locator('[data-testid="strip-preparations"]').innerText()).includes("תשלום מוכן אחד"));
    check("management row shows the exact cheque count", (await page.locator('[data-testid="manage-sub"]').innerText()).includes("צ׳ק פתוח אחד · 2 בסך הכל"));

    // prepare payment
    await page.click('[data-testid="open-prepare"]');
    await sheetOpen(page);
    await page.waitForTimeout(400);
    check("prepare sheet carries the no-provider notice", (await dialog(page).innerText()).includes("אין ספק לתשלומים יוצאים"));
    await page.screenshot({ path: path.join(OUT, `sheet-prepare-${vp.name}.png`) });
    await dialog(page).locator('button[type="submit"]').click();
    await page.waitForTimeout(500);
    w = lastWrite(writes);
    check(
      "prepare → POST /api/payables/preparations {commitmentId, installmentId, amount, method, destinationId, sourceBankAccountId}",
      w?.path === "/api/payables/preparations" && w.body?.commitmentId === 102 && w.body?.installmentId === 1024 && w.body?.amount === "1000.00" && w.body?.method === "BANK_TRANSFER" && w.body?.destinationId === 71 && w.body?.sourceBankAccountId === 61,
      w,
    );

    // manage: preparation approve/cancel, cheques record/clear/cancel/advance/bounce
    await page.click('[data-testid="open-manage"]');
    await sheetOpen(page);
    await page.screenshot({ path: path.join(OUT, `sheet-manage-plan-${vp.name}.png`), fullPage: false });
    await dialog(page).getByRole("button", { name: "אשר תשלום" }).click();
    await page.waitForTimeout(400);
    w = lastWrite(writes);
    check("approve preparation → POST /preparations/8001/approve", w?.path === "/api/payables/preparations/8001/approve", w);
    await dialog(page).locator('[data-testid="preparations"]').getByRole("button", { name: "בטל", exact: true }).click();
    await page.waitForTimeout(400);
    w = lastWrite(writes);
    check("cancel preparation → POST /preparations/8001/cancel", w?.path === "/api/payables/preparations/8001/cancel", w);

    await dialog(page).getByRole("button", { name: "סמן כנמסר" }).click();
    await page.waitForTimeout(400);
    w = lastWrite(writes);
    check("advance cheque → POST /cheques/9001/advance {to: DELIVERED}", w?.path === "/api/payables/cheques/9001/advance" && w.body?.to === "DELIVERED", w);
    await dialog(page).getByRole("button", { name: "סמן כנפרע" }).click();
    await dialog(page).getByRole("button", { name: "אשר שהצ׳ק נפרע" }).click();
    await page.waitForTimeout(400);
    w = lastWrite(writes);
    check("clear cheque → POST /cheques/9001/clear {clearedAt}", w?.path === "/api/payables/cheques/9001/clear" && typeof w.body?.clearedAt === "string", w);
    await dialog(page).getByRole("button", { name: "סמן כחוזר" }).click();
    await page.waitForTimeout(400);
    w = lastWrite(writes);
    check("bounce cheque → POST /cheques/9002/bounce", w?.path === "/api/payables/cheques/9002/bounce", w);
    await dialog(page).getByRole("button", { name: "בטל צ׳ק" }).click();
    await page.waitForTimeout(400);
    w = lastWrite(writes);
    check("cancel cheque → POST /cheques/9001/cancel", w?.path === "/api/payables/cheques/9001/cancel", w);
    await dialog(page).getByRole("button", { name: "רשום צ׳ק" }).first().click();
    await dialog(page).getByLabel("מספר צ׳ק").fill("2001");
    await dialog(page).locator("form").getByRole("button", { name: "רשום צ׳ק" }).click();
    await page.waitForTimeout(500);
    w = lastWrite(writes);
    check(
      "record cheque → POST /api/payables/cheques with the commitment and its open installment",
      w?.path === "/api/payables/cheques" && w.body?.chequeNumber === "2001" && w.body?.commitmentId === 102 && w.body?.installmentId === 1024 && w.body?.sourceBankAccountId === 61,
      w,
    );
    await page.keyboard.press("Escape");

    // closed scenarios: no payment actions, management explains what is available
    await open(page, 103);
    await page.click('[data-testid="open-manage"]');
    await sheetOpen(page);
    check("one-off: management explains amount change / end are for active recurring only", (await dialog(page).innerText()).includes("זמינים להתחייבות מתחדשת פעילה בלבד"));
    await page.keyboard.press("Escape");
    await open(page, 105);
    await page.click('[data-testid="open-details"]');
    await sheetOpen(page);
    const legacyHist = await dialog(page).locator('[data-testid="history"]').innerText();
    check("legacy history reads Hebrew (migration wording)", legacyHist.includes("התאמה למבנה של התחייבות מתחדשת") && !legacyHist.includes("ledger invariant"), { legacyHist });
    await dialog(page).locator('[data-testid="history"] summary').first().click();
    check("legacy original sentence still available", (await dialog(page).locator('[data-testid="history"] code').first().innerText()).includes("ledger invariant"));
    await page.screenshot({ path: path.join(OUT, `sheet-details-legacy-${vp.name}.png`) });
    await page.keyboard.press("Escape");

    // back navigation from a direct link → the payables list (registry fallback)
    await open(page, 101);
    await page.locator('[data-testid="detail"] button').first().click();
    await page.waitForURL(/\/payables(\?|$)/, { timeout: 15000 }).catch(() => {});
    check("back from a direct link goes to /payables", new URL(page.url()).pathname === "/payables", { url: page.url() });

    results.writes.push(...writes);
    await ctx.close();
  }

  /* ── 4. desktop: dialog + inline panels ── */
  {
    const vp = VIEWPORTS[3];
    const writes = [];
    const { ctx, page } = await newPage(browser, vp, writes);
    await open(page, 101);
    await page.locator('[data-testid="panel-manage"]').screenshot({ path: path.join(OUT, `panel-manage-recurring-${vp.name}.png`) });
    check("desktop management panel shows both action rows inline", (await page.locator('[data-testid="panel-manage"] [data-testid="recurring-amount"]').count()) === 1 && (await page.locator('[data-testid="panel-manage"] [data-testid="recurring-end"]').count()) === 1);
    await open(page, 102);
    check("desktop table previews 6 rows (all fit)", (await page.locator('[data-testid="schedule"] li').count()) === 6);
    await page.click('[data-testid="row-1024"]');
    await sheetOpen(page);
    const box = await dialog(page).locator(":scope > div").boundingBox();
    check("desktop opens a centred dialog, not a bottom sheet", box && box.width <= 600 && box.x > 300, box);
    await page.screenshot({ path: path.join(OUT, `dialog-installment-${vp.name}.png`) });
    await page.keyboard.press("Escape");
    await page.click('[data-testid="fold-history"] summary');
    check("desktop history fold opens", (await page.locator('[data-testid="fold-history"] [data-testid="history"]').count()) === 1);
    await page.click('[data-testid="fold-payments"] summary');
    await page.screenshot({ path: path.join(OUT, `desktop-folds-open-${vp.name}.png`), fullPage: true });
    await page.click('[data-testid="open-record"]');
    await sheetOpen(page);
    await page.screenshot({ path: path.join(OUT, `dialog-record-${vp.name}.png`) });
    check("no writes from just opening things", writes.length === 0, writes);
    await ctx.close();
  }
} finally {
  await browser.close();
}

results.unmocked = [...new Set(results.unmocked)];
results.pass = pass;
results.fail = fail;
results.finishedAt = new Date().toISOString();
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`commitment detail QA (${LABEL}): ${pass}/${pass + fail} checks passed · ${results.writes.length} writes recorded · console errors ${results.consoleErrors.length} · unmocked ${results.unmocked.length}`);
if (results.consoleErrors.length) console.log(results.consoleErrors.slice(0, 10).join("\n"));
if (results.unmocked.length) console.log("unmocked:", results.unmocked.join(", "));
process.exit(fail ? 1 : 0);
