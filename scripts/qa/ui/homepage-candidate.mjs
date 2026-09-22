/**
 * HOMEPAGE v4 — automated QA gate (the public homepage, /home).
 *
 * Written to fail on the defects this page must never ship with:
 *   - a CTA that leads to the closed-registration wall, or more than the two
 *     approved primary actions (hero + final)
 *   - horizontal overflow — measured on the document AND on every element
 *     (`overflow-x: hidden` HIDES overflow, it does not prevent it)
 *   - the approved ten sections missing or out of order
 *   - hidden product proof: any tab / tabpanel / carousel on the page
 *   - product imagery that did not load, or that is shown below 1.5 device px
 *     per CSS px (a soft screenshot proves nothing)
 *   - decorative emoji, synthetic font weights (>600), tiny tap targets
 *   - an unsupported claim creeping into the copy (see FORBIDDEN_CLAIMS and
 *     docs/dubiz-homepage-copy-v3.md), and the two qualifications drifting:
 *     "CardCom" exactly once (FAQ), "270901" exactly once (invoices)
 *   - the accessibility work regressing: skip link, FAQ by keyboard, drawer
 *     Escape + focus return, reduced motion
 *
 * Run ONCE PER SIGNUP STATE (the CTA contract differs):
 *   PUBLIC_SIGNUP_ENABLED=false npx next start -p 3147
 *   AUDIT_BASE_URL=http://localhost:3147 EXPECT_SIGNUP=off node scripts/qa/ui/homepage-candidate.mjs
 *   PUBLIC_SIGNUP_ENABLED=true  npx next start -p 3148
 *   AUDIT_BASE_URL=http://localhost:3148 EXPECT_SIGNUP=on  node scripts/qa/ui/homepage-candidate.mjs
 *
 * Optional: AUDIT_ROUTE (default /home), AUDIT_OUT_DIR.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3147";
const ROUTE = process.env.AUDIT_ROUTE || "/home";
const EXPECT_SIGNUP = (process.env.EXPECT_SIGNUP || "off").toLowerCase();
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), `.homepage-qa-${EXPECT_SIGNUP}`);

const WIDTHS = [360, 390, 768, 1024, 1280, 1440, 1536];
const MOBILE = 390;

const SECTIONS = ["01-hero", "02-attention", "03-collection", "04-documents", "05-invoices", "06-leads", "07-map", "08-control", "09-faq", "10-final"];

/** Claims the runtime audit ruled out (copy record §0). Matched on visible text. */
const FORBIDDEN_CLAIMS = [
  "אזכיר", "תזכורת", "נזכיר", "אחזור אליך", "מתריעה", "התראות חכמות",
  "שולחת לבד", "שולח לבד", "עונה לבד", "אוטומטית", "באופן אוטומטי",
  "24/7", "מסביב לשעון", "בדיוק בזמן", "מסנכרן", "סנכרון",
  "בינה מלאכותית", "AI", "חכמה", "לומד",
  "מחליף רואה חשבון", "מחליפה רואה חשבון", "פורמט תקין", "מאושר על ידי רשות המסים",
  // the registration is a REGISTRATION: "approved" / "recognised" are not ours
  "מאושרת ברשות המסים", "מאושרת על ידי רשות המסים", "מוכרת ברשות המסים",
  // market language we deliberately do not compete on
  "ניהול העסק", "כל מה שהעסק צריך", "הכול במקום אחד", "חיסכון בזמן",
  "מספר הקצאה", "מספרי הקצאה", "קבלה דיגיטלית", "חשבונית זיכוי",
  "פלטפורמה", "מערכת הפעלה", "בחינם", "תקופת ניסיון", "ללא התחייבות",
  "Tranzila", "PayPlus", "SUMIT",
];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function walk(page) {
  await page.evaluate(async () => {
    const step = Math.max(300, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
  });
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const consoleErrors = [];

  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: "he-IL" });
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(`${width}: ${m.text()}`);
    });
    const res = await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });
    check(`${width} · route renders 200`, res && res.status() === 200, res ? res.status() : "no response");
    check(`${width} · document is RTL`, (await page.evaluate(() => document.documentElement.dir)) === "rtl");
    await walk(page);

    /* overflow — the document and every element */
    const doc = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    check(`${width} · no document overflow`, doc.s <= doc.c + 1, `${doc.s} vs ${doc.c}`);
    // Content overflow is measured with the purely decorative layer (aria-hidden
    // colour masses, notches, perforations) taken out of layout: those are
    // clipped by their section ON PURPOSE. The document check above keeps them in.
    const offenders = await page.evaluate(() => {
      const deco = [...document.querySelectorAll('main [aria-hidden="true"]')];
      const prev = deco.map((e) => e.style.display);
      deco.forEach((e) => (e.style.display = "none"));
      const out = [];
      for (const el of document.querySelectorAll("*")) {
        if (el.closest("svg")) continue; // SVG geometry, not text flow
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
          const cs = getComputedStyle(el);
          if (["auto", "scroll"].includes(cs.overflowX)) continue; // real scroll containers
          if (cs.overflowX === "clip") continue; // sections clip their own colour masses on purpose
          if (el.clientWidth <= 1 && el.clientHeight <= 1 && cs.overflow === "hidden") continue; // sr-only
          out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} ${el.scrollWidth}>${el.clientWidth}`);
        }
      }
      deco.forEach((e, i) => (e.style.display = prev[i]));
      return out.slice(0, 6);
    });
    check(`${width} · no element overflow`, offenders.length === 0, offenders.join(" | "));

    /* structure */
    const order = await page.evaluate(() => [...document.querySelectorAll("main [data-section]")].map((e) => e.getAttribute("data-section")));
    check(`${width} · the ten approved sections, in order`, JSON.stringify(order) === JSON.stringify(SECTIONS), order.join(","));
    const hidden = await page.evaluate(() => document.querySelectorAll('main [role="tab"], main [role="tabpanel"], main [aria-roledescription="carousel"]').length);
    check(`${width} · no tabs / carousel (nothing hidden)`, hidden === 0, hidden);

    /* CTA contract */
    const primaries = await page.evaluate(() => [...document.querySelectorAll(".dz-btn-primary")].map((a) => a.getAttribute("href")));
    check(`${width} · exactly 2 primary CTAs`, primaries.length === 2, primaries.join(","));
    check(`${width} · header login is not a primary`, (await page.evaluate(() => document.querySelectorAll("header .dz-btn-primary").length)) === 0);
    const reg = await page.evaluate(() => [...document.querySelectorAll("a[href]")].filter((a) => a.getAttribute("href").startsWith("/register")).length);
    if (EXPECT_SIGNUP === "off") {
      check(`${width} · NO /register link while signup is closed`, reg === 0, reg);
      check(`${width} · primaries → /login`, primaries.every((h) => h === "/login"), primaries.join(","));
    } else {
      check(`${width} · primaries → /register`, primaries.length === 2 && primaries.every((h) => h === "/register"), primaries.join(","));
    }

    /* product imagery: loaded, and sharp */
    const imgs = await page.evaluate(async () => {
      const list = [...document.querySelectorAll("main img")].filter((i) => i.getBoundingClientRect().width > 0);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && list.some((i) => !i.complete)) await new Promise((r) => setTimeout(r, 100));
      return list.map((i) => ({ src: i.getAttribute("src"), ok: i.complete && i.naturalWidth > 0, density: i.naturalWidth / i.getBoundingClientRect().width }));
    });
    check(`${width} · product images present`, imgs.length >= 12, imgs.length);
    check(`${width} · every visible image loaded`, imgs.every((i) => i.ok), imgs.filter((i) => !i.ok).map((i) => i.src).join(","));
    const soft = imgs.filter((i) => i.density < 1.5).map((i) => `${i.src.split("/").pop()}@${i.density.toFixed(2)}`);
    check(`${width} · product images ≥1.5× density`, soft.length === 0, soft.join(" | "));

    /* copy hygiene */
    // textContent, not innerText: FAQ answers live in closed <details> and still
    // have to pass the copy gate.
    const text = await page.evaluate(() => document.querySelector("main").textContent);
    const emoji = [...new Set(text.match(/\p{Extended_Pictographic}/gu) || [])];
    check(`${width} · no emoji in page copy`, emoji.length === 0, emoji.join(" "));
    const found = FORBIDDEN_CLAIMS.filter((c) => (/^[A-Za-z0-9/]+$/.test(c) ? new RegExp(`\\b${c}\\b`).test(text) : text.includes(c)));
    check(`${width} · no forbidden claim`, found.length === 0, found.join(", "));
    const count = (needle) => text.split(needle).length - 1;
    check(`${width} · "CardCom" exactly once (FAQ qualification)`, count("CardCom") === 1, count("CardCom"));
    // twice by design: the hero's trust line and the invoices section's full proof
    check(`${width} · "270901" exactly twice`, count("270901") === 2, count("270901"));
    check(
      `${width} · the locked registration wording`,
      text.includes("Dubiz היא תוכנה רשומה ברשות המסים — תעודת רישום מס׳ 270901") &&
        text.includes("תוכנה רשומה ברשות המסים · תעודת רישום 270901"),
      "hero line + invoices line"
    );
    // the positioning's promise, and the product-truth qualification next to it
    check(`${width} · the attention promise is on the page`, text.includes("מה דורש") && text.includes("אותך היום"));
    check(
      `${width} · obligations are named as a separate surface`,
      text.includes("התשלומים הקבועים שרשמת מופיעים במזכירה, במסך נפרד.")
    );
    check(`${width} · the card payment is qualified`, text.includes("קישור לתשלום בכרטיס"));

    /* indexability — this is the PUBLIC homepage now, not a noindex candidate */
    const seo = await page.evaluate(() => ({
      robots: document.querySelector('meta[name="robots"]')?.getAttribute("content") || "",
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "",
      title: document.title,
      desc: document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
      h1: [...document.querySelectorAll("main h1")].map((h) => h.textContent.trim()),
    }));
    check(`${width} · the page is indexable (no noindex)`, !/noindex/i.test(seo.robots), seo.robots || "(no robots meta)");
    check(`${width} · one canonical, the apex root`, seo.canonical === "https://promaxgroup.co.il/", seo.canonical);
    check(`${width} · title and description are public`, seo.title.includes("Dubiz") && seo.desc.length > 60, `${seo.title} | ${seo.desc.length} chars`);
    check(`${width} · exactly one h1`, seo.h1.length === 1, seo.h1.join(" | "));
    const heavy = await page.evaluate(() =>
      [...document.querySelectorAll("main *")]
        .filter((e) => e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
        .filter((e) => parseInt(getComputedStyle(e).fontWeight, 10) > 600)
        .map((e) => e.textContent.trim().slice(0, 20))
        .slice(0, 5)
    );
    check(`${width} · no synthetic font weight (>600)`, heavy.length === 0, heavy.join(" | "));

    /* tap targets */
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("main a, main button, main summary, header a, header button")]
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0 && Math.min(r.width, r.height) < 44)
        .map(({ e, r }) => `${e.tagName.toLowerCase()}:${Math.round(r.width)}x${Math.round(r.height)}:${e.textContent.trim().slice(0, 16)}`)
        .slice(0, 6)
    );
    check(`${width} · tap targets ≥44px`, small.length === 0, small.join(" | "));

    await page.screenshot({ path: path.join(OUT, `v3-${width}.png`), fullPage: true });
    await ctx.close();
  }

  /* keyboard: skip link + FAQ */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "he-IL" });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });
    await page.keyboard.press("Tab");
    check("a11y · first Tab reaches the skip link", (await page.evaluate(() => document.activeElement?.getAttribute("href"))) === "#main-content");
    await page.keyboard.press("Enter");
    check("a11y · skip link moves focus to #main-content", (await page.evaluate(() => document.activeElement?.id)) === "main-content");
    const summaries = await page.locator("main details > summary").count();
    check("faq · seven questions", summaries === 7, summaries);
    const first = page.locator("main details > summary").first();
    await first.focus();
    await page.keyboard.press("Enter");
    const opened = await page.evaluate(() => document.querySelector("main details")?.open);
    await page.keyboard.press("Enter");
    const closed = await page.evaluate(() => !document.querySelector("main details")?.open);
    check("faq · Enter opens and closes an answer", opened && closed, `${opened}/${closed}`);
    await ctx.close();
  }

  /* mobile drawer */
  {
    const ctx = await browser.newContext({ viewport: { width: MOBILE, height: 800 }, locale: "he-IL" });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });
    const toggle = page.locator('header button[aria-controls="corporate-mobile-nav"]');
    check("drawer · toggle exists", (await toggle.count()) === 1);
    await toggle.click();
    check("drawer · modal dialog opens", (await page.locator('#corporate-mobile-nav[role="dialog"][aria-modal="true"]').count()) === 1);
    check("drawer · focus moves inside", await page.evaluate(() => Boolean(document.getElementById("corporate-mobile-nav")?.contains(document.activeElement))));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    check("drawer · Escape closes it", (await page.locator("#corporate-mobile-nav").count()) === 0);
    check("drawer · focus returns to the toggle", await page.evaluate(() => document.activeElement?.getAttribute("aria-controls") === "corporate-mobile-nav"));
    await ctx.close();
  }

  /* reduced motion */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });
    const longest = await page.evaluate(() => {
      let max = 0;
      for (const el of document.querySelectorAll("main *, header *")) {
        for (const d of getComputedStyle(el).transitionDuration.split(",")) {
          const v = parseFloat(d) * (d.includes("ms") ? 1 : 1000);
          if (!Number.isNaN(v)) max = Math.max(max, v);
        }
      }
      return max;
    });
    check("reduced motion · transitions neutralised", longest < 10, `${longest}ms`);
    await ctx.close();
  }

  check("console · no page errors", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
  await browser.close();
  await writeFile(path.join(OUT, "homepage-v3-evidence.json"), JSON.stringify({ base: BASE, route: ROUTE, expectSignup: EXPECT_SIGNUP, results }, null, 2), "utf8");

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error(`HOMEPAGE v3 QA FAILED (signup=${EXPECT_SIGNUP})`);
    process.exit(1);
  }
  console.log(`HOMEPAGE v3 QA PASSED (signup=${EXPECT_SIGNUP})`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
