/**
 * One-off: hit-test the home shell at mobile viewport.
 * Run with: node scripts/pointer-hit-test.mjs
 * Requires: next start on http://127.0.0.1:3000
 */
import { chromium } from "playwright";

const BASE = process.env.POINTER_TEST_URL || "http://127.0.0.1:3000/";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  const report = await page.evaluate(() => {
    function describeEl(el) {
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        id: el.id || null,
        className:
          typeof el.className === "string" ? el.className.slice(0, 120) : null,
        role: el.getAttribute("role") || null,
        ariaLabel: el.getAttribute("aria-label") || null,
        dataComponent: el.getAttribute("data-component") || null,
        dataShell: el.getAttribute("data-shell-root") || null,
        href: el.tagName === "A" ? el.getAttribute("href") : null,
        text: (el.innerText || "").trim().slice(0, 80) || null,
        position: cs.position,
        top: cs.top,
        right: cs.right,
        bottom: cs.bottom,
        left: cs.left,
        inset: cs.inset,
        zIndex: cs.zIndex,
        pointerEvents: cs.pointerEvents,
        opacity: cs.opacity,
        transform: String(cs.transform || "").slice(0, 100),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      };
    }

    function stack(x, y) {
      const els = document.elementsFromPoint(x, y);
      return els.slice(0, 12).map((el) => describeEl(el));
    }

    function findButtonByText(sub) {
      const buttons = [...document.querySelectorAll("button,a")];
      const el = buttons.find((b) => (b.innerText || "").includes(sub));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return {
        target: describeEl(el),
        probe: [cx, cy],
        topAtProbe: describeEl(document.elementFromPoint(cx, cy)),
        stackAtProbe: stack(cx, cy),
      };
    }

    const dialogs = [...document.querySelectorAll('[role="dialog"]')].map(
      describeEl
    );

    const w = window.innerWidth;
    const h = window.innerHeight;
    const pts = {
      centerAboveBottomBar: [w / 2, h - 120],
      nearBottomCenter: [w / 2, h - 40],
      topThird: [w / 2, h * 0.25],
    };

    const bodyOverflow = document.body.style.overflow || null;

    const fab = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "פעולות מהירות"
    );
    let fabHit = null;
    if (fab) {
      const r = fab.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      fabHit = {
        target: describeEl(fab),
        probe: [cx, cy],
        topAtProbe: describeEl(document.elementFromPoint(cx, cy)),
        stackAtProbe: stack(cx, cy),
      };
    }

    let homeTab = null;
    const nav = document.querySelector(
      "nav[data-component='shell-bottom-bar']"
    );
    if (nav) {
      const link = nav.querySelector('a[href="/"]');
      if (link) {
        const r = link.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        homeTab = {
          target: describeEl(link),
          probe: [cx, cy],
          topAtProbe: describeEl(document.elementFromPoint(cx, cy)),
          stackAtProbe: stack(cx, cy),
        };
      }
    }

    return {
      url: location.href,
      bodyOverflowAttr: bodyOverflow,
      dialogElements: dialogs,
      points: Object.fromEntries(
        Object.entries(pts).map(([k, [x, y]]) => [
          k,
          {
            xy: [x, y],
            top: describeEl(document.elementFromPoint(x, y)),
            stack: stack(x, y),
          },
        ])
      ),
      loginFallback: findButtonByText("מעבר להתחברות"),
      fabPlus: fabHit,
      homeTab,
    };
  });

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
