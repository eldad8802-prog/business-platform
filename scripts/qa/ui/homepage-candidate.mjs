/**
 * HOMEPAGE CANDIDATE — automated QA gate.
 *
 * The public homepage had no automated coverage of any kind. This is that gate,
 * and it is written to fail on the specific defects this redesign exists to fix,
 * not on a generic smoke test:
 *
 *   - a CTA that leads to the closed-registration wall
 *   - more than one primary action competing in a viewport
 *   - horizontal overflow (`overflow-x: hidden` on <body> HIDES overflow, it does
 *     not prevent it, so every element is measured, not just the document)
 *   - product imagery that failed to load, i.e. "proof" that proves nothing
 *   - decorative emoji or synthetic font weights creeping back in
 *   - a forbidden Product-Truth claim appearing in the rendered copy
 *   - the accessibility work regressing: skip link, drawer Escape, focus return,
 *     reduced motion, keyboard-reachable product proof, 44px targets
 *
 * Usage — run it ONCE PER SIGNUP STATE, because the CTA contract differs:
 *
 *   PUBLIC_SIGNUP_ENABLED=false next dev -p 3123
 *   AUDIT_BASE_URL=http://localhost:3123 EXPECT_SIGNUP=off \
 *     node scripts/qa/ui/homepage-candidate.mjs
 *
 *   PUBLIC_SIGNUP_ENABLED=true  next dev -p 3124
 *   AUDIT_BASE_URL=http://localhost:3124 EXPECT_SIGNUP=on \
 *     node scripts/qa/ui/homepage-candidate.mjs
 *
 * Optional: AUDIT_ROUTE (default /home-candidate), AUDIT_OUT_DIR.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3123";
const ROUTE = process.env.AUDIT_ROUTE || "/home-candidate";
const EXPECT_SIGNUP = (process.env.EXPECT_SIGNUP || "off").toLowerCase();
const OUT =
  process.env.AUDIT_OUT_DIR ||
  path.join(process.cwd(), `.homepage-qa-${EXPECT_SIGNUP}`);

/** The five widths in the brief. 360 is the primary target. */
const WIDTHS = [360, 390, 768, 1024, 1440];

/** Below the `sm` breakpoint, where the drawer exists. */
const MOBILE = 390;

/**
 * pre-copy-gate-v1 §13 — claims verified ABSENT from the approved copy. If one
 * of these ever renders, someone introduced a claim straight into the code.
 * Matched against the page's visible text.
 */
const FORBIDDEN_CLAIMS = [
  "בדיוק בזמן",
  "התראות חכמות",
  "מסביב לשעון",
  "24/7",
  "לפני שנגמר",
  "מסנכרן",
  "מסנכרנת",
  "סנכרון",
  "שולחת לבד",
  "רודפת",
  "מנהלת צוות",
  "מחליף רואה חשבון",
  "מחליפה רואה חשבון",
  "מערכת הפעלה",
  "פלטפורמה",
  "בחינם",
  "נסו חינם",
  "ללא התחייבות",
  "תקופת ניסיון",
  "AI POWERED",
  "מופעל על ידי AI",
];

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log(`${cond ? "OK  " : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ------------------------------------------------------------------ page -- */

/** Every element whose content is wider than its own box. */
async function overflowOffenders(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      // 1px of tolerance: sub-pixel layout rounding is not an overflow.
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        const style = getComputedStyle(el);
        // A deliberate scroll container is not a defect.
        if (style.overflowX === "auto" || style.overflowX === "scroll") continue;
        // The visually-hidden (sr-only) pattern — a 1×1 clipped box, used by the
        // SkipLink until it is focused — clips its content ON PURPOSE. Only that
        // exact shape is exempt; any other clipped box is still reported.
        if (el.clientWidth <= 1 && el.clientHeight <= 1 && style.overflow === "hidden") continue;
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 80),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        });
      }
    }
    return out.slice(0, 10);
  });
}

async function run() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const consoleErrors = [];
  const snapshots = [];

  /* ---------------------------------------------- per-width structural -- */
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      deviceScaleFactor: 1,
      locale: "he-IL",
    });
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(`${width}: ${m.text()}`);
    });

    const res = await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });
    check(`${width} · route renders`, res && res.status() === 200, res ? res.status() : "no response");
    check(`${width} · not 5xx`, res && res.status() < 500, res ? res.status() : "");

    // RTL must survive every breakpoint.
    const dir = await page.evaluate(() => document.documentElement.dir);
    check(`${width} · document is RTL`, dir === "rtl", dir);

    /* --- overflow: the document AND every element --- */
    const docOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    check(
      `${width} · no document overflow`,
      docOverflow.scrollWidth <= docOverflow.clientWidth + 1,
      `${docOverflow.scrollWidth} vs ${docOverflow.clientWidth}`
    );

    const offenders = await overflowOffenders(page);
    check(
      `${width} · no element overflow`,
      offenders.length === 0,
      offenders.map((o) => `${o.tag}.${o.cls} ${o.scrollWidth}>${o.clientWidth}`).join(" | ")
    );

    /* --- CTA hierarchy: exactly two primaries, page-wide --- */
    const primaries = await page.evaluate(() =>
      [...document.querySelectorAll(".dz-btn-primary")].map((el) => ({
        text: el.textContent.trim(),
        href: el.getAttribute("href"),
      }))
    );
    check(
      `${width} · exactly 2 primary CTAs`,
      primaries.length === 2,
      `${primaries.length}: ${primaries.map((p) => p.text).join(" / ")}`
    );

    /* --- the header login must NOT be a filled primary --- */
    const headerPrimary = await page.evaluate(
      () => document.querySelectorAll("header .dz-btn-primary").length
    );
    check(`${width} · header login is not a primary`, headerPrimary === 0, headerPrimary);

    /* --- signup contract --- */
    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"))
    );
    const registerLinks = hrefs.filter((h) => h && h.startsWith("/register"));
    if (EXPECT_SIGNUP === "off") {
      check(
        `${width} · NO link to /register while signup is closed`,
        registerLinks.length === 0,
        registerLinks.join(", ")
      );
      check(
        `${width} · primary CTAs point at /login`,
        primaries.length > 0 && primaries.every((p) => p.href === "/login"),
        primaries.map((p) => p.href).join(", ")
      );
    } else {
      check(
        `${width} · primary CTAs point at /register`,
        primaries.length > 0 && primaries.every((p) => p.href === "/register"),
        primaries.map((p) => p.href).join(", ")
      );
    }

    /* --- imagery actually loaded: "proof" that did not load proves nothing ---
     * Lazy images only load once they approach the viewport, so walk the page
     * first — otherwise a not-yet-requested image is indistinguishable from a
     * broken one. Images inside an inactive tab panel (`hidden`) are never
     * requested; every panel is proven separately in the keyboard block below. */
    await page.evaluate(async () => {
      const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
    });
    const brokenImages = await page.evaluate(async () => {
      const visible = [...document.querySelectorAll("img")].filter((img) => !img.closest("[hidden]"));
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && visible.some((img) => !img.complete)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return visible
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => img.getAttribute("src"));
    });
    check(`${width} · no broken images`, brokenImages.length === 0, brokenImages.join(", "));

    /* --- before→after must stay compact on phones (V2.1 was ~1,316px at 390) --- */
    if (width <= MOBILE) {
      const baHeight = await page.evaluate(() =>
        Math.round(document.getElementById("s-before-after")?.closest("section")?.getBoundingClientRect().height ?? -1)
      );
      check(`${width} · before→after section ≤ 1100px`, baHeight > 0 && baHeight <= 1100, `${baHeight}px`);
    }

    /* --- no decorative emoji in the marketing body --- */
    const emoji = await page.evaluate(() => {
      const text = document.querySelector("main")?.innerText || "";
      const re = /\p{Extended_Pictographic}/gu;
      return [...new Set(text.match(re) || [])];
    });
    check(`${width} · no emoji in marketing body`, emoji.length === 0, emoji.join(" "));

    /* --- weight ceiling 600: Heebo ships 300-600, above that is synthetic --- */
    const heavy = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("main *")) {
        if (!el.textContent || !el.textContent.trim()) continue;
        const w = parseInt(getComputedStyle(el).fontWeight, 10);
        if (w > 600) {
          out.push(`${el.tagName.toLowerCase()}:${w}:${el.textContent.trim().slice(0, 24)}`);
        }
      }
      return out.slice(0, 8);
    });
    check(`${width} · no synthetic font weight (>600)`, heavy.length === 0, heavy.join(" | "));

    /* --- touch targets --- */
    const smallTargets = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("main a, main button, header a, header button")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue; // hidden panel
        if (Math.min(r.width, r.height) < 44) {
          out.push(`${el.tagName.toLowerCase()}:${Math.round(r.width)}x${Math.round(r.height)}:${el.textContent.trim().slice(0, 20)}`);
        }
      }
      return out.slice(0, 8);
    });
    check(`${width} · tap targets >= 44px`, smallTargets.length === 0, smallTargets.join(" | "));

    /* --- claim gate --- */
    const bodyText = await page.evaluate(() => document.body.innerText);
    const found = FORBIDDEN_CLAIMS.filter((c) => bodyText.includes(c));
    check(`${width} · no forbidden claim in rendered copy`, found.length === 0, found.join(", "));

    const shot = path.join(OUT, `candidate-${width}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    snapshots.push(shot);

    await ctx.close();
  }

  /* --------------------------------------------------- keyboard / a11y -- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "he-IL" });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });

    // Skip link must be the FIRST thing in the tab order, and must move focus.
    await page.keyboard.press("Tab");
    const firstFocus = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el?.tagName.toLowerCase(), href: el?.getAttribute?.("href"), text: el?.textContent?.trim() };
    });
    check(
      "a11y · first Tab reaches the skip link",
      firstFocus.href === "#main-content",
      JSON.stringify(firstFocus)
    );

    await page.keyboard.press("Enter");
    const afterSkip = await page.evaluate(() => document.activeElement?.id);
    check("a11y · skip link moves focus to #main-content", afterSkip === "main-content", afterSkip);

    // Product proof must be operable from the keyboard, with arrow keys.
    const tabCount = await page.evaluate(() => document.querySelectorAll('[role="tab"]').length);
    check("a11y · product proof exposes 4 tabs", tabCount === 4, tabCount);

    await page.evaluate(() => document.querySelector('[role="tab"]')?.focus());
    const before = await page.evaluate(() =>
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()
    );
    // RTL: ArrowLeft advances.
    await page.keyboard.press("ArrowLeft");
    const after = await page.evaluate(() =>
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()
    );
    check("a11y · ArrowLeft moves the selected proof tab (RTL)", before !== after, `${before} -> ${after}`);

    await page.keyboard.press("End");
    const atEnd = await page.evaluate(() =>
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()
    );
    check("a11y · End selects the last proof tab", Boolean(atEnd) && atEnd !== after, atEnd);

    // Desktop renders the tabs as a vertical list: Up/Down must work too.
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    const afterDown = await page.evaluate(() =>
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()
    );
    check("a11y · ArrowDown moves the selected proof tab", afterDown === after, `${before} -> ${afterDown}`);

    // EVERY area must show a loaded, readable-size image when selected — not
    // just whichever one happens to be active.
    for (let i = 0; i < tabCount; i++) {
      await page.locator('[role="tab"]').nth(i).click();
      const panelImage = await page.evaluate(async (idx) => {
        const panel = document.getElementById(`proof-panel-${idx}`);
        const img = panel?.querySelector("img");
        img?.scrollIntoView({ block: "center" });
        const deadline = Date.now() + 8000;
        while (img && !img.complete && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        return {
          visible: Boolean(panel && !panel.hidden),
          loaded: Boolean(img && img.complete && img.naturalWidth > 0),
          renderedWidth: Math.round(img?.getBoundingClientRect().width ?? 0),
          src: img?.getAttribute("src"),
        };
      }, i);
      check(
        `a11y · proof panel ${i + 1} image loaded and shown`,
        panelImage.visible && panelImage.loaded && panelImage.renderedWidth >= 300,
        JSON.stringify(panelImage)
      );
    }

    await ctx.close();
  }

  /* ------------------------------------------------------ mobile drawer -- */
  {
    const ctx = await browser.newContext({ viewport: { width: MOBILE, height: 800 }, locale: "he-IL" });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${ROUTE}`, { waitUntil: "networkidle" });

    const toggle = page.locator('header button[aria-controls="corporate-mobile-nav"]');
    check("drawer · toggle exists on mobile", (await toggle.count()) === 1);

    // It must be a real icon control, not a text glyph.
    const glyph = await toggle.evaluate((el) => el.textContent.trim());
    check("drawer · toggle is an icon, not a ☰ glyph", glyph === "", JSON.stringify(glyph));
    check("drawer · toggle has an accessible name", Boolean(await toggle.getAttribute("aria-label")));

    await toggle.click();
    check("drawer · opens", (await page.locator("#corporate-mobile-nav").count()) === 1);
    check(
      "drawer · aria-expanded is true when open",
      (await toggle.getAttribute("aria-expanded")) === "true"
    );
    check(
      "drawer · is a modal dialog",
      (await page.locator('#corporate-mobile-nav[role="dialog"][aria-modal="true"]').count()) === 1
    );

    const focusInside = await page.evaluate(() =>
      Boolean(document.getElementById("corporate-mobile-nav")?.contains(document.activeElement))
    );
    check("drawer · focus moves inside on open", focusInside);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    check("drawer · Escape closes it", (await page.locator("#corporate-mobile-nav").count()) === 0);

    const focusRestored = await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-controls") === "corporate-mobile-nav"
    );
    check("drawer · focus returns to the toggle", focusRestored);

    await ctx.close();
  }

  /* ------------------------------------------------------ reduced motion -- */
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
      locale: "he-IL",
    });
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
    check(
      "reduced motion · transitions are neutralised",
      longest < 10,
      `longest transition ${longest}ms`
    );

    await ctx.close();
  }

  /* ---------------------------------------------------------------- out -- */
  check("console · no page errors", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));

  await browser.close();

  await writeFile(
    path.join(OUT, "homepage-candidate-evidence.json"),
    JSON.stringify({ base: BASE, route: ROUTE, expectSignup: EXPECT_SIGNUP, results, snapshots, consoleErrors }, null, 2),
    "utf8"
  );

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`evidence: ${OUT}`);
  if (failed.length) {
    console.error(`HOMEPAGE CANDIDATE QA FAILED (signup=${EXPECT_SIGNUP})`);
    process.exit(1);
  }
  console.log(`HOMEPAGE CANDIDATE QA PASSED (signup=${EXPECT_SIGNUP})`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
