/**
 * Phases 4–6 runtime QA — הכן תשלום and bank lines, real components, measured boxes.
 *
 * Network-injected data through the real pages (same method as the 1b/3
 * harnesses), PLUS inspection of every outgoing payables request: each must
 * carry the session token. The authenticated Production E2E is separate; this
 * proves layout, wording and request shape at seven widths.
 *
 * Run: build, `npm run start`, then `node scripts/qa/payables-p46-runtime-qa.mjs`.
 */

import { chromium } from "playwright";

const BASE = process.env.QA_BASE ?? "http://localhost:3517";
const WIDTHS = [320, 360, 390, 768, 1024, 1280, 1920];
const LONG_HE = "עיריית תל אביב יפו — אגף הגבייה, מחלקת ארנונה עסקית ושילוט, סניף מרכז";
const LONG_REF = "INV-2027-000123456789-ABCDEFGHIJ/ג";

const DETAIL = {
  id: 1,
  title: `ארנונה 2027 — ${LONG_HE}`,
  payeeId: 7,
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

const actions = {
  PREPARED: { approve: true, cancel: true, reportCompleted: false, execute: false },
  APPROVED: { approve: false, cancel: true, reportCompleted: true, execute: true },
  COMPLETED: { approve: false, cancel: false, reportCompleted: false, execute: false },
};
const prepOf = (id, status, extra = {}) => ({
  id,
  status,
  amount: "600000.00",
  currency: "ILS",
  method: "BANK_TRANSFER",
  payee: { id: 7, name: LONG_HE },
  commitment: { id: 1, title: DETAIL.title },
  installment: { id: 11, sequence: 1, dueAt: "2027-02-15T09:00:00.000Z" },
  source: { id: 3, label: "חשבון העסק הראשי בבנק לאומי — סניף רמת החייל", masked: "••••5678", isActive: true },
  destination: { id: 9, label: "חשבון ראשי", beneficiaryName: LONG_HE, masked: "••••6543", isActive: true, verification: "NONE" },
  reference: LONG_REF,
  note: null,
  approvedAt: status === "PREPARED" ? null : "2027-02-10T09:00:00.000Z",
  cancelledAt: null,
  cancellationReason: null,
  completedAt: status === "COMPLETED" ? "2027-02-11T09:00:00.000Z" : null,
  completionSource: status === "COMPLETED" ? "OWNER_REPORTED" : null,
  paymentId: status === "COMPLETED" ? 55 : null,
  executions: [],
  createdAt: "2027-02-10T08:00:00.000Z",
  actions: actions[status],
  ...extra,
});
const PREPS = [prepOf(1, "PREPARED"), prepOf(2, "APPROVED"), prepOf(3, "COMPLETED")];
const DESTS = [{ id: 9, payeeId: 7, label: "חשבון ראשי", beneficiaryName: LONG_HE, last4: "6543", masked: "••••6543", origin: "OWNER_ENTERED", verification: "NONE", isActive: true, isDefault: true, replacesDestinationId: null, note: null, createdAt: "2027-01-01T00:00:00Z" }];
const ACCOUNTS = [{ id: 3, label: "חשבון העסק", last4: "5678", masked: "••••5678", isActive: true, isDefault: true, note: null, createdAt: "2027-01-01T00:00:00Z" }];
const LINES = [
  { id: 21, source: "OWNER_UPLOAD", direction: "DEBIT", amount: "600000.00", currency: "ILS", bookedAt: "2027-02-11T12:00:00Z", counterpartyName: LONG_HE, reference: LONG_REF, description: 'העברה בע"מ', sourceAccount: { id: 3, label: "x", last4: "5678" }, state: "OPEN", matchedPayment: null, dismissReason: null },
  { id: 22, source: "OWNER_ENTRY", direction: "DEBIT", amount: "15.00", currency: "ILS", bookedAt: "2027-02-12T12:00:00Z", counterpartyName: null, reference: null, description: "עמלה", sourceAccount: null, state: "MATCHED", matchedPayment: { evidenceId: 4, paymentId: 55, payeeName: LONG_HE, paymentStatus: "RECORDED" }, dismissReason: null },
];
const SUGGESTIONS = {
  suggestions: [
    { kind: "PAYMENT", id: 55, commitmentId: 1, commitmentTitle: DETAIL.title, payeeName: LONG_HE, amount: "600000.00", date: "2027-02-11T12:00:00Z", confidence: "STRONG", reasons: ["הסכום זהה", "שם הספק תואם", "האסמכתא תואמת"] },
    { kind: "INSTALLMENT", id: 12, commitmentId: 1, commitmentTitle: DETAIL.title, payeeName: LONG_HE, amount: "600000.00", date: "2027-03-15T09:00:00Z", confidence: "POSSIBLE", reasons: ["הסכום זהה", "הפרש של 32 ימים"], installmentId: 12 },
  ],
  ambiguous: true,
  reason: null,
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
      const target = el instanceof HTMLInputElement && el.type === "checkbox" ? el.closest("label") ?? el : el;
      const tb = target.getBoundingClientRect();
      if (tb.height < 40) bad.push({ el: target.className || target.tagName, h: Math.round(tb.height) });
    }
    return bad.slice(0, 5);
  });
}

/** Words that would claim a verification nothing performed. */
const VERIFIED_WORDS = ["מאומת", "אומת ", "אושר על ידי הבנק", "verified", "confirmed by the bank"];

const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ locale: "he-IL" });
  await context.addInitScript(() => localStorage.setItem("token", "qa-runtime-token"));
  const seenAuth = [];
  context.on("request", (r) => {
    if (r.url().includes("/api/payables")) seenAuth.push(r.headers()["authorization"] ?? null);
  });
  await context.route("**/api/payables/commitments/*", (r) => json(r, { commitment: DETAIL }));
  await context.route("**/api/payables/cheques*", (r) => json(r, { cheques: [] }));
  await context.route("**/api/payables/bank-accounts*", (r) => json(r, { accounts: ACCOUNTS, configured: true }));
  await context.route("**/api/payables/preparations*", (r) => json(r, { preparations: PREPS }));
  await context.route("**/api/payables/outbound-providers", (r) => json(r, { providers: [], live: false }));
  await context.route("**/api/payables/destinations?*", (r) => json(r, { destinations: DESTS }));
  await context.route("**/api/payables/bank-lines?*", (r) => json(r, { lines: LINES }));
  await context.route("**/api/payables/bank-lines/*/suggestions", (r) => json(r, SUGGESTIONS));

  const page = await context.newPage();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });

    /* ── commitment page: prepared payments ─────────────────────────────── */
    await page.goto(`${BASE}/payables/1`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    await measure(page, width, "prepared");
    const body = await page.locator("body").innerText();
    for (const w of ["למי", "כמה", "מאיפה", "לאן", "עבור", "מה הלאה"]) {
      if (width === 390) check(`prepared: the summary answers "${w}"`, body.includes(w));
    }
    check(`prepared @${width}: accounts are masked only`, body.includes("••••6543") && body.includes("••••5678"));
    check(`prepared @${width}: PREPARED says nothing was paid`, body.includes("עדיין לא שולם דבר"));
    check(`prepared @${width}: APPROVED says nothing is recorded until done`, body.includes("עד אז שום דבר לא נרשם כשולם"));
    check(`prepared @${width}: no outbound provider → says so, offers no execute`, body.includes("ביצוע אוטומטי אינו זמין") && !body.includes("שלח לביצוע"));
    check(`prepared @${width}: COMPLETED names its provenance (לפי דיווחך)`, body.includes("לפי דיווחך"));
    check(`prepared @${width}: destinations say the bank did not check them`, body.includes("הבנק לא בדק אותם"));
    check(`prepared @${width}: no verification wording`, VERIFIED_WORDS.every((w) => !body.includes(w)));
    const small = await tapTargets(page);
    check(`prepared @${width}: tap targets ≥ 40px`, small.length === 0, small.length ? JSON.stringify(small[0]) : "");

    await page.getByRole("button", { name: "הכן תשלום", exact: true }).first().click();
    await page.waitForTimeout(300);
    check(`prepare form @${width}: amount pre-filled from the installment`, (await page.locator("#pr-amount").inputValue()) === "600000.00");
    check(`prepare form @${width}: destination offered masked`, (await page.locator("#pr-dest option").allInnerTexts()).some((t) => t.includes("••••6543")));
    await measure(page, width, "prepare form");
    if (width === 390) {
      await page.getByRole("button", { name: "הוסף חשבון יעד" }).click();
      for (const id of ["#dst-bank", "#dst-branch", "#dst-account"]) {
        check(`destination form: ${id} is text (zeros survive)`, (await page.locator(id).getAttribute("type")) !== "number");
      }
      await measure(page, width, "destination form");
    }

    /* ── bank lines ─────────────────────────────────────────────────────── */
    await page.goto(`${BASE}/payables/bank`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const bank = await page.locator("body").innerText();
    check(`bank @${width}: says there is no bank connection`, bank.includes("אין חיבור ישיר לבנק"));
    check(`bank @${width}: a matched line says the match moved no money`, bank.includes("השיוך לא הזיז כסף"));
    check(`bank @${width}: a quote inside a description renders (בע"מ)`, bank.includes('בע"מ'));
    await page.getByRole("button", { name: "הצע התאמות" }).first().click();
    await page.waitForTimeout(400);
    const withSug = await page.locator("body").innerText();
    check(`bank @${width}: ties are declared ambiguous, not auto-picked`, withSug.includes("אי אפשר להבדיל"));
    check(`bank @${width}: existing payment offered as EVIDENCE`, withSug.includes("זו ראיה לתשלום הזה"));
    check(`bank @${width}: confidence is STRONG-at-most wording, never "matched"`, !/התאמה ודאית|MATCHED/.test(withSug));
    await measure(page, width, "bank lines");
    const smallB = await tapTargets(page);
    check(`bank @${width}: tap targets ≥ 40px`, smallB.length === 0, smallB.length ? JSON.stringify(smallB[0]) : "");
  }
  check("every payables request carried Authorization: Bearer <session>",
    seenAuth.length > 0 && seenAuth.every((h) => h === "Bearer qa-runtime-token"),
    `${seenAuth.filter((h) => h !== "Bearer qa-runtime-token").length} of ${seenAuth.length} without it`);
  await browser.close();
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("QA crashed:", e);
  process.exit(1);
});
