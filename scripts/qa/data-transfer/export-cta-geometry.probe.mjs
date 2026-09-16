/**
 * Export CTA geometry probe — measurement only, no assertions.
 *
 * Prints, per viewport, where the action bar is, where the shell's own bottom
 * navigation is, whether they overlap, and which element actually receives a
 * click at the centre of the button. "Visible" and "hittable" are different
 * questions and a bar can pass the first while failing the second.
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.EXPORT_E2E_BASE;
if (!BASE) throw new Error("EXPORT_E2E_BASE is required and is never defaulted");

function credentials() {
  const raw = fs.readFileSync(
    path.join(process.env.USERPROFILE ?? "", ".dubiz-local-secrets", "google-play-reviewer.txt"),
    "utf8"
  );
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { email: out.email, password: out.password };
}

const VIEWPORTS = [
  { label: "360x640", w: 360, h: 640 },
  { label: "390x664", w: 390, h: 664 },
  { label: "768x1024", w: 768, h: 1024 },
  { label: "1024x768", w: 1024, h: 768 },
  { label: "1366x600", w: 1366, h: 600 },
  { label: "1440x740", w: 1440, h: 740 },
  { label: "1440x900", w: 1440, h: 900 },
];

async function main() {
  const { email, password } = credentials();
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const auth = await res.json();
  const browser = await chromium.launch();

  for (const v of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.evaluate((a) => window.localStorage.setItem("token", a.token), auth);
    await page.goto(`${BASE}/settings/import-export/export`, { waitUntil: "networkidle" });
    await page.locator('input[type="checkbox"]').first().check();
    await page.locator('input[type="checkbox"]').nth(1).check();

    const geo = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /הורד קובץ|מכין את הקובץ/.test(b.textContent ?? "")
      );
      if (!btn) return { error: "no button" };
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // Anything fixed to the bottom that is not our own bar.
      const bar = document.querySelector("[data-export-action-bar]");
      const others = [...document.querySelectorAll("body *")]
        .filter((el) => {
          if (el === bar || (bar && bar.contains(el))) return false;
          const cs = getComputedStyle(el);
          if (cs.position !== "fixed") return false;
          const b = el.getBoundingClientRect();
          return b.height > 0 && b.width > 0 && b.bottom >= window.innerHeight - 4;
        })
        .map((el) => {
          const b = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            cls: (el.className || "").toString().slice(0, 40),
            top: Math.round(b.top),
            h: Math.round(b.height),
            z: getComputedStyle(el).zIndex,
          };
        });
      return {
        btnTop: Math.round(r.top),
        btnBottom: Math.round(r.bottom),
        vh: window.innerHeight,
        onScreen: r.top >= 0 && r.bottom <= window.innerHeight,
        hitTag: hit ? hit.tagName.toLowerCase() : null,
        hitIsButton: hit === btn || (hit ? btn.contains(hit) : false),
        docHeight: Math.round(document.documentElement.scrollHeight),
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
        bottomFixed: others,
      };
    });

    console.log(
      `${v.label.padEnd(9)} vh=${String(geo.vh).padStart(4)} btn=${String(geo.btnTop).padStart(4)}..${String(
        geo.btnBottom
      ).padStart(4)} onScreen=${geo.onScreen ? "YES" : "NO "} hitsButton=${
        geo.hitIsButton ? "YES" : "NO (" + geo.hitTag + ")"
      } overflowX=${geo.overflowX} doc=${geo.docHeight}`
    );
    for (const o of geo.bottomFixed ?? []) {
      console.log(`            other bottom-fixed: ${o.tag} z=${o.z} top=${o.top} h=${o.h} ${o.cls}`);
    }
    await ctx.close();
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
