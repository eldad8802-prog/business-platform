/**
 * Targeted runtime QA for the Slice 5 / main conflict on payable detail.
 * Mocks /api. Does not record a payment, change a commitment, or call a provider.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.QA_BASE || "http://localhost:3010";
const ROOT = path.resolve("qa-evidence/desktop-ux-phase-2");
const now = "2026-09-28T08:00:00.000+03:00";

let mode = "recurring-prepared";

function installment(sequence, state, remaining, status) {
  return {
    id: sequence,
    sequence,
    dueAt: sequence === 1 ? "2026-08-28T09:00:00.000+03:00" : "2026-09-28T09:00:00.000+03:00",
    scheduled: "4500.00",
    paid: state === "PAID" ? "4500.00" : "0.00",
    remaining,
    state,
    status,
    legacyAssertedBy: null,
    legacyMetAt: null,
    allocations: [],
  };
}

function preparation(status) {
  return {
    id: 5,
    status,
    amount: "4500.00",
    currency: "ILS",
    method: "BANK_TRANSFER",
    payee: { id: 3, name: "בעל הנכס" },
    commitment: { id: 9, title: "שכירות חודשית" },
    installment: { id: 2, sequence: 2, dueAt: "2026-09-28T09:00:00.000+03:00" },
    source: { id: 1, label: "עו\"ש", masked: "****4471", isActive: true },
    destination: {
      id: 4,
      label: "חשבון השכירות",
      beneficiaryName: "בעל הנכס",
      masked: "****8821",
      isActive: true,
      verification: "UNVERIFIED",
    },
    reference: null,
    note: null,
    approvedAt: status === "APPROVED" ? now : null,
    cancelledAt: null,
    cancellationReason: null,
    completedAt: null,
    completionSource: null,
    paymentId: null,
    executions: [],
    createdAt: now,
    actions: {
      approve: status === "PREPARED",
      cancel: status === "PREPARED" || status === "APPROVED",
      reportCompleted: status === "APPROVED",
      execute: status === "APPROVED",
    },
  };
}

function detail() {
  const ended = mode === "recurring-ended";
  const approved = mode === "recurring-approved";
  return {
    id: 9,
    title: "שכירות חודשית",
    payeeId: 3,
    payeeNameSnapshot: "בעל הנכס",
    currency: "ILS",
    scheduleKind: "RECURRING",
    recurrence: "MONTHLY",
    status: "ACTIVE",
    endAt: ended ? "2026-12-31T12:00:00.000+03:00" : null,
    note: "חוזה מתחדש",
    total: null,
    paid: "4500.00",
    remaining: null,
    isLegacy: false,
    legacy: null,
    installments: [
      installment(1, "PAID", "0.00", "SETTLED"),
      installment(2, "DUE", "4500.00", "SCHEDULED"),
    ],
    payments: [
      {
        id: 8,
        amount: "4500.00",
        allocated: "4500.00",
        unallocated: "0.00",
        status: "RECORDED",
        method: "BANK_TRANSFER",
        paidAt: "2026-08-28T09:00:00.000+03:00",
        externalReference: "AUG-1",
      },
    ],
    audit: [{ id: 1, eventType: "PREPARED", source: "owner", summary: "הוכן תשלום", occurredAt: now }],
    prepStatus: approved ? "APPROVED" : "PREPARED",
  };
}

function json(body) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

async function fulfill(route) {
  const url = new URL(route.request().url());
  const p = url.pathname;
  if (p.startsWith("/api/payables/commitments/")) {
    return route.fulfill(json({ commitment: detail() }));
  }
  if (p.startsWith("/api/payables/preparations")) {
    const status = mode === "recurring-approved" ? "APPROVED" : "PREPARED";
    return route.fulfill(json({ preparations: [preparation(status)] }));
  }
  if (p.startsWith("/api/payables/outbound-providers")) return route.fulfill(json({ providers: [], live: false }));
  if (p.startsWith("/api/payables/cheques")) return route.fulfill(json({ cheques: [] }));
  if (p.startsWith("/api/payables/bank-accounts")) {
    return route.fulfill(json({
      configured: true,
      accounts: [{ id: 1, label: "עו\"ש", last4: "4471", masked: "****4471", isActive: true, isDefault: true, note: null, createdAt: now }],
    }));
  }
  return route.fulfill(json({}));
}

const shots = [];

async function snap(page, file) {
  const dir = path.join(ROOT, "payables");
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, file), fullPage: false });
  const metrics = await page.evaluate(() => {
    const de = document.documentElement;
    const text = document.body.innerText || "";
    const notice = "התחייבות מתחדשת — אין סכום כולל ואין יתרה סופית. מוצג התשלום הקרוב בלבד.";
    return {
      overflow: de.scrollWidth > de.clientWidth + 2,
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      recurringNoticeCount: text.split(notice).length - 1,
      hasChanges: text.includes("שינוי סכום מתאריך") && text.includes("סיום ההתחייבות"),
      hasEndNotice: text.includes("ההתחייבות בתוקף עד"),
      hasProvider: text.includes("אין ספק לתשלומים יוצאים"),
      hasPrepare: text.includes("הכן תשלום"),
      hasApprove: text.includes("אשר תשלום"),
      hasApprovedCopy: text.includes("ביצוע אוטומטי אינו זמין"),
      hasSchedule: text.includes("לוח התשלומים"),
      text: text.replace(/\s+/g, " ").slice(0, 280),
    };
  });
  return { file: `payables/${file}`, ...metrics };
}

async function open(page, readyText) {
  await page.goto(`${BASE}/payables/9`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(
    (needle) => {
      const overlay = document.querySelector("[data-dubiz-intro-overlay]");
      const fading = overlay && getComputedStyle(overlay).opacity === "0";
      const text = document.body.innerText || "";
      return (!overlay || fading) && text.includes(needle);
    },
    readyText,
    { timeout: 25000 },
  );
}

async function shoot(page, label, width, readyText) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction(
    (needle) => (document.body.innerText || "").includes(needle),
    readyText,
    { timeout: 20000 },
  );
  await page.waitForFunction(
    () => !(document.body.innerText || "").includes("Compiling"),
    null,
    { timeout: 60000 },
  ).catch(() => {});
  await page.waitForTimeout(400);
  const result = await snap(page, `${label}-${width}.png`);
  shots.push({ label, width, ...result });
  console.log(label, width, result.overflow ? "OVERFLOW" : "ok", "notices", result.recurringNoticeCount, result.text.slice(0, 90));
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: "he-IL",
  timezoneId: "Asia/Jerusalem",
  reducedMotion: "reduce",
});
await context.addInitScript(() => {
  localStorage.setItem("token", "desktop-ux-qa");
  localStorage.setItem("user", JSON.stringify({ id: 1, name: "נועה", businessId: 1 }));
  localStorage.setItem("dubiz.home.identity.v1", "dubiz");
});
await context.route("**/api/**", fulfill);
const page = await context.newPage();

mode = "recurring-prepared";
await open(page, "שינוי סכום מתאריך");
for (const width of [390, 1024, 1440, 1920]) {
  await shoot(page, "recurring-changes", width, "שינוי סכום מתאריך");
}

await page.setViewportSize({ width: 1440, height: 900 });
await page.getByRole("checkbox", { name: /תשלום 2/ }).check();
await page.waitForFunction(
  () => !(document.body.innerText || "").includes("Compiling"),
  null,
  { timeout: 60000 },
).catch(() => {});
await page.waitForTimeout(400);
const selected = await snap(page, "recurring-installment-1440.png");
shots.push({ label: "recurring-installment", width: 1440, ...selected });
console.log("installment", selected.overflow ? "OVERFLOW" : "ok", selected.text.includes("תשלום 2") ? "checked-row" : "missing-row");

mode = "recurring-ended";
await open(page, "ההתחייבות בתוקף עד");
await shoot(page, "recurring-ended", 1440, "ההתחייבות בתוקף עד");
await shoot(page, "recurring-ended", 390, "ההתחייבות בתוקף עד");

mode = "recurring-approved";
await open(page, "ביצוע אוטומטי אינו זמין");
await shoot(page, "recurring-approved", 1440, "ביצוע אוטומטי אינו זמין");
await shoot(page, "recurring-approved", 390, "ביצוע אוטומטי אינו זמין");

await browser.close();
const overflow = shots.filter((shot) => shot.overflow);
const duplicated = shots.filter((shot) => shot.recurringNoticeCount !== 1);
const missingChanges = shots.filter((shot) => !shot.hasChanges);
fs.writeFileSync(
  path.join(ROOT, "slice5-conflict-metrics.json"),
  JSON.stringify({ shots: shots.length, overflow: overflow.length, duplicated: duplicated.length, missingChanges: missingChanges.length, shots }, null, 2),
);
console.log("SHOTS", shots.length, "OVERFLOW", overflow.length, "DUPLICATED", duplicated.length, "MISSING", missingChanges.length);
if (overflow.length || duplicated.length || missingChanges.length) process.exitCode = 2;
