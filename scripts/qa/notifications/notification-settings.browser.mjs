#!/usr/bin/env node
/**
 * Notification settings (Settings → התראות), in a REAL browser: this build under `next start`, every /api/**
 * request answered here (no database, no push provider; nothing is ever sent).
 *
 *   BASE=http://localhost:3631 OUT=./shots node scripts/qa/notifications/notification-settings.browser.mjs
 *
 * Android WebView UA at 320 px and 390 px (Hebrew, RTL), plus desktop 1440 px for the rail:
 *   - the Settings row "התראות" is listed only while notifications_engine is ON for the business;
 *   - the main / types / privacy screens: RTL, no horizontal scroll, no clipped text, switches are real
 *     checkboxes with role="switch" + label + aria-checked + aria-describedby, touch targets ≥ 44px, text contrast
 *     ≥ 4.5:1, no technical word on screen;
 *   - every control round-trips to the API (PATCH / PUT bodies asserted) and rolls back when the server refuses;
 *   - test notification answers (sent / no device / rate limited); reset behind a confirmation dialog;
 *   - the engine OFF for the business (404) ⇒ a calm "not available yet".
 * Screenshots + results.json in OUT. Local server only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = (process.env.BASE || "http://localhost:3631").replace(/\/$/, "");
const OUT = path.resolve(process.env.OUT || "notification-settings-shots");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}: local server only.`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: "qa", exp: 1893456000 })}.sig`;
const WV_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36";
const VIEWPORTS = [
  { name: "android-320", width: 320, height: 720, isMobile: true, hasTouch: true, userAgent: WV_UA },
  { name: "android-390", width: 390, height: 844, isMobile: true, hasTouch: true, userAgent: WV_UA },
  { name: "desktop-1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];

const CATEGORY_KEYS = [
  ["tasks.reminder", "tasks"], ["booking.request_waiting", "appointments"], ["inbox.customer_waiting", "inbox"],
  ["inventory.critical_stock", "inventory"], ["inventory.attention", "inventory"], ["billing.failure", "billing"],
  ["billing.review", "billing"], ["documents.review", "documents"], ["accountant.send_failed", "accountant"],
  ["accountant.month_close", "accountant"], ["connections.disconnected", "connections"], ["leads.follow_up", "leads"],
  ["suppliers.purchase_pending", "suppliers"], ["security.new_device", "security"], ["digest.daily", "system"], ["system.test", "system"],
];

const results = [];
const check = (vp, name, cond, detail = "") => {
  results.push({ vp, name, pass: !!cond, detail: cond ? "" : String(detail) });
  console.log(`${cond ? "  ok " : "FAIL "} [${vp}] ${name}${detail && !cond ? ` — ${detail}` : ""}`);
};

function freshState(over = {}) {
  return {
    engine: true,
    settings: { pushEnabled: true, quietHoursEnabled: true, quietStartMinute: 1320, quietEndMinute: 420, digestEnabled: true, digestMinute: 480, lockScreenDetails: false },
    overrides: [],
    failPatch: false,
    failPut: false,
    test: "sent",
    writes: [],
    ...over,
  };
}
function viewOf(state) {
  return {
    settings: state.settings,
    storedSettings: state.settings,
    timeZone: "Asia/Jerusalem",
    categories: CATEGORY_KEYS.map(([key, domain]) => ({ key, domain, available: domain !== "accountant" })),
    overrides: state.overrides,
  };
}

async function ctxFor(browser, vp, state) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, userAgent: vp.userAgent, locale: "he-IL" });
  await ctx.addInitScript((t) => {
    localStorage.setItem("token", t);
    localStorage.setItem("user", JSON.stringify({ id: 9, name: "בעלים", businessName: "עסק" }));
  }, TOKEN);
  await ctx.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const m = req.method();
    const j = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => { try { return JSON.parse(req.postData() || "null"); } catch { return null; } };
    if (u.pathname === "/api/business/capabilities") return j({ features: { notifications_engine: { allowed: state.engine } } });
    if (u.pathname.startsWith("/api/notifications/") && !state.engine) return j({ error: "Not found" }, 404);
    if (u.pathname === "/api/notifications/settings") {
      if (m === "GET") return j(viewOf(state));
      if (m === "PATCH") {
        const b = body();
        state.writes.push({ method: m, path: u.pathname, body: b });
        await new Promise((r) => setTimeout(r, 150));
        if (state.failPatch) return j({ error: "INTERNAL" }, 500);
        state.settings = { ...state.settings, ...b };
        return j(viewOf(state));
      }
    }
    if (u.pathname.startsWith("/api/notifications/settings/preferences/") && m === "PUT") {
      const key = decodeURIComponent(u.pathname.split("/").pop());
      const b = body();
      state.writes.push({ method: m, path: key, body: b });
      await new Promise((r) => setTimeout(r, 150));
      if (state.failPut) return j({ error: "INTERNAL" }, 500);
      state.overrides = [...state.overrides.filter((p) => p.key !== key), { key, ...b }];
      return j({ ok: true, key, ...b });
    }
    if (u.pathname === "/api/notifications/settings/reset" && m === "POST") {
      state.writes.push({ method: m, path: u.pathname, body: null });
      state.settings = freshState().settings;
      state.overrides = [];
      return j({ ok: true, removed: { settings: 1, preferences: 1 } });
    }
    if (u.pathname === "/api/notifications/test" && m === "POST") {
      if (state.test === "limited") return j({ error: "RATE_LIMITED" }, 429);
      if (state.test === "none") return j({ ok: true, sent: 0, failed: 0, suppressed: 0 });
      return j({ ok: true, sent: 1, failed: 0, suppressed: 0, retrying: 0 });
    }
    if (u.pathname === "/api/push/subscriptions") return j({ configured: false, publicKey: null });
    if (u.pathname === "/api/auth/me") return j({ user: { id: 9, name: "בעלים", businessName: "עסק", email: "qa@example.invalid" } });
    return j({ error: "not mocked" }, 404);
  });
  return ctx;
}

const settle = async (p) => { await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {}); await p.waitForTimeout(500); };

/** Layout, accessibility and wording checks on whatever screen is open. */
async function audit(p, vp, label) {
  const r = await p.evaluate(() => {
    const out = { overflow: document.documentElement.scrollWidth > window.innerWidth + 1, dir: document.documentElement.dir || getComputedStyle(document.body).direction };
    const visible = (el) => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
    const scope = document.querySelector("[data-testid^='notif-']")?.closest("div.min-w-0") || document.body;
    // Switches.
    out.switches = [...scope.querySelectorAll("input[role='switch']")].map((el) => {
      const lab = document.querySelector(`label[for='${el.id}']`);
      const desc = el.getAttribute("aria-describedby");
      const b = el.getBoundingClientRect();
      return { id: el.id, type: el.type, label: lab?.textContent?.trim() || "", ariaChecked: el.getAttribute("aria-checked") === String(el.checked), described: !desc || !!document.getElementById(desc), h: b.height, w: b.width };
    });
    // Touch targets.
    out.small = [...scope.querySelectorAll("button, input, a[href]")].filter(visible).map((el) => { const b = el.getBoundingClientRect(); return { t: (el.textContent || el.id || el.tagName).trim().slice(0, 30), h: Math.round(b.height), w: Math.round(b.width) }; }).filter((x) => x.h < 44 || x.w < 44);
    // Clipped text.
    out.clipped = [...scope.querySelectorAll("h1, h2, p, label, button, span")].filter(visible).filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible").map((el) => el.textContent.trim().slice(0, 40));
    out.offscreen = [...scope.querySelectorAll("h2, p, label, button")].filter(visible).filter((el) => { const b = el.getBoundingClientRect(); return b.left < -1 || b.right > window.innerWidth + 1; }).map((el) => el.textContent.trim().slice(0, 40));
    // Contrast of text (disabled controls are exempt, WCAG 1.4.3).
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = "1"] = m[1].split(/[,\s/]+/).filter(Boolean); return [+r, +g, +b, +a]; };
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c[3] > 0.5) return c; } return [255, 255, 255, 1]; };
    const dimmed = (el) => { for (let n = el; n; n = n.parentElement) { if (n.disabled || parseFloat(getComputedStyle(n).opacity) < 1) return true; } return false; };
    out.lowContrast = [];
    for (const el of scope.querySelectorAll("h1, h2, p, label, button, span")) {
      if (!visible(el) || dimmed(el) || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const fg = parse(getComputedStyle(el).color); const bg = bgOf(el);
      if (!fg) continue;
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      if (ratio < 4.5) out.lowContrast.push(`${el.textContent.trim().slice(0, 30)} ${ratio.toFixed(2)}`);
    }
    out.text = scope.innerText;
    return out;
  });
  check(vp.name, `${label}: RTL`, r.dir === "rtl", r.dir);
  check(vp.name, `${label}: no horizontal scroll`, !r.overflow);
  check(vp.name, `${label}: no clipped / off-screen text`, r.clipped.length === 0 && r.offscreen.length === 0, JSON.stringify([...r.clipped, ...r.offscreen]));
  check(vp.name, `${label}: touch targets ≥ 44px`, r.small.length === 0, JSON.stringify(r.small));
  check(vp.name, `${label}: text contrast ≥ 4.5:1`, r.lowContrast.length === 0, JSON.stringify(r.lowContrast));
  check(vp.name, `${label}: switches are labelled checkboxes with role=switch, aria-checked, aria-describedby`,
    r.switches.every((s) => s.type === "checkbox" && s.label && s.ariaChecked && s.described && s.h >= 44), JSON.stringify(r.switches));
  check(vp.name, `${label}: no technical word on screen`, !/\b(push|fcm|token|digest|override|permission|cooldown|in-app)\b/i.test(r.text), r.text.match(/\b(push|fcm|token|digest|override|permission|cooldown|in-app)\b/i)?.[0]);
  return r;
}

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  const mobile = vp.width < 1200;
  // 1. The Settings row: listed with the engine ON, absent with it OFF.
  for (const engine of [true, false]) {
    const state = freshState({ engine });
    const ctx = await ctxFor(browser, vp, state);
    const p = await ctx.newPage();
    await p.goto(BASE + (mobile ? "/settings" : "/settings/workspace")); await settle(p);
    const n = await p.locator('a[href="/settings/notifications"]').count();
    check(vp.name, `settings ${mobile ? "hub" : "rail"}: notifications row ${engine ? "listed" : "hidden"} (engine ${engine ? "ON" : "OFF"})`, engine ? n >= 1 : n === 0, `count=${n}`);
    if (!engine) {
      await p.goto(BASE + "/settings/notifications"); await settle(p);
      check(vp.name, "engine OFF: calm 'not available yet'", (await p.locator('[data-testid="notif-unavailable"]').innerText().catch(() => "")).includes("עוד לא זמינות"));
      await p.screenshot({ path: path.join(OUT, `${vp.name}-unavailable.png`), fullPage: true });
    }
    await ctx.close();
  }

  // 2. Main screen.
  {
    const state = freshState();
    const ctx = await ctxFor(browser, vp, state);
    const p = await ctx.newPage();
    await p.goto(BASE + "/settings/notifications"); await settle(p);
    await p.locator('[data-testid="notif-main"]').waitFor({ timeout: 15000 }).catch(() => {});
    await audit(p, vp, "main");
    await p.screenshot({ path: path.join(OUT, `${vp.name}-main.png`), fullPage: true });
    const txt = await p.locator('[data-testid="notif-main"]').innerText();
    for (const s of ["קבלו עדכונים חשובים גם כשדוביז סגורה.", "סיכום יומי", "שעות שקטות", "סוגי התראות"]) check(vp.name, `main shows "${s}"`, txt.includes(s));
    check(vp.name, "browser: phone notifications are the Android app's (no browser option where it cannot work)",
      (await p.locator('[data-testid="notif-device"]').getAttribute("data-state")) === "browser-app-only" && txt.includes("באפליקציית דוביז לאנדרואיד"));

    // Daily summary off → PATCH {digestEnabled:false}, the time field goes.
    await p.locator("#notif-digest").click(); await p.waitForTimeout(500);
    const w1 = state.writes.at(-1);
    check(vp.name, "summary switch → PATCH {digestEnabled:false}", w1?.method === "PATCH" && JSON.stringify(w1.body) === '{"digestEnabled":false}', JSON.stringify(w1));
    check(vp.name, "summary off → its time field is gone; saved", (await p.locator("#notif-digest-time").count()) === 0 && (await p.locator('[data-testid="notif-save-status"]').getAttribute("data-note")) === "saved");
    // Quiet hours "to" time → PATCH {quietEndMinute: 390}.
    await p.locator("#notif-quiet-to").fill("06:30"); await p.locator("#notif-quiet-to").blur(); await p.waitForTimeout(500);
    const w2 = state.writes.at(-1);
    check(vp.name, "quiet-hours end → PATCH {quietEndMinute:390}", JSON.stringify(w2?.body) === '{"quietEndMinute":390}', JSON.stringify(w2));
    // Server refuses → rolled back, plain error.
    state.failPatch = true;
    await p.locator("#notif-quiet").click(); await p.waitForTimeout(700);
    check(vp.name, "refused save → switch rolled back", await p.locator("#notif-quiet").isChecked());
    check(vp.name, "refused save → 'לא הצלחנו לשמור…' with what to do", (await p.locator('[data-testid="notif-save-status"]').innerText()).includes("לא הצלחנו לשמור. בדקו את החיבור לאינטרנט ונסו שוב."));
    state.failPatch = false;
    // Test notification answers.
    for (const [mode, expect] of [["sent", "נשלחה התראת בדיקה"], ["none", "אין מכשיר מחובר להתראות"], ["limited", "נסו שוב בעוד כמה דקות"]]) {
      state.test = mode;
      await p.locator('[data-testid="notif-test"]').click(); await p.waitForTimeout(500);
      check(vp.name, `test notification (${mode})`, (await p.locator('[data-testid="notif-test-result"]').innerText()).includes(expect));
    }
    await p.screenshot({ path: path.join(OUT, `${vp.name}-main-after.png`), fullPage: true });
    // Phone notifications off → test disabled, note shown.
    await p.locator("#notif-push").click(); await p.waitForTimeout(500);
    check(vp.name, "phone notifications off → PATCH {pushEnabled:false}, test button disabled", JSON.stringify(state.writes.at(-1)?.body) === '{"pushEnabled":false}' && (await p.locator('[data-testid="notif-test"]').isDisabled()));
    // Reload: what was saved is what is shown.
    await p.reload(); await settle(p);
    check(vp.name, "after reload the saved values are shown", !(await p.locator("#notif-push").isChecked()) && !(await p.locator("#notif-digest").isChecked()) && (await p.locator("#notif-quiet-to").inputValue()) === "06:30");
    await ctx.close();
  }

  // 3. Types screen.
  {
    const state = freshState();
    const ctx = await ctxFor(browser, vp, state);
    const p = await ctx.newPage();
    await p.goto(BASE + "/settings/notifications/types"); await settle(p);
    await p.locator('[data-testid="notif-types"]').waitFor({ timeout: 15000 }).catch(() => {});
    await audit(p, vp, "types");
    await p.screenshot({ path: path.join(OUT, `${vp.name}-types.png`), fullPage: true });
    const keys = await p.locator('[data-testid="notif-type"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-key")));
    check(vp.name, "types: only catalog categories, no security / system types", keys.length === 13 && !keys.some((k) => /^(security|digest|system)\./.test(k)), JSON.stringify(keys));
    const inbox = p.locator('[data-testid="notif-type"][data-key="inbox.customer_waiting"]');
    const phone = inbox.locator('button[data-choice="phone"]');
    check(vp.name, "types: chips are buttons with aria-pressed", (await phone.getAttribute("aria-pressed")) === "false");
    await phone.click(); await p.waitForTimeout(500);
    const w = state.writes.at(-1);
    check(vp.name, "types: 'בטלפון' → PUT category:inbox.customer_waiting {inApp:true,push:true,delivery:instant}",
      w?.method === "PUT" && w.path === "category:inbox.customer_waiting" && JSON.stringify(w.body) === '{"inApp":true,"push":true,"delivery":"instant"}', JSON.stringify(w));
    check(vp.name, "types: chip shows the choice", (await phone.getAttribute("aria-pressed")) === "true");
    const digest = inbox.locator('button[data-choice="digest"]');
    await digest.click(); await p.waitForTimeout(500);
    check(vp.name, "types: 'בסיכום היומי' → delivery digest, phone off", JSON.stringify(state.writes.at(-1)?.body) === '{"inApp":true,"push":false,"delivery":"digest"}' && (await phone.getAttribute("aria-pressed")) === "false" && (await digest.getAttribute("aria-pressed")) === "true");
    state.failPut = true;
    await phone.click(); await p.waitForTimeout(700);
    check(vp.name, "types: refused save → chip rolled back + error", (await phone.getAttribute("aria-pressed")) === "false" && (await p.locator('[data-testid="notif-save-status"]').getAttribute("data-note")) === "error");
    state.failPut = false;
    const acc = p.locator('[data-testid="notif-type"][data-available="false"]');
    check(vp.name, "types: unavailable type greyed, 'לא זמין בחשבון שלכם', choices disabled",
      (await acc.count()) === 2 && (await acc.first().innerText()).includes("לא זמין בחשבון שלכם") && (await acc.first().locator("button").evaluateAll((b) => b.every((x) => x.disabled))));
    const reminder = p.locator('[data-testid="notif-type"][data-key="tasks.reminder"]');
    check(vp.name, "types: reminders have no summary choice (always on time)", (await reminder.locator('button[data-choice="digest"]').count()) === 0);
    await ctx.close();
  }

  // 4. Privacy and restoring settings.
  {
    const state = freshState({ overrides: [{ key: "category:billing.review", inApp: true, push: true, delivery: "instant" }] });
    const ctx = await ctxFor(browser, vp, state);
    const p = await ctx.newPage();
    await p.goto(BASE + "/settings/notifications/privacy"); await settle(p);
    await p.locator('[data-testid="notif-privacy"]').waitFor({ timeout: 15000 }).catch(() => {});
    await audit(p, vp, "privacy");
    await p.screenshot({ path: path.join(OUT, `${vp.name}-privacy.png`), fullPage: true });
    check(vp.name, "privacy: no security section (nothing produces one today)", !(await p.locator('[data-testid="notif-privacy"]').innerText()).includes("אבטחה"));
    await p.locator("#notif-lock-details").click(); await p.waitForTimeout(500);
    check(vp.name, "privacy: details switch → PATCH {lockScreenDetails:true}", JSON.stringify(state.writes.at(-1)?.body) === '{"lockScreenDetails":true}');
    await p.locator('[data-testid="notif-reset"]').click(); await p.waitForTimeout(300);
    const dlg = p.locator('[role="dialog"]');
    check(vp.name, "reset: confirmation dialog (role=dialog, aria-modal) says only YOUR settings change",
      (await dlg.count()) === 1 && (await dlg.getAttribute("aria-modal")) === "true" && (await dlg.innerText()).includes("רק ההגדרות שלכם ישתנו"));
    const onTop = await p.evaluate(() => {
      const b = document.querySelector('[data-testid="notif-reset-confirm"]');
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === b || b.contains(hit);
    });
    check(vp.name, "reset: the dialog sits above the bottom navigation (its button is the topmost element)", onTop);
    await p.screenshot({ path: path.join(OUT, `${vp.name}-reset-dialog.png`) });
    check(vp.name, "reset: nothing sent before confirming", !state.writes.some((w) => w.path === "/api/notifications/settings/reset"));
    await p.locator('[data-testid="notif-reset-confirm"]').click(); await p.waitForTimeout(700);
    check(vp.name, "reset: POST reset, dialog closed, defaults shown", state.writes.some((w) => w.path === "/api/notifications/settings/reset") && (await dlg.count()) === 0 && !(await p.locator("#notif-lock-details").isChecked()) && (await p.locator('[data-testid="notif-reset-result"]').innerText()).includes("ההגדרות חזרו לברירת המחדל"));
    await ctx.close();
  }
}
await browser.close();
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
