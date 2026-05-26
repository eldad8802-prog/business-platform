/**
 * Local DOM probe: mobile viewport, elementFromPoint on /documents.
 * Requires: npm run dev (or server on BASE_URL).
 *
 * Usage: node scripts/shell-hit-probe.mjs
 */
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";

async function probe(path, label) {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
  });

  try {
    const url = `${BASE_URL}${path}`;
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    const status = res?.status() ?? 0;
    const title = await page.title();

    const shellAttrs = await page.evaluate(() => {
      const el = document.querySelector("[data-shell-root]");
      if (!el) return null;
      return {
        bottomBar: el.getAttribute("data-shell-bottom-bar"),
        debug: document.querySelector("[data-shell-debug]") ? "yes" : "no",
      };
    });
    const debugVisible = await page
      .locator("[data-shell-debug=active]")
      .count()
      .then((n) => n > 0);
    const debugText = await page
      .locator("[data-shell-debug=active]")
      .first()
      .textContent()
      .catch(() => null);

    const navCount = await page.locator("nav[aria-label='ניווט תחתון']").count();

    const hit = await page.evaluate(() => {
      const x = Math.floor(window.innerWidth / 2);
      const y = Math.floor(window.innerHeight * 0.45);
      const yLow = Math.floor(window.innerHeight - 40);
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      let cur = el;
      const chain = [];
      for (let i = 0; i < 8 && cur; i++) {
        chain.push({
          tag: cur.tagName,
          id: cur.id || "",
          className: (cur.className && String(cur.className).slice(0, 80)) || "",
          role: cur.getAttribute("role") || "",
          ariaLabel: cur.getAttribute("aria-label") || "",
        });
        cur = cur.parentElement;
      }
      const elLow = document.elementFromPoint(x, yLow);
      const csLow = elLow ? window.getComputedStyle(elLow) : null;
      const chainLow = [];
      let curL = elLow;
      for (let i = 0; i < 6 && curL; i++) {
        chainLow.push({
          tag: curL.tagName,
          ariaLabel: curL.getAttribute("aria-label") || "",
        });
        curL = curL.parentElement;
      }

      return {
        x,
        y,
        yLow,
        leaf: {
          tag: el.tagName,
          id: el.id || "",
          className: (el.className && String(el.className).slice(0, 120)) || "",
        },
        computed: {
          position: cs.position,
          zIndex: cs.zIndex,
          pointerEvents: cs.pointerEvents,
          height: cs.height,
          inset: `${cs.top}/${cs.right}/${cs.bottom}/${cs.left}`,
        },
        chain,
        lowPoint: elLow
          ? {
              tag: elLow.tagName,
              ariaLabel: elLow.getAttribute("aria-label") || "",
              position: csLow?.position,
              zIndex: csLow?.zIndex,
              pointerEvents: csLow?.pointerEvents,
              chain: chainLow,
            }
          : null,
      };
    });

    let clickNavOk = null;
    if (path === "/documents") {
      const first = page.locator("main a[href^='/documents/']").first();
      if ((await first.count()) > 0) {
        await first.click({ timeout: 5000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 400));
        clickNavOk = page.url();
      }
    }

    console.log(
      JSON.stringify(
        {
          label,
          url,
          httpStatus: status,
          title,
          debugBannerPresent: debugVisible,
          debugBannerText: (debugText || "").trim(),
          bottomNavInDom: navCount > 0,
          shellRootAttrs: shellAttrs,
          elementFromPoint_midScreen: hit,
          documentsFirstCardClickResultUrl: clickNavOk,
        },
        null,
        2
      )
    );
  } finally {
    await browser.close();
  }
}

await probe("/", "home");
await probe("/inbox", "inbox");
await probe("/documents", "documents");
