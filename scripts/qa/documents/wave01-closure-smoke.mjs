/**
 * Documents Wave 0+1 — Production Closure Smoke (A–G).
 *
 * Runs against a REAL environment through a headed browser. Authentication is
 * done MANUALLY by the operator in the opened window (no credentials in chat,
 * none stored by this script beyond the browser's own profile dir).
 *
 *   SMOKE_BASE_URL=https://promaxgroup.co.il node scripts/qa/documents/wave01-closure-smoke.mjs
 *
 * Creates ONLY clearly-marked QA synthetic documents ("QA SYNTHETIC DOCUMENT",
 * vendors prefixed "QA CLOSURE"). Touches no real business documents and runs
 * no cleanup (Wave 2 policy).
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.SMOKE_BASE_URL || "https://promaxgroup.co.il";
const OUT = process.env.SMOKE_OUT_DIR || path.join(process.cwd(), ".smoke-out");
const PROFILE = process.env.SMOKE_PROFILE_DIR || path.join(OUT, "pw-profile");
const MONTH = "2026-08";
const HIST_MONTHS = ["2026-07", "2026-06"];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(page, apiPath, { method = "GET", body } = {}) {
  return page.evaluate(
    async ({ apiPath, method, body }) => {
      const token = localStorage.getItem("token");
      const res = await fetch(apiPath, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      let json = null;
      try {
        json = await res.json();
      } catch {}
      return { status: res.status, json };
    },
    { apiPath, method, body }
  );
}

async function uploadPng(page, base64, name, allowDuplicate = false) {
  return page.evaluate(
    async ({ base64, name, allowDuplicate }) => {
      const token = localStorage.getItem("token");
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const fd = new FormData();
      fd.append("file", new File([bytes], name, { type: "image/png" }));
      if (allowDuplicate) fd.append("allowDuplicate", "true");
      const res = await fetch("/api/documents/upload", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: fd,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {}
      return { status: res.status, json };
    },
    { base64, name, allowDuplicate }
  );
}

async function fetchZipBase64(page, body) {
  return page.evaluate(
    async ({ body }) => {
      const token = localStorage.getItem("token");
      const started = Date.now();
      const res = await fetch("/api/reports/export-zip", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const ms = Date.now() - started;
      if (!res.ok) return { status: res.status, ms, base64: null };
      const buf = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
      }
      return {
        status: res.status,
        ms,
        bytes: buf.length,
        contentLength: res.headers.get("content-length"),
        base64: btoa(bin),
      };
    },
    { body }
  );
}

function receiptHtml({ vendor, amount, dateIl, extraLines = [], quote = false }) {
  return `<!doctype html><html dir="rtl"><body style="margin:0;background:#fff;color:#000;font-family:Arial,sans-serif;width:860px;">
  <div style="padding:48px;border:6px solid #000;margin:20px;">
    <div style="font-size:44px;font-weight:900;">${quote ? "הצעת מחיר" : "קבלה / חשבונית מס"}</div>
    <div style="font-size:40px;font-weight:800;margin-top:22px;">${vendor}</div>
    <div style="font-size:34px;margin-top:22px;">תאריך: ${dateIl}</div>
    <div style="font-size:34px;margin-top:10px;">מספר מסמך: 9${Math.floor(Math.random() * 0) + 1001}</div>
    <div style="font-size:40px;font-weight:900;margin-top:26px;">סה"כ לתשלום כולל מע"מ: ${amount} ₪</div>
    ${extraLines.map((l) => `<div style=\"font-size:28px;margin-top:10px;\">${l}</div>`).join("")}
    <div style="font-size:26px;margin-top:34px;letter-spacing:2px;">QA SYNTHETIC DOCUMENT — WAVE01 CLOSURE SMOKE</div>
  </div></body></html>`;
}

async function makePng(ctx, spec) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 900, height: 900 });
  await p.setContent(receiptHtml(spec));
  const buf = await p.screenshot({ fullPage: true, type: "png" });
  await p.close();
  return buf;
}

async function waitProcessed(page, id, timeoutMs = 120000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await api(page, `/api/documents/${id}`);
    const st = last?.json?.document?.status;
    if (st && st !== "processing") return last;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return last;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  // ── LOGIN (manual) ──────────────────────────────────────────────────────
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  let token = await page.evaluate(() => localStorage.getItem("token"));
  if (!token) {
    console.log("\n=== נדרשת התחברות ידנית ===");
    console.log(`התחבר בחלון הדפדפן שנפתח (${BASE}/login).`);
    console.log("הסקריפט ימשיך אוטומטית ברגע שההתחברות תושלם. ממתין עד 60 דקות...\n");
    const started = Date.now();
    while (!token && Date.now() - started < 60 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 2000));
      token = await page.evaluate(() => localStorage.getItem("token")).catch(() => null);
    }
  }
  if (!token) {
    console.error("FAIL: לא בוצעה התחברות — עוצר.");
    await ctx.close();
    process.exit(2);
  }
  console.log("OK  : authenticated session established (token stays local)\n");

  const dateIl = "26/08/2026";
  const A = { vendor: "QA CLOSURE VENDOR ALPHA", amount: "777.33" };
  const B = { vendor: "QA CLOSURE VENDOR BRAVO", amount: "55.44" };
  const E = { vendor: A.vendor, amount: A.amount };

  // Totals BEFORE (current month).
  const sumBefore = await api(page, `/api/reports/summary?month=${MONTH}`);
  const expBefore = Number(sumBefore?.json?.totalExpense ?? NaN);
  check("summary BEFORE readable", Number.isFinite(expBefore), `expense=${expBefore}`);

  // ── SMOKE A — financial document ───────────────────────────────────────
  const pngA = await makePng(ctx, { ...A, dateIl });
  const upA = await uploadPng(page, pngA.toString("base64"), "qa-closure-alpha.png");
  check("A: upload accepted (runtime regression gate)", upA.status === 200 && upA.json?.documentId, `status=${upA.status} id=${upA.json?.documentId}`);
  const docA = upA.json?.documentId;

  const gotA = await waitProcessed(page, docA);
  check("A: OCR/extraction completed", gotA?.json?.document?.status === "needs_review", `status=${gotA?.json?.document?.status}`);
  const profA = gotA?.json?.outputProfile?.profileId;
  const extA = gotA?.json?.extracted;
  check("A: profile resolved financial_transaction", profA === "financial_transaction", `profile=${profA}`);

  await page.goto(`${BASE}/documents/review/${docA}`, { waitUntil: "networkidle" });
  await shot(page, "smokeA-review");

  const apprA = await api(page, `/api/documents/${docA}/approve`, {
    method: "POST",
    body: {
      explicitFinancial: true,
      extracted: {
        amount: 777.33,
        vendorName: A.vendor,
        date: "2026-08-26",
        direction: "expense",
        category: "general",
      },
    },
  });
  check("A: financial approve 200", apprA.status === 200 && apprA.json?.approvedAs === "financial", `status=${apprA.status}`);
  check("A: FinancialRecord returned", Boolean(apprA.json?.record?.id), `frId=${apprA.json?.record?.id}`);

  const sumAfterA = await api(page, `/api/reports/summary?month=${MONTH}`);
  const expAfterA = Number(sumAfterA?.json?.totalExpense ?? NaN);
  check(
    "A: totals moved by EXACTLY 777.33",
    Math.abs(expAfterA - expBefore - 777.33) < 0.001,
    `before=${expBefore} after=${expAfterA}`
  );

  // ── SMOKE B — early review / OCR race ──────────────────────────────────
  const pngB = await makePng(ctx, { ...B, dateIl });
  const upB = await uploadPng(page, pngB.toString("base64"), "qa-closure-bravo.png");
  const docB = upB.json?.documentId;
  check("B: upload accepted", upB.status === 200 && docB, `id=${docB}`);

  // Reproduce the historic poison: hit GET + open review WHILE processing.
  const early = await api(page, `/api/documents/${docB}`);
  const earlyProfile = early?.json?.outputProfile?.profileId;
  await page.goto(`${BASE}/documents/review/${docB}`, { waitUntil: "domcontentloaded" });
  console.log(`     (early profile while processing: ${earlyProfile})`);

  const gotB = await waitProcessed(page, docB);
  check("B: extraction completed", gotB?.json?.document?.status === "needs_review", `status=${gotB?.json?.document?.status}`);
  const profB = gotB?.json?.outputProfile?.profileId;
  check(
    "B: post-OCR profile NOT poisoned (financial_transaction, not quote_or_order)",
    profB === "financial_transaction",
    `early=${earlyProfile} post=${profB}`
  );
  await page.goto(`${BASE}/documents/review/${docB}`, { waitUntil: "networkidle" });
  await shot(page, "smokeB-review-after-race");

  const apprB = await api(page, `/api/documents/${docB}/approve`, {
    method: "POST",
    body: {
      explicitFinancial: true,
      extracted: {
        amount: 55.44,
        vendorName: B.vendor,
        date: "2026-08-26",
        direction: "expense",
        category: "general",
      },
    },
  });
  check("B: financial approve after race → FR created (no orphan)", apprB.status === 200 && Boolean(apprB.json?.record?.id), `status=${apprB.status} frId=${apprB.json?.record?.id}`);

  // ── SMOKE C — informational document ───────────────────────────────────
  const pngC = await makePng(ctx, {
    vendor: "QA CLOSURE QUOTE VENDOR",
    amount: "999.00",
    dateIl,
    quote: true,
    extraLines: ["הצעה זו אינה חשבונית ואינה קבלה"],
  });
  const upC = await uploadPng(page, pngC.toString("base64"), "qa-closure-quote.png");
  const docC = upC.json?.documentId;
  check("C: upload accepted", upC.status === 200 && docC, `id=${docC}`);
  const gotC = await waitProcessed(page, docC);
  const profC = gotC?.json?.outputProfile?.profileId;
  console.log(`     (C profile: ${profC})`);
  await page.goto(`${BASE}/documents/review/${docC}`, { waitUntil: "networkidle" });
  await shot(page, "smokeC-review-informational");
  const uiSaysInfo = await page
    .getByText("שמור כמסמך מידע", { exact: false })
    .first()
    .isVisible()
    .catch(() => false);
  check("C: UI offers explicit informational save", uiSaysInfo);

  const apprC = await api(page, `/api/documents/${docC}/approve`, {
    method: "POST",
    body: {
      explicitFinancial: false,
      extracted: { vendorName: "QA CLOSURE QUOTE VENDOR", category: "general", date: "2026-08-26" },
    },
  });
  check("C: saved as document (not financial)", apprC.status === 200 && apprC.json?.approvedAs === "document", `status=${apprC.status} as=${apprC.json?.approvedAs}`);
  check("C: no FinancialRecord returned", !apprC.json?.record);
  const sumAfterC = await api(page, `/api/reports/summary?month=${MONTH}`);
  const expAfterC = Number(sumAfterC?.json?.totalExpense ?? NaN);
  check(
    "C: totals unchanged by informational save",
    Math.abs(expAfterC - expAfterA - 55.44) < 0.001,
    `after-B-approve expected ${expAfterA + 55.44}, got ${expAfterC}`
  );

  // ── SMOKE D — exact duplicate ──────────────────────────────────────────
  const upD = await uploadPng(page, pngA.toString("base64"), "qa-closure-alpha-again.png");
  check("D: identical bytes blocked with 409", upD.status === 409, `status=${upD.status}`);
  check(
    "D: existing document surfaced",
    Number(upD.json?.duplicate?.documentId) === Number(docA),
    `existing=${upD.json?.duplicate?.documentId} expected=${docA}`
  );
  check("D: no new document created (no override used)", !upD.json?.documentId);

  // ── SMOKE E — semantic duplicate (different bytes) ─────────────────────
  const pngE = await makePng(ctx, {
    ...E,
    dateIl,
    extraLines: ["עותק סריקה שני — פריסת עמוד שונה", "שורת רעש לשינוי בייטים בלבד"],
  });
  const upE = await uploadPng(page, pngE.toString("base64"), "qa-closure-alpha-rescan.png");
  const docE = upE.json?.documentId;
  check("E: different-bytes upload NOT hard-blocked", upE.status === 200 && docE, `status=${upE.status} id=${docE}`);
  const gotE = await waitProcessed(page, docE);
  const sigs = gotE?.json?.duplicateSignals ?? [];
  check(
    "E: same_transaction warning present",
    sigs.some((s) => s.level === "same_transaction" || s.level === "exact_file"),
    JSON.stringify(sigs)
  );
  check(
    "E: warning knows a FinancialRecord already exists",
    sigs.some((s) => s.hasFinancialRecord),
    ""
  );
  await page.goto(`${BASE}/documents/review/${docE}`, { waitUntil: "networkidle" });
  await shot(page, "smokeE-duplicate-warning");
  const bannerVisible = await page
    .getByText("כבר נרשמה", { exact: false })
    .first()
    .isVisible()
    .catch(() => false);
  check("E: review banner visible", bannerVisible);
  // Leave docE unapproved-financially: save as informational to avoid a real dup.
  await api(page, `/api/documents/${docE}/approve`, {
    method: "POST",
    body: { explicitFinancial: false, extracted: { vendorName: E.vendor, category: "general", date: "2026-08-26" } },
  });

  // ── SMOKE F — approved mutation guard ──────────────────────────────────
  const mut = await api(page, `/api/documents/${docA}/approve`, {
    method: "POST",
    body: {
      explicitFinancial: true,
      extracted: {
        amount: 1.0,
        vendorName: A.vendor,
        date: "2026-08-26",
        direction: "expense",
        category: "general",
      },
    },
  });
  check(
    "F: silent overwrite (777.33→1.00) rejected",
    mut.status === 409 && mut.json?.code === "approved_financial_locked",
    `status=${mut.status} code=${mut.json?.code}`
  );
  const downg = await api(page, `/api/documents/${docA}/approve`, {
    method: "POST",
    body: { explicitFinancial: false, extracted: { vendorName: A.vendor, category: "general", date: "2026-08-26" } },
  });
  check("F: downgrade-to-informational rejected", downg.status === 409, `status=${downg.status}`);
  const sumAfterF = await api(page, `/api/reports/summary?month=${MONTH}`);
  check(
    "F: totals untouched by rejected mutations",
    Math.abs(Number(sumAfterF?.json?.totalExpense) - expAfterC) < 0.001,
    `expense=${sumAfterF?.json?.totalExpense}`
  );
  await page.goto(`${BASE}/documents/review/${docA}`, { waitUntil: "networkidle" });
  await shot(page, "smokeF-locked");

  // ── SMOKE G — accountant ZIP on real historical months ─────────────────
  for (const m of HIST_MONTHS) {
    const zip = await fetchZipBase64(page, { type: "month", month: m });
    check(`G: ${m} export completed (no 504)`, zip.status === 200 && zip.base64, `status=${zip.status} ms=${zip.ms} bytes=${zip.bytes} content-length=${zip.contentLength}`);
    if (zip.base64) {
      await writeFile(path.join(OUT, `accountant-${m}.zip`), Buffer.from(zip.base64, "base64"));
    }
  }

  await writeFile(path.join(OUT, "results.json"), JSON.stringify({ BASE, docA, docB, docC, docE, results }, null, 2));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(" -", f.name, f.detail);
  }
  console.log(`artifacts: ${OUT}`);
  await ctx.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
