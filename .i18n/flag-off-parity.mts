/**
 * Flag-OFF parity: the same routes rendered by MAIN and by THIS BRANCH (DUBIZ_I18N_ENABLED unset),
 * compared on what a user actually sees — <html lang/dir>, <title>, and the visible text — at phone
 * and desktop widths, with a dz_locale=en cookie present (which must be ignored).
 * Usage: MAIN_BASE=http://localhost:3920 BRANCH_BASE=http://localhost:3921 npx tsx .i18n/flag-off-parity.mts
 * Routes needing a session render their signed-out state on both sides (same input, same output).
 */
import { chromium } from "playwright";

const MAIN = process.env.MAIN_BASE ?? "http://localhost:3920";
const BRANCH = process.env.BRANCH_BASE ?? "http://localhost:3921";
const ROUTES = (process.env.ROUTES ?? "/login,/register,/forgot-password,/app,/collection,/documents,/billing,/settings,/inventory,/tasks,/home,/pricing").split(",");
// Intentional, owner-approved differences when the flag is off.
const EXPECTED_DIFF: Record<string, string> = {
  "/settings/workspace": "the read-only 'שפה ואזור' page became 'שפה, אזור ומטבע' (approved screen)",
};

let same = 0;
const diffs: string[] = [];
const normalize = (s: string) => s.replace(/\s+/g, " ").replace(/\d{1,2}:\d{2}/g, "HH:MM").trim();

async function snapshot(base: string, route: string, width: number) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: "he-IL" });
  await ctx.addCookies([{ name: "dz_locale", value: "en", url: base }]);
  const page = await ctx.newPage();
  await page.goto(base + route, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  // Signed-out routes redirect client-side; read once the navigation has settled.
  let out: { lang: string; dir: string; title: string; url: string; text: string } | null = null;
  for (let attempt = 0; attempt < 5 && !out; attempt++) {
    try {
      out = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        title: document.title,
        url: location.pathname,
        text: document.body.innerText,
      }));
    } catch {
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
    }
  }
  if (!out) throw new Error(`could not read ${base}${route}`);
  // Settle: the same pathname + text on three consecutive reads (dev compiles and client redirects
  // otherwise make a single read land mid-navigation on either side).
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    await page.waitForTimeout(1000);
    try {
      const next = await page.evaluate(() => ({
        lang: document.documentElement.lang, dir: document.documentElement.dir, title: document.title,
        url: location.pathname, text: document.body.innerText,
      }));
      stable = next.url === out.url && next.text === out.text && next.title === out.title && next.text.trim() !== "" ? stable + 1 : 0;
      out = next;
    } catch {
      stable = 0;
    }
  }
  await browser.close();
  return out;
}

async function main() {
  for (const route of ROUTES) {
    for (const width of [390, 1440]) {
      const [m, b] = [await snapshot(MAIN, route, width), await snapshot(BRANCH, route, width)];
      const mt = normalize(m.text);
      const bt = normalize(b.text);
      const equal = m.lang === b.lang && m.dir === b.dir && m.title === b.title && m.url === b.url && mt === bt;
      const tag = `${route} @${width}`;
      if (equal) { same++; console.log(`  [SAME] ${tag}  (${b.lang}/${b.dir}, "${b.title}")`); continue; }
      const note = EXPECTED_DIFF[route] ? ` — expected: ${EXPECTED_DIFF[route]}` : "";
      diffs.push(tag + note);
      console.log(`  [DIFF] ${tag}${note}`);
      console.log(`     main  : ${m.lang}/${m.dir} "${m.title}" ${m.url} :: ${mt.slice(0, 300)}`);
      console.log(`     branch: ${b.lang}/${b.dir} "${b.title}" ${b.url} :: ${bt.slice(0, 300)}`);
    }
  }
  const unexpected = diffs.filter((d) => !d.includes("expected:"));
  console.log(`\nflag-off parity: ${same} identical, ${diffs.length} different (${unexpected.length} unexpected)`);
  if (unexpected.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
