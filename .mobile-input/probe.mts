/**
 * iPhone input zoom — measurement of the cause and of the fix, on the real app in a browser (PG17 lab, synthetic data).
 *
 * The cause: iOS WebKit zooms the page when a focused text field's computed font-size is below 16px. Neither
 * Playwright's WebKit nor Chromium reproduces that zoom (it is iOS UIKit behaviour), so this probe measures what
 * decides it — the computed font-size of every text-entry field — and the layout around it:
 *
 *   served   the page as served. In Chromium (= Android) the iOS rule must be inactive (CSS.supports false), so
 *            these are also the Android numbers: the fields below 16px are the zoom triggers on an iPhone.
 *   iosRule  the same page with the rule body of app/globals.css's @supports (-webkit-touch-callout: none) block
 *            applied unconditionally — what an iPhone gets. Every text-entry field must be >= 16px, none may shrink,
 *            and the page must not overflow sideways.
 * For each screen (customers + new-customer modal, leads + new-lead modal, supplier edit, business details, the
 * invoices identity gate) × engine (Chromium Pixel-like, WebKit iPhone-like) × language (he, en) it records the
 * fields, the page width vs the viewport, the visual viewport before/after focusing a field, and whether the
 * form's last action button can be scrolled into view. Writes $OUT/report.md, $OUT/probe.json and screenshots.
 *
 * env: E2E_BASE, SEED_OUT, OUT.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices, webkit, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:3740";
const OUT = process.env.OUT ?? "/tmp/mobile-input";
mkdirSync(OUT, { recursive: true });
type Seed = { M: { token: string; customerId: number; supplierId: number; leadId: number }; N: { token: string } };
const seed = JSON.parse(readFileSync(process.env.SEED_OUT!, "utf8")) as Seed;

// the iOS rule body, taken from the stylesheet itself (not retyped): the inside of the @supports block
const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const block = css.match(/@supports \(-webkit-touch-callout: none\) \{([\s\S]*?)\n\}/);
if (!block) throw new Error("the @supports (-webkit-touch-callout: none) block is missing from app/globals.css");
const IOS_RULE = block[1];

type Lang = "he" | "en";
const L = (lang: Lang, he: string, en: string) => (lang === "he" ? he : en);
type Screen = { key: string; token: () => string; path: () => string; open?: (p: Page, lang: Lang) => Promise<void> };
const SCREENS: Screen[] = [
  { key: "customers-list", token: () => seed.M.token, path: () => "/customers" },
  { key: "customers-new", token: () => seed.M.token, path: () => "/customers", open: async (p, lang) => { await p.getByRole("button", { name: L(lang, "+ לקוח חדש", "+ New customer") }).first().click(); await p.getByRole("dialog").first().waitFor(); } },
  { key: "leads-new", token: () => seed.M.token, path: () => "/leads", open: async (p, lang) => { await p.getByRole("button", { name: L(lang, "+ ליד חדש", "+ New lead") }).first().click(); await p.getByRole("dialog").first().waitFor(); } },
  { key: "supplier-edit", token: () => seed.M.token, path: () => `/suppliers/${seed.M.supplierId}`, open: async (p, lang) => { await p.locator(`button[aria-label="${L(lang, "עריכה", "Edit")}"], button:has-text("${L(lang, "עריכה", "Edit")}")`).first().click(); await p.getByRole("dialog").first().waitFor(); } },
  { key: "business-details", token: () => seed.M.token, path: () => "/business" },
  { key: "billing-identity-gate", token: () => seed.N.token, path: () => "/billing", open: async (p, lang) => { await p.waitForTimeout(1500); await p.getByRole("button", { name: L(lang, "+ צור חשבונית", "+ Create invoice") }).first().click(); await p.locator('[aria-labelledby="identity-gate-title"]').waitFor(); } },
];

type Field = { tag: string; type: string; label: string; served: number; ios?: number };
type Row = { screen: string; engine: string; lang: Lang; mode: "served" | "iosRule"; supports: boolean; fields: Field[]; docWidth: number; viewport: number; overflowX: boolean; vvBefore: { scale: number; width: number }; vvAfter: { scale: number; width: number; offsetLeft: number }; docWidthAfterFocus: number; lastActionReachable: boolean | null; error?: string };
const rows: Row[] = [];

async function ctx(browser: Browser, engine: "chromium" | "webkit", token: string, lang: Lang): Promise<BrowserContext> {
  const d = engine === "chromium" ? devices["Pixel 5"] : devices["iPhone 13"];
  const c = await browser.newContext({ ...d, baseURL: BASE, locale: lang === "he" ? "he-IL" : "en-US", timezoneId: "Asia/Jerusalem" });
  await c.addCookies([{ name: "dz_locale", value: lang, url: BASE }]);
  await c.addInitScript((t) => { try { localStorage.setItem("token", t); } catch { /* opaque */ } }, token);
  // tsx (esbuild keepNames) wraps named functions inside page.evaluate callbacks in __name(...): give the page a no-op
  await c.addInitScript({ content: "window.__name = window.__name || function (f) { return f; };" });
  return c;
}

const TEXT_ENTRY = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]):not([type="hidden"]), select, textarea';

async function measure(page: Page): Promise<Omit<Row, "screen" | "engine" | "lang" | "mode" | "error">> {
  return page.evaluate(async (sel) => {
    const visible = (e: Element) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const scope = document.querySelector('[role="dialog"]') ?? document;
    const els = [...scope.querySelectorAll(sel)].filter(visible) as HTMLElement[];
    const label = (e: HTMLElement) => (e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.closest("label")?.textContent || e.getAttribute("name") || e.id || "").trim().replace(/\s+/g, " ").slice(0, 40);
    const fields = els.map((e) => ({ tag: e.tagName.toLowerCase(), type: (e as HTMLInputElement).type || "", label: label(e), served: parseFloat(getComputedStyle(e).fontSize) }));
    const vv = window.visualViewport!;
    const vvBefore = { scale: vv.scale, width: Math.round(vv.width) };
    const docWidth = document.documentElement.scrollWidth;
    const viewport = window.innerWidth;
    const first = els.find((e) => e.tagName !== "SELECT");
    if (first) { first.focus(); first.scrollIntoView({ block: "center" }); }
    await new Promise((r) => setTimeout(r, 600));
    const vvAfter = { scale: vv.scale, width: Math.round(vv.width), offsetLeft: Math.round(vv.offsetLeft) };
    const docWidthAfterFocus = document.documentElement.scrollWidth;
    // the form's last action button: can it be brought into the visible viewport?
    const buttons = [...scope.querySelectorAll("button")].filter(visible);
    let lastActionReachable: boolean | null = null;
    if (scope !== document && buttons.length) {
      const b = buttons[buttons.length - 1];
      b.scrollIntoView({ block: "end" });
      await new Promise((r) => setTimeout(r, 200));
      const r = b.getBoundingClientRect();
      lastActionReachable = r.bottom <= vv.height + vv.offsetTop + 1 && r.top >= 0 && r.left >= -1 && r.right <= window.innerWidth + 1;
    }
    (document.activeElement as HTMLElement | null)?.blur();
    return { supports: CSS.supports("-webkit-touch-callout", "none"), fields, docWidth, viewport, overflowX: docWidth > viewport + 1, vvBefore, vvAfter, docWidthAfterFocus, lastActionReachable };
  }, TEXT_ENTRY);
}

async function main() {
  const engines = { chromium: await chromium.launch(), webkit: await webkit.launch() };
  try {
    for (const [engine, browser] of Object.entries(engines) as ["chromium" | "webkit", Browser][]) {
      for (const lang of ["he", "en"] as const) {
        for (const s of SCREENS) {
          for (const mode of ["served", "iosRule"] as const) {
            const c = await ctx(browser, engine, s.token(), lang);
            const page = await c.newPage();
            const base = { screen: s.key, engine, lang, mode };
            try {
              await page.goto(s.path(), { timeout: 120_000 });
              await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
              if (mode === "iosRule") await page.addStyleTag({ content: IOS_RULE });
              if (s.open) await s.open(page, lang);
              await page.waitForTimeout(500);
              const m = await measure(page);
              rows.push({ ...base, ...m });
              if ((engine === "webkit" && mode === "iosRule") || (engine === "chromium" && mode === "served" && lang === "he")) {
                await page.screenshot({ path: join(OUT, `${s.key}-${engine}-${mode}-${lang}.png`), fullPage: false });
              }
            } catch (e) {
              rows.push({ ...base, supports: false, fields: [], docWidth: 0, viewport: 0, overflowX: false, vvBefore: { scale: 0, width: 0 }, vvAfter: { scale: 0, width: 0, offsetLeft: 0 }, docWidthAfterFocus: 0, lastActionReachable: null, error: e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : String(e) });
              await page.screenshot({ path: join(OUT, `FAILED-${s.key}-${engine}-${mode}-${lang}.png`) }).catch(() => undefined);
            }
            await c.close();
          }
        }
      }
    }
  } finally {
    await engines.chromium.close();
    await engines.webkit.close();
  }

  // pair served/iosRule per screen×engine×lang
  const problems: string[] = [];
  const key = (r: Row) => `${r.screen}|${r.engine}|${r.lang}`;
  const served = new Map(rows.filter((r) => r.mode === "served").map((r) => [key(r), r]));
  for (const r of rows) {
    if (r.error) { problems.push(`${key(r)} ${r.mode}: ${r.error}`); continue; }
    if (r.fields.length === 0) problems.push(`${key(r)} ${r.mode}: no text-entry field found`);
    if (r.engine === "chromium" && r.supports) problems.push(`${key(r)}: CSS.supports(-webkit-touch-callout) is true in Chromium — the iOS rule would reach Android`);
    if (r.mode === "iosRule") {
      const small = r.fields.filter((f) => f.served < 16);
      if (small.length) problems.push(`${key(r)} iosRule: ${small.length} field(s) still below 16px (${small.map((f) => `${f.label || f.tag} ${f.served}px`).join(", ")})`);
      if (r.overflowX || r.docWidthAfterFocus > r.viewport + 1) problems.push(`${key(r)} iosRule: horizontal overflow (${r.docWidth}/${r.docWidthAfterFocus} > ${r.viewport})`);
      const s = served.get(key(r));
      if (s && !s.error) r.fields.forEach((f, i) => { const before = s.fields[i]?.served; if (before !== undefined && before > 16 && f.served < before) problems.push(`${key(r)}: "${f.label}" shrinks ${before}px → ${f.served}px`); });
      if (r.lastActionReachable === false) problems.push(`${key(r)} iosRule: the form's last action button cannot be scrolled into view`);
    }
  }

  const lines: string[] = ["# iPhone input zoom — measurement", "", "| screen | engine | lang | text-entry fields | served: min px · below 16px | with the iOS rule: min px · below 16px | page width / viewport (iOS rule, after focus) | visual viewport scale after focus | last action reachable |", "|---|---|---|---|---|---|---|---|---|"];
  for (const r of rows.filter((x) => x.mode === "iosRule")) {
    const s = served.get(key(r));
    const min = (fs: Field[]) => (fs.length ? Math.min(...fs.map((f) => f.served)) : NaN);
    const below = (fs: Field[]) => fs.filter((f) => f.served < 16).length;
    lines.push(`| ${r.screen} | ${r.engine} | ${r.lang} | ${r.fields.length} | ${s ? `${min(s.fields)} · ${below(s.fields)}` : "—"} | ${min(r.fields)} · ${below(r.fields)} | ${r.docWidthAfterFocus}/${r.viewport} | ${r.vvAfter.scale} | ${r.lastActionReachable ?? "—"} |`);
  }
  const sv = rows.filter((r) => r.mode === "served" && !r.error);
  lines.push("", `CSS.supports('-webkit-touch-callout: none'): Chromium ${[...new Set(sv.filter((r) => r.engine === "chromium").map((r) => r.supports))].join("/")}, Playwright WebKit ${[...new Set(sv.filter((r) => r.engine === "webkit").map((r) => r.supports))].join("/")}.`);
  lines.push("", "Fields below 16px as served (the iPhone zoom triggers):", "");
  for (const r of sv.filter((x) => x.engine === "chromium" && x.lang === "he")) lines.push(`- ${r.screen}: ${r.fields.filter((f) => f.served < 16).map((f) => `${f.tag}${f.type && f.tag === "input" ? `[${f.type}]` : ""} "${f.label}" ${f.served}px`).join("; ") || "none"}`);
  lines.push("", problems.length ? `## Problems (${problems.length})\n\n${problems.map((p) => `- ${p}`).join("\n")}` : "All checks passed.");
  writeFileSync(join(OUT, "report.md"), lines.join("\n") + "\n");
  writeFileSync(join(OUT, "probe.json"), JSON.stringify(rows, null, 2));
  console.log(lines.join("\n"));
  if (problems.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
