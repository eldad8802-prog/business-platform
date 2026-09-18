/**
 * Phase 1b runtime QA — real components, measured boxes, hostile synthetic data.
 *
 * Data is injected at the NETWORK layer so the real page, the real CSS module
 * and the real React tree render it. Nothing is mocked inside the component.
 *
 * SCOPE, stated honestly: this proves UI and RUNTIME only. It proves nothing
 * about persistence — no database is touched here, and no assertion below may
 * be read as an API or ledger proof. That is the CI DB suite's job.
 *
 * Every value below is SYNTHETIC and deliberately hostile: a very long Hebrew
 * payee, a long Latin account reference inside Hebrew text (the bidi case that
 * reorders a line), a long unbroken token, and amounts wide enough to push a
 * row past its card.
 */

import { chromium } from "playwright";

const BASE = process.env.QA_BASE ?? "http://localhost:3517";
// Run: build, `npm run start`, then `node scripts/qa/payables-1b-runtime-qa.mjs`.
const WIDTHS = [320, 360, 390, 768, 1024, 1280, 1920];

const LONG_HE =
  "עיריית תל אביב יפו — אגף הגבייה, מחלקת ארנונה עסקית ושילוט, סניף מרכז";
const LONG_LATIN = "IL620108000000099999999/REF-2027-000123456789-ABCDEF";
const UNBROKEN = "אבגדהוזחטיכלמנסעפצקרשת".repeat(4);

const COMMITMENTS = [
  {
    id: 1,
    title: `ארנונה 2027 — ${LONG_HE}`,
    payeeId: 1,
    payeeNameSnapshot: LONG_HE,
    currency: "ILS",
    scheduleKind: "INSTALLMENT_PLAN",
    status: "ACTIVE",
    total: "1200000.00",
    paid: "300000.50",
    remaining: "899999.50",
    installmentCount: 12,
    next: {
      id: 11,
      sequence: 2,
      dueAt: "2027-02-15T09:00:00.000Z",
      scheduled: "100000.00",
      remaining: "100000.00",
      state: "OVERDUE",
    },
    attention: "OVERDUE",
    isLegacy: false,
  },
  {
    id: 2,
    title: UNBROKEN,
    payeeId: null,
    payeeNameSnapshot: `ספק ${LONG_LATIN}`,
    currency: "ILS",
    scheduleKind: "RECURRING",
    status: "ACTIVE",
    total: null,
    paid: "0.00",
    remaining: null,
    installmentCount: 1,
    next: {
      id: 21,
      sequence: 1,
      dueAt: "2027-03-01T09:00:00.000Z",
      scheduled: "6000.00",
      remaining: "6000.00",
      state: "DUE",
    },
    attention: "DUE",
    isLegacy: false,
  },
  {
    id: 3,
    title: "חוב ישן שסומן כטופל",
    payeeId: null,
    payeeNameSnapshot: "ספק ותיק",
    currency: "ILS",
    scheduleKind: "ONE_OFF",
    status: "CLOSED",
    total: "900.00",
    paid: "0.00",
    remaining: "900.00",
    installmentCount: 1,
    next: null,
    attention: "SETTLED_LEGACY",
    isLegacy: true,
  },
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
  paid: "300000.50",
  remaining: "899999.50",
  isLegacy: false,
  legacy: null,
  installments: [
    {
      id: 10,
      sequence: 1,
      dueAt: "2027-01-15T09:00:00.000Z",
      scheduled: "100000.00",
      paid: "100000.00",
      remaining: "0.00",
      state: "PAID",
      status: "SCHEDULED",
      legacyAssertedBy: null,
      legacyMetAt: null,
      allocations: [
        {
          id: 100,
          paymentId: 1000,
          amount: "100000.00",
          active: true,
          reversedAt: null,
          reversalReason: null,
          paymentStatus: "RECORDED",
          paymentPaidAt: "2027-01-16T09:00:00.000Z",
          paymentMethod: "BANK_TRANSFER",
        },
      ],
    },
    {
      id: 11,
      sequence: 2,
      dueAt: "2027-02-15T09:00:00.000Z",
      scheduled: "100000.00",
      paid: "0.00",
      remaining: "100000.00",
      state: "OVERDUE",
      status: "SCHEDULED",
      legacyAssertedBy: null,
      legacyMetAt: null,
      allocations: [
        {
          id: 101,
          paymentId: 1001,
          amount: "50000.00",
          active: false,
          reversedAt: "2027-02-20T09:00:00.000Z",
          reversalReason: `שויך בטעות לאסמכתא ${LONG_LATIN}`,
          paymentStatus: "RECORDED",
          paymentPaidAt: "2027-02-16T09:00:00.000Z",
          paymentMethod: "CHECK",
        },
      ],
    },
  ],
  payments: [
    {
      id: 1000,
      amount: "300000.50",
      allocated: "100000.00",
      unallocated: "200000.50",
      status: "RECORDED",
      method: "BANK_TRANSFER",
      paidAt: "2027-01-16T09:00:00.000Z",
      externalReference: LONG_LATIN,
    },
  ],
  audit: [
    {
      id: 1,
      eventType: "COMMITMENT_CREATED",
      source: "USER",
      summary: `נוצרה התחייבות ${LONG_HE}`,
      occurredAt: "2027-01-01T09:00:00.000Z",
    },
  ],
};

let failures = 0;
let total = 0;
function check(name, cond, extra = "") {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

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

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ locale: "he-IL" });

  // Network-layer injection. The real page, real CSS and real React render this.
  await context.route("**/api/payables/commitments?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ commitments: COMMITMENTS }),
    }),
  );
  await context.route("**/api/payables/commitments/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ commitment: DETAIL }),
    }),
  );
  await context.route("**/api/payables/payees*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ payees: [{ id: 1, displayName: LONG_HE, kind: "AUTHORITY" }] }),
    }),
  );

  const page = await context.newPage();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });

    /* ── list ─────────────────────────────────────────────────────────────── */
    await page.goto(`${BASE}/payables`, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);

    if (width === WIDTHS[0]) {
      const dir = await page.evaluate(
        () => document.querySelector('[dir="rtl"]') !== null,
      );
      check("the payables surface is RTL", dir);
    }

    const cards = await page.locator('button[class*="card"]').count();
    check(`list @${width}: all three commitments render`, cards === 3, `saw ${cards}`);

    await measure(page, width, "list");

    // The badge bug I shipped once before: a badge placed INSIDE a clamped
    // title is clipped away to zero and silently disappears. Measure it.
    const badgeBox = await page
      .locator('[class*="badge"]')
      .first()
      .boundingBox();
    check(
      `list @${width}: the state badge is actually visible`,
      !!badgeBox && badgeBox.width > 8 && badgeBox.height > 8,
      badgeBox ? `${Math.round(badgeBox.width)}x${Math.round(badgeBox.height)}` : "no box",
    );

    // A RECURRING commitment must show no invented remaining total.
    const recurringText = await page
      .locator('button[class*="card"]')
      .nth(1)
      .innerText();
    check(
      `list @${width}: RECURRING shows no invented remaining`,
      recurringText.includes("—"),
    );

    // The legacy row must not claim it was paid.
    const legacyText = await page
      .locator('button[class*="card"]')
      .nth(2)
      .innerText();
    check(
      `list @${width}: the legacy row says "סומן כטופל", never "שולם"`,
      legacyText.includes("סומן כטופל"),
    );

    /* ── detail ───────────────────────────────────────────────────────────── */
    await page.goto(`${BASE}/payables/1`, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);

    await measure(page, width, "detail");

    const body = await page.locator("body").innerText();
    check(
      `detail @${width}: the unallocated surplus is surfaced`,
      body.includes("לא שויכו") || body.includes("לא שויך"),
    );
    check(
      `detail @${width}: a reversed allocation is still shown`,
      body.includes("בוטל השיוך"),
    );

    // Tap targets: a 44px minimum is the difference between a usable and an
    // unusable form on a 320px phone.
    const small = await page.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll("button, input, select")) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        // For a checkbox the hit area is the LABEL that wraps it — a checkbox
        // drawn 44px tall looks wrong, but a 20px hit area on a phone IS wrong.
        // So measure whichever element the finger actually lands on, and still
        // fail if THAT is too small.
        const target =
          el instanceof HTMLInputElement && el.type === "checkbox"
            ? el.closest("label") ?? el
            : el;
        const tb = target.getBoundingClientRect();
        if (tb.height < 40) {
          bad.push({ el: target.className || target.tagName, h: Math.round(tb.height) });
        }
      }
      return bad.slice(0, 5);
    });
    check(
      `detail @${width}: interactive controls are at least 40px tall`,
      small.length === 0,
      small.length ? JSON.stringify(small[0]) : "",
    );
  }

  await browser.close();
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("QA crashed:", e);
  process.exit(1);
});
