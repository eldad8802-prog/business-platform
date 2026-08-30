/**
 * Billing fiscal regression snapshot — the safety net for the adaptive wave.
 *
 * Responsive screenshots cannot prove that a fiscal surface is unchanged, so
 * this captures, per document, the things a presentation change must never
 * move: every rendered monetary string, the document numbers, the heading, the
 * set of lifecycle actions offered, and every request the page issues. Run it
 * once before the change to write a baseline, and again after to diff.
 *
 *   node scripts/qa/ui/billing-fiscal-snapshot.mjs           # capture baseline
 *   node scripts/qa/ui/billing-fiscal-snapshot.mjs --check   # compare to baseline
 *
 * Creates nothing: billing documents are fiscal objects, so this only observes
 * documents that already exist (owner decision D-3).
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3124";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".billing-fiscal");
const TOKEN_FILE = process.env.AUDIT_TOKEN_FILE;
const CHECK = process.argv.includes("--check");
const BASELINE = path.join(OUT, "baseline.json");
const CURRENT = path.join(OUT, "current.json");

// Every viewport at which the wave changes composition. A monetary string that
// differs between two widths is itself a regression, so all are captured.
const VIEWPORTS = [390, 1024, 1280, 1920];

/**
 * Money as the product renders it. `formatMoney` uses Intl he-IL currency
 * formatting, which embeds bidi control marks (U+200F) between the number and
 * the symbol — the whitespace class does not match those, so the text is
 * stripped of bidi controls before matching. Matching on the symbol catches
 * totals, line figures and balances alike without knowing which component
 * produced them.
 */
const BIDI = /[‎‏؜⁦-⁩]/g;
const MONEY = /[₪$€]\s*[\d,]+\.\d{2}|[\d,]+\.\d{2}\s*[₪$€]/g;
/** Document numbers are fiscal identifiers — captured separately from money. */
const DOCNUM = /#?\d{4}-\d{4}|[QR]-\d{4}-\d{4}/g;

async function capture(page) {
  return page.evaluate(([moneySrc, bidiSrc, numSrc]) => {
    const re = new RegExp(moneySrc, "g");
    const numRe = new RegExp(numSrc, "g");
    const text = (document.body.innerText || "").replace(new RegExp(bidiSrc, "g"), "");
    const money = (text.match(re) || []).map((s) => s.replace(/\s+/g, " ").trim());
    // Actionable controls define what lifecycle the user is offered. Disabled
    // state is part of the contract: an action becoming available (or ceasing
    // to be) is exactly the kind of change this wave must not make.
    const actions = Array.from(document.querySelectorAll("button"))
      .filter((b) => b.offsetParent !== null || getComputedStyle(b).position === "fixed")
      .map((b) => ({
        label: (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
        disabled: b.disabled === true,
      }))
      .filter((a) => a.label.length > 0)
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    const heading = ((document.querySelector("h1") || {}).textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    return {
      // Compared as a SET: recomposition may legally move where a total
      // appears, but may never change, add or drop one.
      moneySorted: [...money].sort(),
      moneyCount: money.length,
      docNumbers: [...new Set(text.match(numRe) || [])].sort(),
      actions,
      heading,
    };
  }, [MONEY.source, BIDI.source, DOCNUM.source]);
}

async function settle(page) {
  await page
    .waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 40000 })
    .catch(() => {});
  await page.waitForTimeout(1300);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const token = JSON.parse(await readFile(TOKEN_FILE, "utf8")).token;
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

  // Record every request the page issues, so an API/lifecycle regression is
  // visible even when the rendered output happens to look identical.
  const requests = new Map();
  page.on("request", (r) => {
    const u = r.url();
    if (!u.includes("/api/")) return;
    const key = r.method() + " " + u.replace(/^https?:\/\/[^/]+/, "").replace(/\d+/g, ":id");
    requests.set(key, (requests.get(key) || 0) + 1);
  });

  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("token", t), token);

  // Observe whatever documents exist — never create one.
  const docs = await page.evaluate(async () => {
    const r = await fetch("/api/billing/documents", {
      headers: { authorization: "Bearer " + localStorage.getItem("token") },
    });
    const j = await r.json();
    const arr = j.documents || j.items || j;
    return (Array.isArray(arr) ? arr : []).map((d) => ({
      id: d.id,
      type: d.documentType,
      status: d.status,
      number: d.documentNumberFormatted,
      total: d.totalAmount,
    }));
  });
  console.log("documents observed: " + docs.length);

  const snap = { docs, perDoc: {} };
  for (const d of docs) {
    snap.perDoc[d.id] = {};
    for (const w of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
      await page.goto(BASE + "/billing/" + d.id, { waitUntil: "load", timeout: 60000 });
      await settle(page);
      snap.perDoc[d.id][w] = await capture(page);
    }
    const m = snap.perDoc[d.id][1920];
    console.log(
      "  doc " + d.id + " (" + d.type + "/" + d.status + "): money=" +
      JSON.stringify(m.moneySorted) + " nums=" + JSON.stringify(m.docNumbers) +
      " actions=" + m.actions.length
    );
  }

  snap.perDoc.hub = {};
  for (const w of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
    await page.goto(BASE + "/billing", { waitUntil: "load", timeout: 60000 });
    await settle(page);
    snap.perDoc.hub[w] = await capture(page);
  }
  console.log("  hub: " + snap.perDoc.hub[1920].moneyCount + " money strings");

  snap.requests = Object.fromEntries([...requests.entries()].sort());
  await writeFile(CURRENT, JSON.stringify(snap, null, 1));

  if (!CHECK) {
    await writeFile(BASELINE, JSON.stringify(snap, null, 1));
    console.log("\nbaseline written: " + BASELINE);
    await browser.close();
    return;
  }

  const base = JSON.parse(await readFile(BASELINE, "utf8"));
  const diffs = [];
  const cmp = (label, a, b) => {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa !== sb) diffs.push({ label, before: sa.slice(0, 400), after: sb.slice(0, 400) });
  };

  cmp("document list (id/type/status/number/total)", base.docs, snap.docs);
  for (const id of Object.keys(base.perDoc)) {
    for (const w of VIEWPORTS) {
      const a = base.perDoc[id] && base.perDoc[id][w];
      const b = snap.perDoc[id] && snap.perDoc[id][w];
      if (!a || !b) {
        diffs.push({ label: "doc " + id + "@" + w + " missing", before: !!a, after: !!b });
        continue;
      }
      cmp("doc " + id + "@" + w + " monetary values", a.moneySorted, b.moneySorted);
      cmp("doc " + id + "@" + w + " document numbers", a.docNumbers, b.docNumbers);
      cmp("doc " + id + "@" + w + " lifecycle actions", a.actions, b.actions);
      cmp("doc " + id + "@" + w + " heading", a.heading, b.heading);
    }
  }
  cmp("API requests issued", base.requests, snap.requests);

  console.log("\n=== FISCAL REGRESSION CHECK ===");
  if (!diffs.length) {
    console.log("PASS — monetary values, document numbers, lifecycle actions, headings and API calls all identical.");
  } else {
    console.log("FAIL — " + diffs.length + " difference(s):");
    for (const d of diffs) {
      console.log("\n • " + d.label + "\n   before: " + d.before + "\n   after:  " + d.after);
    }
  }
  await browser.close();
  process.exit(diffs.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
