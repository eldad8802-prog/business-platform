/**
 * Revenue forensic audit — READ-ONLY.
 *
 * Measures every Revenue surface across the viewport matrix, and records for
 * each one whether it is rendered inside a phone frame, which mode that frame
 * is in, and whether the surface is reachable without authentication (the
 * management / consumer boundary).
 *
 * Mutates nothing: no coupon is issued, redeemed, enabled or disabled.
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "http://localhost:3124";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".revenue-audit");
const TOKEN_FILE = process.env.AUDIT_TOKEN_FILE;

const VIEWPORTS = [320, 390, 768, 1024, 1280, 1440, 1920];

/** `auth: false` surfaces are re-checked in a clean context with no token. */
const ROUTES = [
  ["hub-mine", "/revenue", true],
  ["hub-browse", "/revenue?view=browse", true],
  ["hub-create", "/revenue?view=create", true],
  ["redeem", "/revenue/redeem", true],
  ["coupon-design", "/coupon-design", true],
];

async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const main = document.querySelector("main");
    // The phone frame is recognised by its geometry contract rather than a
    // class: a column capped at 390 (device mock) or 480 (screen mode).
    const frames = Array.from(document.querySelectorAll("div"))
      .map((el) => ({ el, cs: getComputedStyle(el) }))
      .filter((o) => {
        const mw = o.cs.maxWidth;
        return mw === "390px" || mw === "480px";
      })
      .map((o) => ({
        cap: o.cs.maxWidth,
        radius: o.cs.borderRadius,
        shadow: o.cs.boxShadow !== "none",
        box: rect(o.el),
        // A frame the owner must work inside will contain interactive controls.
        controls: o.el.querySelectorAll("button, a[href], input, select, textarea").length,
      }));
    const navs = Array.from(document.querySelectorAll("nav"))
      .filter((n) => getComputedStyle(n).display !== "none" && n.getBoundingClientRect().width > 40)
      .map((n) => ({ label: n.getAttribute("aria-label"), w: Math.round(n.getBoundingClientRect().width) }));
    const taps = Array.from(document.querySelectorAll("button, a[href], input, select, textarea"))
      .map((el) => ({ t: (el.textContent || "").trim().slice(0, 22), r: el.getBoundingClientRect() }))
      .filter((o) => o.r.width > 0 && o.r.height > 0);
    return {
      iw: window.innerWidth,
      sw: Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0),
      intent: (document.querySelector("[data-page-intent]") || { getAttribute: () => null })
        .getAttribute("data-page-intent"),
      mainW: rect(main) ? rect(main).w : null,
      frames,
      navs,
      controls: taps.length,
      minTap: taps.length ? Math.round(Math.min.apply(null, taps.map((o) => o.r.height))) : null,
      under24: taps.filter((o) => o.r.height < 24 || o.r.width < 24).map((o) => o.t + "=" + Math.round(o.r.height)),
      dir: de.getAttribute("dir"),
      title: (document.querySelector("h1, h2") || { textContent: "" }).textContent.trim().slice(0, 40),
    };
  });
}

async function main() {
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const token = JSON.parse(await readFile(TOKEN_FILE, "utf8")).token;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("token", t), token);

  // Discover a real coupon id without creating one.
  let couponId = null;
  try {
    const mine = await page.evaluate(async () => {
      const r = await fetch("/api/revenue/coupons/mine", {
        headers: { authorization: "Bearer " + localStorage.getItem("token") },
      });
      if (!r.ok) return { status: r.status, items: [] };
      const j = await r.json();
      return { status: r.status, items: j.coupons || j.items || j };
    });
    const arr = Array.isArray(mine.items) ? mine.items : [];
    couponId = arr.length ? arr[0].publicId || arr[0].id : null;
    console.log("coupons/mine: status=" + mine.status + " count=" + arr.length + " first=" + couponId);
  } catch (e) {
    console.log("coupons/mine probe failed: " + e.message);
  }
  const routes = ROUTES.slice();
  if (couponId) routes.push(["coupon-detail", "/revenue/coupons/" + couponId, false]);

  const rows = [];
  for (const [name, route] of routes) {
    for (const w of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
      await page.goto(BASE + route, { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(2200);
      const m = await measure(page);
      rows.push(Object.assign({ name, w }, m));
      await page.screenshot({ path: path.join(OUT, "shots", name + "__" + w + ".png") });
      const f = m.frames.map((x) => x.cap + (x.shadow ? "/mock" : "/screen") + ":" + x.controls + "ctl").join(" ");
      console.log(
        name + "@" + w + ": main=" + m.mainW + " frames=[" + f + "] navs=" + m.navs.length +
        " controls=" + m.controls + " minTap=" + m.minTap + " overflow=" + (m.sw > m.iw + 1)
      );
    }
  }

  // Public reachability: same routes in a context with no token at all.
  const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const anonPage = await anon.newPage();
  const publicProbe = [];
  const probeRoutes = ["/revenue", "/revenue/redeem", "/coupon-design"]
    .concat(couponId ? ["/revenue/coupons/" + couponId] : []);
  for (const r of probeRoutes) {
    const resp = await anonPage.goto(BASE + r, { waitUntil: "load", timeout: 60000 }).catch(() => null);
    await anonPage.waitForTimeout(1800);
    publicProbe.push({
      route: r,
      status: resp ? resp.status() : null,
      landedOn: anonPage.url().replace(BASE, ""),
      // A surface that renders content to an anonymous visitor is consumer-facing.
      textLen: (await anonPage.evaluate(() => (document.body.innerText || "").trim().length)),
    });
  }
  console.log("\n=== ANONYMOUS REACHABILITY ===");
  for (const p of publicProbe) {
    console.log("  " + p.route + " -> " + p.status + " landed=" + p.landedOn + " text=" + p.textLen);
  }

  await writeFile(path.join(OUT, "matrix.json"), JSON.stringify({ rows, publicProbe, couponId }, null, 1));

  console.log("\n=== OBSERVATIONS ===");
  for (const [name] of routes) {
    const ws = [...new Set(rows.filter((r) => r.name === name).map((r) => r.mainW))];
    const caps = [...new Set(rows.filter((r) => r.name === name).flatMap((r) => r.frames.map((f) => f.cap)))];
    const ctl = Math.max(...rows.filter((r) => r.name === name).map((r) => r.controls));
    console.log("  " + name + ": main widths " + ws.join("/") + " | frame caps " + (caps.join("/") || "none") + " | max controls " + ctl);
  }
  const of = rows.filter((r) => r.sw > r.iw + 1);
  console.log("horizontal overflow: " + (of.length ? of.map((r) => r.name + "@" + r.w).join(", ") : "none"));
  const small = rows.filter((r) => r.under24.length);
  console.log("A-7 gating failures: " + (small.length ? small.map((r) => r.name + "@" + r.w + ":" + r.under24.join("/")).join(" | ") : "none"));
  const navd = [...new Set(rows.map((r) => r.name + "@" + r.w + "=" + r.navs.length))].filter((s) => !s.endsWith("=0"));
  console.log("surfaces with shell nav: " + (navd.length ? navd.join(", ") : "NONE — every Revenue surface hides the shell"));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
