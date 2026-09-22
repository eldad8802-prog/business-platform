/**
 * Phase 3 runtime QA — cheques and bank accounts, real components, measured boxes.
 *
 * Same method as the 1b harness: data is injected at the NETWORK layer, so the
 * real pages, the real CSS module and the real React tree render it.
 *
 * SCOPE, stated honestly: UI and RUNTIME only. Nothing here touches a database
 * and no assertion below is a ledger or crypto proof — that is the CI DB suite
 * (payables-3.db.test.ts) and the pure crypto suite. What this DOES prove:
 *
 *   - a bank account reaches the screen as a label and four digits, nothing more
 *   - the account form sends coordinates as STRINGS with leading zeros intact,
 *     from text inputs, and clears them from the DOM after a successful save
 *   - CLEARED reads as the owner's statement, never as bank verification
 *   - the cheque number is typed, never pre-filled or suggested
 *   - nothing overflows or spills at seven widths, and tap targets are usable
 *
 * Run: build, `npm run start`, then `node scripts/qa/payables-3-runtime-qa.mjs`.
 */

import { chromium } from "playwright";

const BASE = process.env.QA_BASE ?? "http://localhost:3517";
const WIDTHS = [320, 360, 390, 768, 1024, 1280, 1920];

const LONG_HE =
  "עיריית תל אביב יפו — אגף הגבייה, מחלקת ארנונה עסקית ושילוט, סניף מרכז";
const LONG_LABEL = "חשבון העסק הראשי בבנק לאומי — סניף רמת החייל, תפעול שוטף";
const LONG_NUMBER = "A-7788/ג-0000123456789";

const ACCOUNTS = [
  { id: 1, label: LONG_LABEL, last4: "5678", masked: "••••5678", isActive: true, isDefault: true, note: null, createdAt: "2027-01-01T09:00:00.000Z" },
  { id: 2, label: "חשבון משני", last4: "0042", masked: "••••0042", isActive: true, isDefault: false, note: null, createdAt: "2027-01-02T09:00:00.000Z" },
  { id: 3, label: "חשבון ישן", last4: "9999", masked: "••••9999", isActive: false, isDefault: false, note: null, createdAt: "2026-01-02T09:00:00.000Z" },
];

const acct = (a) => ({ id: a.id, label: a.label, masked: a.masked, isActive: a.isActive });
const ACTIONS = {
  PLANNED: { advance: ["ISSUED"], clear: false, bounce: false, cancel: true, replace: true },
  ISSUED: { advance: ["DELIVERED", "PRESENTED"], clear: true, bounce: true, cancel: true, replace: true },
  CLEARED: { advance: [], clear: false, bounce: true, cancel: false, replace: false },
  REPLACED: { advance: [], clear: false, bounce: false, cancel: false, replace: false },
};

function cheque(over) {
  return {
    id: 1,
    chequeNumber: "000123",
    payeeId: 1,
    payeeNameSnapshot: LONG_HE,
    amount: "1200000.00",
    currency: "ILS",
    issueDate: "2027-02-01T09:00:00.000Z",
    dueDate: "2027-02-15T09:00:00.000Z",
    status: "PLANNED",
    sourceBankAccount: acct(ACCOUNTS[0]),
    commitment: { id: 1, title: `ארנונה 2027 — ${LONG_HE}` },
    installment: { id: 11, sequence: 2, dueAt: "2027-02-15T09:00:00.000Z" },
    cleared: null,
    cancelledAt: null,
    cancellationReason: null,
    replaces: null,
    replacedBy: null,
    payment: null,
    note: null,
    createdAt: "2027-02-01T09:00:00.000Z",
    ...over,
    actions: ACTIONS[over.status ?? "PLANNED"],
  };
}

const CHEQUES = [
  cheque({ id: 1, status: "PLANNED" }),
  cheque({ id: 2, status: "ISSUED", chequeNumber: LONG_NUMBER }),
  cheque({
    id: 3,
    status: "CLEARED",
    chequeNumber: "500105",
    cleared: { assertedAt: "2027-02-16T09:00:00.000Z", source: "OWNER_ASSERTED" },
    payment: { id: 9, status: "RECORDED", allocated: "1000000.00", unallocated: "200000.00" },
  }),
  cheque({
    id: 4,
    status: "REPLACED",
    chequeNumber: "500106",
    cancelledAt: "2027-02-10T09:00:00.000Z",
    cancellationReason: `חזר מהבנק — ${LONG_HE}`,
    replacedBy: { id: 5, chequeNumber: "500220" },
  }),
  cheque({ id: 5, status: "PLANNED", chequeNumber: "500220", replaces: { id: 4, chequeNumber: "500106" } }),
];

const DETAIL = {
  id: 1,
  title: `ארנונה 2027 — ${LONG_HE}`,
  payeeId: 1,
  payeeNameSnapshot: LONG_HE,
  currency: "ILS",
  scheduleKind: "INSTALLMENT_PLAN",
  recurrence: "MONTHLY",
  status: "ACTIVE",
  note: null,
  total: "1200000.00",
  paid: "0.00",
  remaining: "1200000.00",
  isLegacy: false,
  legacy: null,
  installments: [
    { id: 11, sequence: 1, dueAt: "2027-02-15T09:00:00.000Z", scheduled: "600000.00", paid: "0.00", remaining: "600000.00", state: "DUE", status: "SCHEDULED", legacyAssertedBy: null, legacyMetAt: null, allocations: [] },
    { id: 12, sequence: 2, dueAt: "2027-03-15T09:00:00.000Z", scheduled: "600000.00", paid: "0.00", remaining: "600000.00", state: "SCHEDULED", status: "SCHEDULED", legacyAssertedBy: null, legacyMetAt: null, allocations: [] },
  ],
  payments: [],
  audit: [],
};

let failures = 0;
let total = 0;
function check(name, cond, extra = "") {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

// ── measure(): copied verbatim from payables-1b-runtime-qa.mjs ──────────────
async function measure(page, width, label) {
  // 1. The page itself must never scroll sideways. In RTL an overflow clips on
  //    the LEFT, where it is easy to miss entirely.
  const doc = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement.scrollWidth,
    clientWidth: document.scrollingElement.clientWidth,
  }));
  check(
    `${label} @${width}: the page does not scroll horizontally`,
    doc.scrollWidth <= doc.clientWidth + 1,
    `scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth}`,
  );

  // 2. No descendant may escape the box that is supposed to contain it. This is
  //    measured, not eyeballed: `overflow:hidden` on an ancestor would hide the
  //    escape visually while the geometry still proves the bug.
  const escapes = await page.evaluate(() => {
    const out = [];
    for (const container of document.querySelectorAll(
      '[class*="card"], [class*="installment"], [class*="form"], [class*="legacyNote"], [class*="notice"], [class*="error"]',
    )) {
      const cb = container.getBoundingClientRect();
      if (cb.width === 0) continue;
      for (const el of container.querySelectorAll("*")) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.position === "fixed" || style.position === "absolute") continue;
        // An element whose own box is wider than its container, or which starts
        // before / ends after it, has escaped.
        if (b.right > cb.right + 1 || b.left < cb.left - 1) {
          out.push({
            container: container.className,
            el: el.className || el.tagName,
            text: (el.textContent ?? "").slice(0, 40),
            elBox: [Math.round(b.left), Math.round(b.right)],
            containerBox: [Math.round(cb.left), Math.round(cb.right)],
          });
        }
      }
    }
    return out.slice(0, 6);
  });
  check(
    `${label} @${width}: nothing escapes its container`,
    escapes.length === 0,
    escapes.length ? JSON.stringify(escapes[0]) : "",
  );

  // 3. The one that actually matters, and the one a box comparison CANNOT see.
  //    When a long unbroken token refuses to wrap, the element's border box
  //    stays exactly where it was and the GLYPHS paint outside it — so
  //    getBoundingClientRect() reports nothing wrong while the user sees text
  //    crossing the card. `scrollWidth > clientWidth` is what detects it.
  //
  //    This check is the reason the harness is worth having: without it the
  //    suite passed happily with `overflow-wrap: normal`, which is the exact
  //    defect the CRM list shipped.
  const spills = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(
      '[class*="payee"], [class*="figureValue"], [class*="nextLine"], [class*="cardTitle"],' +
        '[class*="allocation"], [class*="legacyNote"], [class*="auditRow"], [class*="notice"]',
    )) {
      if (el.clientWidth === 0) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        out.push({
          el: el.className,
          text: (el.textContent ?? "").slice(0, 40),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        });
      }
    }
    return out.slice(0, 5);
  });
  check(
    `${label} @${width}: no text spills outside its own box`,
    spills.length === 0,
    spills.length ? JSON.stringify(spills[0]) : "",
  );

  return escapes;
}

async function tapTargets(page) {
  return page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll("button, input, select")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      const target =
        el instanceof HTMLInputElement && el.type === "checkbox" ? el.closest("label") ?? el : el;
      const tb = target.getBoundingClientRect();
      if (tb.height < 40) bad.push({ el: target.className || target.tagName, h: Math.round(tb.height) });
    }
    return bad.slice(0, 5);
  });
}

/** Words that would claim a bank confirmation the product does not have. */
const VERIFIED_WORDS = ["מאומת", "אומת", "אושר על ידי הבנק", "אישור הבנק התקבל", "verified", "confirmed"];

export async function shots(dir) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ locale: "he-IL" });
  await context.route("**/api/payables/bank-accounts*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accounts: ACCOUNTS, configured: true }) }));
  await context.route("**/api/payables/cheques*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cheques: CHEQUES }) }));
  await context.route("**/api/payables/commitments/*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commitment: DETAIL }) }));
  const page = await context.newPage();
  for (const w of [390, 1280]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`${BASE}/payables/cheques`, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${dir}/cheques-${w}.png`, fullPage: true });
    await page.goto(`${BASE}/payables/1`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "רשום צ׳ק" }).click();
    await page.screenshot({ path: `${dir}/commitment-${w}.png`, fullPage: true });
  }
  await browser.close();
}

const seenAuth = [];

async function main() {
  const browser = await chromium.launch();

  async function contextWith({ configured = true, accounts = ACCOUNTS } = {}) {
    const context = await browser.newContext({ locale: "he-IL" });
    // A signed-in browser. Every payables request must carry this token — the
    // check this harness originally lacked, which let a client that sent no
    // Authorization at all reach Production (every /api/payables call a 401).
    await context.addInitScript(() => localStorage.setItem("token", "qa-runtime-token"));
    context.on("request", (r) => {
      if (r.url().includes("/api/payables")) seenAuth.push(r.headers()["authorization"] ?? null);
    });
    const posted = [];
    await context.route("**/api/payables/bank-accounts*", async (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        posted.push(req.postDataJSON());
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            account: { ...ACCOUNTS[1], id: 7, last4: "5678", masked: "••••5678" },
            restored: false,
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ accounts, configured }),
      });
    });
    await context.route("**/api/payables/cheques*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cheques: CHEQUES }) }),
    );
    await context.route("**/api/payables/commitments/*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commitment: DETAIL }) }),
    );
    return { context, posted };
  }

  const { context, posted } = await contextWith();
  const page = await context.newPage();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });

    /* ── cheques page ───────────────────────────────────────────────────── */
    await page.goto(`${BASE}/payables/cheques`, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);

    if (width === WIDTHS[0]) {
      check(
        "the cheques surface is RTL",
        await page.evaluate(() => document.querySelector('[dir="rtl"]') !== null),
      );
    }
    await measure(page, width, "cheques");

    const body = await page.locator("body").innerText();
    check(`cheques @${width}: accounts show as masked last4`, body.includes("••••5678") && body.includes("••••0042"));
    check(
      `cheques @${width}: CLEARED reads as the owner's statement`,
      body.includes("נפרע (לפי דיווחך)") && body.includes("לא אישור מהבנק"),
    );
    check(`cheques @${width}: nothing claims bank verification`, VERIFIED_WORDS.every((w) => !body.includes(w)));
    check(
      `cheques @${width}: the replacement chain is shown both ways`,
      body.includes("הוחלף בצ׳ק") && body.includes("מחליף את צ׳ק"),
    );
    check(`cheques @${width}: a cleared cheque's unallocated surplus is surfaced`, body.includes("לא שויכו"));
    check(`cheques @${width}: the archived account is labelled`, body.includes("בארכיון"));

    const small = await tapTargets(page);
    check(
      `cheques @${width}: interactive controls are at least 40px tall`,
      small.length === 0,
      small.length ? JSON.stringify(small[0]) : "",
    );

    /* ── the cheque form: the number is typed, never suggested ─────────── */
    await page.getByRole("button", { name: "צ׳ק חדש" }).click();
    const numberInput = page.locator("#cq-number");
    check(`cheque form @${width}: the number field starts EMPTY`, (await numberInput.inputValue()) === "");
    check(
      `cheque form @${width}: the number field is text, not a number input`,
      (await numberInput.getAttribute("type")) !== "number",
    );
    const accountOptions = await page.locator("#cq-account option").allInnerTexts();
    check(
      `cheque form @${width}: archived accounts are not offered`,
      accountOptions.length === 2 && accountOptions.every((o) => !o.includes("9999")),
      JSON.stringify(accountOptions),
    );
    await measure(page, width, "cheque form");
    await page.getByRole("button", { name: "סגור" }).first().click();

    /* ── the account form: strings, zeros, cleared after save ──────────── */
    if (width === 390) {
      await page.getByRole("button", { name: "הוסף חשבון בנק" }).click();
      for (const id of ["#ba-bank", "#ba-branch", "#ba-account"]) {
        check(
          `account form: ${id} is a text input (zeros survive)`,
          (await page.locator(id).getAttribute("type")) !== "number",
        );
      }
      check("account form: autocomplete is off", (await page.locator("form[autocomplete='off']").count()) === 1);
      await page.fill("#ba-label", "בדיקה");
      await page.fill("#ba-bank", "12");
      await page.fill("#ba-branch", "034");
      await page.fill("#ba-account", "0098765432");
      await measure(page, width, "account form");
      await page.getByRole("button", { name: "שמור חשבון" }).click();
      await page.waitForTimeout(400);
      const sent = posted.at(-1) ?? {};
      check(
        "account form: coordinates are sent as STRINGS",
        typeof sent.accountNumber === "string" &&
          typeof sent.branchCode === "string" &&
          typeof sent.bankCode === "string",
      );
      check(
        "account form: leading zeros reach the server intact",
        sent.accountNumber === "0098765432" && sent.branchCode === "034",
      );
      const lingering = await page.evaluate(
        () =>
          [...document.querySelectorAll("input")].some((i) => i.value.includes("98765432")) ||
          document.body.innerText.includes("98765432"),
      );
      check("account form: the full number is gone from the page after saving", !lingering);
      check(
        "account form: the confirmation shows only the mask",
        (await page.locator("body").innerText()).includes("••••5678 נוסף"),
      );
    }

    /* ── commitment page: cheques belong to what they pay ──────────────── */
    await page.goto(`${BASE}/payables/1`, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);
    await measure(page, width, "commitment");
    const detailBody = await page.locator("body").innerText();
    check(
      `commitment @${width}: the cheque section is present`,
      detailBody.includes("צ׳קים") && detailBody.includes("רשום צ׳ק"),
    );
    await page.getByRole("button", { name: "רשום צ׳ק" }).click();
    const instOptions = await page.locator("#cq-inst option").allInnerTexts();
    check(
      `commitment @${width}: the cheque form offers the open installments`,
      instOptions.length === 3,
      `saw ${instOptions.length}`,
    );
    check(
      `commitment @${width}: the amount pre-fills from the installment, the number does not`,
      (await page.locator("#cq-amount").inputValue()) === "600000.00" &&
        (await page.locator("#cq-number").inputValue()) === "",
    );
    await measure(page, width, "commitment cheque form");
    const smallDetail = await tapTargets(page);
    check(
      `commitment @${width}: interactive controls are at least 40px tall`,
      smallDetail.length === 0,
      smallDetail.length ? JSON.stringify(smallDetail[0]) : "",
    );
  }
  await context.close();

  /* ── keys not configured: say so up front ─────────────────────────────── */
  const off = await contextWith({ configured: false, accounts: [] });
  const offPage = await off.context.newPage();
  await offPage.setViewportSize({ width: 390, height: 900 });
  await offPage.goto(`${BASE}/payables/cheques`, { waitUntil: "networkidle" });
  await offPage.waitForTimeout(250);
  const offBody = await offPage.locator("body").innerText();
  check("not configured: the page says so", offBody.includes("עדיין לא הופעלה"));
  check(
    "not configured: no add-account button is offered",
    (await offPage.getByRole("button", { name: "הוסף חשבון בנק" }).count()) === 0,
  );
  check(
    "not configured: no new-cheque button without an account",
    (await offPage.getByRole("button", { name: "צ׳ק חדש" }).count()) === 0,
  );
  await off.context.close();

  check(
    "every payables request carried Authorization: Bearer <session>",
    seenAuth.length > 0 && seenAuth.every((h) => h === "Bearer qa-runtime-token"),
    `${seenAuth.filter((h) => h !== "Bearer qa-runtime-token").length} of ${seenAuth.length} without it`,
  );
  await browser.close();
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.env.QA_SHOTS) { shots(process.env.QA_SHOTS).then(() => process.exit(0)); } else main().catch((e) => {
  console.error("QA crashed:", e);
  process.exit(1);
});
