/**
 * Notification settings screen — pure checks of the view model, the wording and the wiring (no DB, no network, no
 * browser).
 *
 *   npx tsx components/settings/notifications/notification-settings-model.test.ts
 *
 *  1. Wording (owner Gate B, binding): no Latin letter at all in the Hebrew area (so no Push / FCM / Token / Digest
 *     / Override / Permission / Cooldown / in-app), no transliterations, plural "אתם" (no singular forms), the
 *     required helper texts and the three choice labels verbatim; English and Hebrew areas have the same keys.
 *  2. Truthfulness: every listed type is a catalog category and every catalog category is listed or hidden with a
 *     reason; every control writes a real settings field (validateSettingsPatch accepts it); every choice body the
 *     screen can send is accepted by the backend's own validator (validatePreferenceBody) and, once stored,
 *     resolves (resolveCategory) to exactly what the chip shows; the worker's decision agrees ("בסיכום היומי" ⇒
 *     to_digest, "בטלפון" ⇒ not suppressed by preference).
 *  3. States: unavailable type greyed + choices kept; master switch / summary off disable their chips; the device
 *     card's state table; the test button's answers; 404 ⇒ "not available yet".
 *  4. Wiring guards: the permission is requested only from the tap handler; patches go through SETTINGS_CONTROLS;
 *     the Settings row is gated by notifications_engine.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { NOTIFICATION_CATEGORIES, getCategory, isCategoryKey } from "@/lib/notifications/catalog";
import { decideOwed } from "@/lib/notifications/engine/worker-decision";
import {
  DEFAULT_SETTINGS,
  SETTINGS_FIELDS,
  resolveCategory,
  validatePreferenceBody,
  validateSettingsPatch,
  type StoredPreference,
} from "@/lib/notifications/preferences";
import { he } from "@/lib/i18n/messages/he";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { notificationsHe } from "./copy/notifications-copy.he";
import { notificationsEn } from "./copy/notifications-copy.en";
import { notificationsHubHe } from "@/lib/i18n/messages/areas/notifications-hub";
import { notificationsHubEn } from "@/lib/i18n/messages/areas/notifications-hub.en";
import { createNotificationT } from "./copy/notification-copy-core";
import { notificationCopyFor } from "./copy/notification-copy-server";
const trHe = createNotificationT(notificationsHe) as (key: string) => string;
import { SETTINGS_CATEGORIES } from "@/components/settings/settings-categories";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";

import {
  CATEGORY_LABEL_KEYS,
  CHOICES,
  DOMAIN_LABEL_KEYS,
  HIDDEN_CATEGORIES,
  SETTINGS_CONTROLS,
  TEST_MESSAGE_KEYS,
  buildTypeGroups,
  categoryRow,
  deviceState,
  loadOutcome,
  minuteToTime,
  preferenceBodyFor,
  preferenceUrl,
  testOutcome,
  timeToMinute,
  visibleCategories,
  withCategoryOverride,
  type SettingsView,
} from "./notification-settings-model";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
}

function leaves(o: unknown, path: string[] = []): [string, string][] {
  if (typeof o === "string") return [[path.join("."), o]];
  if (!o || typeof o !== "object") return [];
  return Object.entries(o).flatMap(([k, v]) => leaves(v, [...path, k]));
}
// The screens' copy and the one Settings hub row in the global dictionary, checked as one text.
const HE = [...leaves(notificationsHe), ...leaves(notificationsHubHe).map(([k, v]) => [`hub.${k}`, v] as [string, string])];
const EN = [...leaves(notificationsEn), ...leaves(notificationsHubEn).map(([k, v]) => [`hub.${k}`, v] as [string, string])];

/* ════════════════════════════════════════════════════════ 1. wording ═══ */

check("the Hebrew area has no Latin letter at all (no Push / FCM / Token / Digest / Override / Permission / Cooldown / in-app)", () => {
  for (const [k, v] of HE) assert.ok(!/[A-Za-z]/.test(v.replace(/\{name\}/g, "")), `${k}: "${v}"`);
});

check("no transliterated technical words", () => {
  const banned = [/פוש/, /טוקן/, /די?ייג'?סט/, /אוברייד/, /קולדאון/, /פרמישן/, /נוטיפיקציה/, /אין[- ]?אפ/];
  for (const [k, v] of HE) for (const b of banned) assert.ok(!b.test(v), `${k}: ${b}`);
});

check("one grammatical person — plural אתם (no singular forms)", () => {
  const singular = new Set(["שלך", "קבל", "בחר", "לחץ", "שקבעת", "הפעל", "בדוק", "נסה", "תבחר", "פתח", "חזור", "לך"]);
  for (const [k, v] of HE) {
    for (const tok of v.split(/[\s,.:;!?()„”"'·—–←\-]+/)) assert.ok(!singular.has(tok), `${k}: singular "${tok}"`);
  }
});

check("one term per concept: the glossary terms are used, the wrong ones never", () => {
  const all = HE.map(([, v]) => v).join("\n");
  for (const term of ["התראות לטלפון", "הגדרות התראות", "סיכום יומי", "שעות שקטות", "הרשאה לקבלת התראות", "סוגי התראות", "שחזור הגדרות ברירת מחדל", "חיבור הטלפון להתראות", "לא הצלחנו לשלוח את ההתראה", "בתוך דוביז"]) {
    assert.ok(all.includes(term), `missing glossary term "${term}"`);
  }
  for (const wrong of ["התראות דחיפה", "הודעות דחיפה", "תקציר", "העדפות התראות", "קטגוריות", "באפליקציה בלבד"]) {
    assert.ok(!all.includes(wrong), `uses "${wrong}"`);
  }
});

check("the required helper texts, verbatim", () => {
  assert.equal(notificationsHe.phone.switchHelp, "קבלו עדכונים חשובים גם כשדוביז סגורה.");
  assert.equal(notificationsHe.delivery.quietHelp, "בשעות שתבחרו לא נשלח התראות רגילות. תזכורות שקבעתם והתראות חשובות עדיין יגיעו.");
  assert.equal(notificationsHe.delivery.digestHelp, "בכל בוקר בשעה שתבחרו (ברירת מחדל 08:00) — עדכון אחד על מה שמחכה לטיפול.");
  assert.equal(notificationsHe.phone.notConfigured, "התראות לטלפון עוד לא זמינות בגרסה הזו של האפליקציה.");
  assert.equal(notificationsHe.phone.deniedTitle, "ההרשאה לקבלת התראות כבויה בהגדרות הטלפון");
  assert.equal(notificationsHe.phone.askButton, "הפעלת התראות");
  assert.equal(notificationsHe.types.unavailable, "לא זמין בחשבון שלכם");
  assert.deepEqual(notificationsHe.types.choices, { inApp: "בתוך דוביז", phone: "בטלפון", digest: "בסיכום היומי" });
});

check("the defaults the texts quote are the backend's defaults (08:00 summary)", () => {
  assert.equal(minuteToTime(DEFAULT_SETTINGS.digestMinute), "08:00");
  assert.ok(notificationsHe.delivery.digestHelp.includes(minuteToTime(DEFAULT_SETTINGS.digestMinute)));
});

check("the reset confirmation says only YOUR settings change", () => {
  assert.ok(notificationsHe.privacy.dialogBody.startsWith("רק ההגדרות שלכם ישתנו"));
  assert.ok(notificationsHe.privacy.resetHelp.includes("משתמשים אחרים"));
});

check("English and Hebrew areas have exactly the same keys, none empty", () => {
  assert.deepEqual(EN.map(([k]) => k).sort(), HE.map(([k]) => k).sort());
  for (const [k, v] of [...HE, ...EN]) assert.ok(v.trim().length > 0, k);
});

check("the global dictionary carries only the Settings hub row (every page ships it in its client JS)", () => {
  assert.equal((he as unknown as { notifications: unknown }).notifications, notificationsHubHe);
  assert.deepEqual(Object.keys(notificationsHubHe), ["category"]);
  assert.ok(!("category" in notificationsHe), "the hub row is not duplicated in the screens' copy");
});

check("the screens' copy is reached only through the server picker (no client module imports its text)", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        const src = readFileSync(f, "utf8");
        // a value import of either copy file (a `import type` adds no text)
        if (/^import (?!type )[^;]*from "[^"]*notifications-copy\.(he|en)"/m.test(src)) offenders.push(f.replace(/\\/g, "/"));
      }
    }
  };
  for (const root of ["app", "components", "features", "lib"]) walk(root);
  const allowed = ["components/settings/notifications/copy/notification-copy-server.ts", "components/settings/notifications/copy/notifications-copy.en.ts"];
  assert.deepEqual(offenders.filter((f) => !allowed.includes(f)), []);
  const server = readFileSync("components/settings/notifications/copy/notification-copy-server.ts", "utf8");
  assert.ok(!/^["']use client["']/m.test(server), "the picker is a server module");
});

check("the route translator: same keys, interpolation, the request's language, a missing key never renders undefined", () => {
  const tHe = createNotificationT(notificationCopyFor("he"));
  const tEn = createNotificationT(notificationCopyFor("en"));
  assert.equal(tHe("notifications.page.title"), notificationsHe.page.title);
  assert.equal(tEn("notifications.page.title"), notificationsEn.page.title);
  assert.equal(notificationCopyFor("fr"), notificationsHe);
  assert.equal(tHe("notifications.types.choicesAria", { name: "X" }), notificationsHe.types.choicesAria.replace("{name}", "X"));
  assert.equal((tHe as (k: string) => string)("notifications.nope.missing"), "notifications.nope.missing");
  assert.equal((tHe as (k: string) => string)("common.loading"), "common.loading");
});

/* ═══════════════════════════════════════════════════ 2. truthfulness ═══ */

check("every listed type is a catalog category; every catalog category is listed or hidden with a reason", () => {
  const visible = visibleCategories().map((c) => c.key);
  for (const k of visible) assert.ok(isCategoryKey(k), k);
  for (const c of NOTIFICATION_CATEGORIES) {
    const hidden = c.key in HIDDEN_CATEGORIES;
    assert.ok(visible.includes(c.key) !== hidden, `${c.key} must be exactly one of listed / hidden`);
    if (hidden) assert.ok(HIDDEN_CATEGORIES[c.key].length > 20, `${c.key}: reason`);
  }
  for (const k of Object.keys(HIDDEN_CATEGORIES)) assert.ok(getCategory(k), `hidden ${k} is not in the catalog`);
});

check("no security type is offered (nothing produces one today, and there is no security email)", () => {
  assert.ok(visibleCategories().every((c) => c.domain !== "security"));
  assert.ok(!HE.some(([, v]) => /אבטחה|אימייל/.test(v) || /מייל/.test(v.replace(/ג׳ימייל/g, ""))), "the screen must not promise security alerts or email");
});

check("every listed type and area has a Hebrew label", () => {
  for (const c of visibleCategories()) {
    const key = CATEGORY_LABEL_KEYS[c.key];
    assert.ok(key, `${c.key} has no label key`);
    assert.notEqual(trHe(key), key, `${c.key} label missing`);
    const dk = DOMAIN_LABEL_KEYS[c.domain as keyof typeof DOMAIN_LABEL_KEYS];
    assert.ok(dk, `${c.domain} has no area label`);
    assert.notEqual(trHe(dk), dk);
  }
  for (const k of Object.keys(CATEGORY_LABEL_KEYS)) assert.ok(visibleCategories().some((c) => c.key === k), `label for unlisted ${k}`);
});

check("every settings control writes a real settings field the backend accepts", () => {
  const sample: Record<string, boolean | number> = {
    pushEnabled: false, digestEnabled: false, quietHoursEnabled: false, lockScreenDetails: true,
    digestMinute: 9 * 60, quietStartMinute: 23 * 60, quietEndMinute: 6 * 60 + 30,
  };
  for (const field of Object.values(SETTINGS_CONTROLS)) {
    assert.ok((SETTINGS_FIELDS as readonly string[]).includes(field), field);
    const v = validateSettingsPatch({ [field]: sample[field] });
    assert.ok(v.ok, `${field}: ${!v.ok ? v.error : ""}`);
  }
  // …and every settings field has a control (nothing the backend offers is silently missing).
  assert.deepEqual([...new Set(Object.values(SETTINGS_CONTROLS))].sort(), [...SETTINGS_FIELDS].sort());
});

const OVERRIDE_STATES: StoredPreference[][] = [
  [],
  [{ key: "domain:inventory", inApp: null, push: false, delivery: "digest" }],
  [{ key: "domain:billing", inApp: false, push: true, delivery: null }],
];

check("every choice body is accepted by the backend and resolves to exactly what the chip then shows", () => {
  let n = 0;
  for (const cat of visibleCategories()) {
    for (const prefs of OVERRIDE_STATES) {
      for (const choice of CHOICES) {
        const row = categoryRow(cat, DEFAULT_SETTINGS, prefs, true);
        if (!row.choices[choice].shown) continue;
        for (const value of [true, false]) {
          const body = preferenceBodyFor(cat, DEFAULT_SETTINGS, prefs, choice, value);
          const v = validatePreferenceBody(body, [cat]);
          assert.ok(v.ok, `${cat.key} ${choice}=${value}: ${!v.ok ? v.error : ""}`);
          const next = withCategoryOverride(prefs, cat, body);
          const after = categoryRow(cat, DEFAULT_SETTINGS, next, true);
          assert.equal(after.choices[choice].pressed, value, `${cat.key} ${choice}=${value} not shown as chosen`);
          // The engine's own view of the stored result agrees with the chips.
          const eff = resolveCategory(cat, DEFAULT_SETTINGS, next, true);
          if (after.choices.digest.pressed) assert.ok(eff.delivery === "digest" && eff.inApp, `${cat.key}: digest`);
          if (after.choices.phone.pressed) assert.ok(eff.push && eff.delivery === "instant", `${cat.key}: phone`);
          assert.equal(eff.inApp, after.choices.inApp.pressed, `${cat.key}: inApp`);
          n += 1;
        }
      }
    }
  }
  assert.ok(n > 100, `only ${n} combinations`);
});

check("the worker agrees: 'בסיכום היומי' ⇒ held for the summary; 'בטלפון' ⇒ not suppressed by the preference", () => {
  const now = new Date("2026-11-13T10:00:00Z");
  for (const cat of visibleCategories().filter((c) => c.userMutable.delivery)) {
    const digestPrefs = withCategoryOverride([], cat, preferenceBodyFor(cat, DEFAULT_SETTINGS, [], "digest", true));
    const phonePrefs = withCategoryOverride([], cat, preferenceBodyFor(cat, DEFAULT_SETTINGS, [], "phone", true));
    const facts = (prefs: StoredPreference[]) => ({
      now,
      notification: { resolvedAt: null, dismissedAt: null },
      expiresAt: new Date(now.getTime() + 3_600_000),
      category: cat,
      effective: resolveCategory(cat, DEFAULT_SETTINGS, prefs, true),
      quiet: { enabled: false, startMinute: 0, endMinute: 0 },
      timeZone: "Asia/Jerusalem",
      recentSends: [],
    });
    const d = decideOwed(facts(digestPrefs));
    assert.ok(d.kind === "suppress" && (d.reason === "to_digest" || d.reason === "pref_off"), `${cat.key} digest: ${JSON.stringify(d)}`);
    assert.deepEqual(decideOwed(facts(phonePrefs)), { kind: "send" }, `${cat.key} phone`);
  }
});

check("a choice never sends a value for an aspect the type does not let the user change", () => {
  const reminder = getCategory("tasks.reminder")!;
  const row = categoryRow(reminder, DEFAULT_SETTINGS, [], true);
  assert.equal(row.choices.digest.shown, false, "reminders are always instant — no summary choice");
  assert.equal(preferenceBodyFor(reminder, DEFAULT_SETTINGS, [], "phone", false).delivery, null);
});

check("the override URL is the backend's key format", () => {
  assert.equal(preferenceUrl("inventory.attention"), "/api/notifications/settings/preferences/category%3Ainventory.attention");
  assert.throws(() => preferenceUrl("nope.nope"));
});

/* ═══════════════════════════════════════════════════════════ 3. states ═══ */

check("an unavailable type is greyed with every choice disabled, and its stored choices are kept", () => {
  const prefs: StoredPreference[] = [{ key: "category:billing.review", inApp: true, push: true, delivery: "instant" }];
  const view: SettingsView = {
    settings: DEFAULT_SETTINGS,
    categories: NOTIFICATION_CATEGORIES.map((c) => ({ key: c.key, available: c.domain !== "billing" })),
    overrides: prefs,
  };
  const billing = buildTypeGroups(view).find((g) => g.domain === "billing")!;
  for (const r of billing.rows) {
    assert.equal(r.available, false);
    for (const c of CHOICES) assert.equal(r.choices[c].disabled, true, `${r.key} ${c}`);
  }
  const review = billing.rows.find((r) => r.key === "billing.review")!;
  assert.equal(review.choices.phone.pressed, true, "the stored choice is still shown (kept, not deleted)");
});

check("master switch off disables 'בטלפון' (choice kept); summary off disables 'בסיכום היומי'", () => {
  const cat = getCategory("booking.request_waiting")!;
  const offPush = categoryRow(cat, { ...DEFAULT_SETTINGS, pushEnabled: false }, [], true);
  assert.equal(offPush.choices.phone.disabled, true);
  assert.equal(offPush.choices.phone.pressed, true, "the user's own choice stays visible");
  const offDigest = categoryRow(cat, { ...DEFAULT_SETTINGS, digestEnabled: false }, [], true);
  assert.equal(offDigest.choices.digest.disabled, true);
});

check("groups follow the approved order and hold only listed types", () => {
  const view: SettingsView = { settings: DEFAULT_SETTINGS, categories: NOTIFICATION_CATEGORIES.map((c) => ({ key: c.key, available: true })), overrides: [] };
  const groups = buildTypeGroups(view);
  assert.deepEqual(groups.slice(0, 3).map((g) => g.domain), ["tasks", "appointments", "inbox"]);
  assert.equal(groups.flatMap((g) => g.rows).length, visibleCategories().length);
  assert.ok(groups.every((g) => g.rows.length > 0));
});

check("device card states", () => {
  const n = (o: Partial<{ configured: boolean; permission: "granted" | "denied" | "prompt" | "unavailable"; optedIn: boolean; askedThisVisit: boolean; registration: "idle" | "connecting" | "connected" | "failed" }>) =>
    deviceState({ kind: "native", configured: true, permission: "prompt", optedIn: false, askedThisVisit: false, registration: "idle", ...o });
  assert.equal(n({ configured: false }), "native-not-configured");
  assert.equal(n({ configured: false, permission: "granted", optedIn: true }), "native-not-configured", "no Firebase ⇒ never offer enabling");
  assert.equal(n({}), "native-ask");
  assert.equal(n({ askedThisVisit: true }), "native-ask-again", "prompt-with-rationale maps to prompt ⇒ reason + ask again");
  assert.equal(n({ permission: "denied" }), "native-denied");
  assert.equal(n({ permission: "granted", optedIn: false }), "native-ask", "granted silently (Android ≤ 12) is not consent");
  assert.equal(n({ permission: "granted", optedIn: true, registration: "connecting" }), "native-connecting");
  assert.equal(n({ permission: "granted", optedIn: true, registration: "failed" }), "native-connect-failed");
  assert.equal(n({ permission: "granted", optedIn: true, registration: "connected" }), "native-connected");
  assert.equal(deviceState({ kind: "app-without-push" }), "app-not-configured");
  assert.equal(deviceState({ kind: "browser", browserPush: "unavailable" }), "browser-app-only");
  assert.equal(deviceState({ kind: "browser", browserPush: "off" }), "browser-off");
  assert.equal(deviceState({ kind: "browser", browserPush: "on" }), "browser-on");
  assert.equal(deviceState({ kind: "browser", browserPush: "denied" }), "browser-blocked");
});

check("test button answers", () => {
  assert.equal(testOutcome(200, { ok: true, sent: 1, failed: 0 }), "sent");
  assert.equal(testOutcome(200, { ok: true, sent: 0, failed: 0, suppressed: 0 }), "no_device");
  assert.equal(testOutcome(200, { ok: true, sent: 0, failed: 2 }), "failed");
  assert.equal(testOutcome(200, { ok: true, sent: 0, failed: 0, retrying: 1 }), "failed");
  assert.equal(testOutcome(429, { error: "RATE_LIMITED" }), "rate_limited");
  assert.equal(testOutcome(500, null), "failed");
  assert.equal(testOutcome(null, null), "offline");
  for (const k of Object.values(TEST_MESSAGE_KEYS)) assert.notEqual(trHe(k), k);
});

check("page state: 404 (engine off for the business) ⇒ calm 'not available yet'; other failures ⇒ retry", () => {
  assert.equal(loadOutcome(200), "ready");
  assert.equal(loadOutcome(404), "unavailable");
  assert.equal(loadOutcome(401), "error");
  assert.equal(loadOutcome(500), "error");
  assert.equal(loadOutcome(null), "error");
});

check("time conversion", () => {
  assert.equal(timeToMinute("07:30"), 450);
  assert.equal(timeToMinute("23:59"), 1439);
  assert.equal(timeToMinute("00:00:00"), 0);
  assert.equal(timeToMinute("24:00"), null);
  assert.equal(timeToMinute(""), null);
  assert.equal(minuteToTime(1320), "22:00");
});

/* ════════════════════════════════════════════════════════ 4. wiring ═══ */

const read = (p: string) => fs.readFileSync(p, "utf8");
const DIR = "components/settings/notifications";

check("the system permission dialog is requested only from the tap handler", () => {
  const src = read(`${DIR}/PhoneDeviceCard.tsx`);
  const calls = [...src.matchAll(/requestPushPermission\(/g)].map((m) => m.index!);
  assert.equal(calls.length, 1, "exactly one call");
  const ask = src.indexOf("async function ask()");
  assert.ok(ask > 0 && calls[0] > ask && calls[0] - ask < 200, "the call lives in ask()");
  const effects = [...src.matchAll(/useEffect\(/g)].map((m) => m.index!);
  for (const e of effects) {
    const body = src.slice(e, src.indexOf("}, [", e));
    assert.ok(!body.includes("requestPushPermission") && !body.includes("ask()"), "never from an effect");
  }
});

check("every settings write goes through SETTINGS_CONTROLS (a real field)", () => {
  for (const f of ["NotificationsMainScreen.tsx", "NotificationPrivacyScreen.tsx"]) {
    const src = read(`${DIR}/${f}`);
    for (const m of src.matchAll(/patchSettings\(\{\s*\[([^\]]+)\]/g)) {
      assert.ok(/^SETTINGS_CONTROLS\.\w+$|^field$/.test(m[1].trim()), `${f}: ${m[1]}`);
    }
    assert.ok(!/patchSettings\(\{\s*[a-zA-Z]+\s*:/.test(src), `${f}: literal field name`);
  }
});

check("the Settings row is gated by notifications_engine and points to the page", () => {
  const c = SETTINGS_CATEGORIES.find((x) => x.key === "notifications");
  assert.ok(c);
  assert.equal(c.featureKey, PLATFORM_FEATURE_KEYS.NOTIFICATIONS_ENGINE);
  assert.equal(c.group, "preferences");
  assert.equal(c.icon, "🔔");
  assert.equal(c.href, "/settings/notifications");
  for (const p of ["app/settings/notifications/page.tsx", "app/settings/notifications/types/page.tsx", "app/settings/notifications/privacy/page.tsx"]) {
    assert.ok(fs.existsSync(p), p);
    assert.ok(read(p).includes("getNotificationCopy") && read(p).includes("<NotificationCopyProvider copy={copy}>"), `${p} picks the copy on the server and hands it to the screen`);
  }
});

check("no interface Hebrew is hard-coded in the screens (it all comes from the dictionary)", () => {
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".tsx"))) {
    const code = read(`${DIR}/${f}`)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    assert.ok(!/[֐-׿]/.test(code), `${f} contains Hebrew outside comments`);
  }
});

console.log(`\n[notification settings] PASS=${passed} FAIL=${failed}`);
if (failed > 0) process.exit(1);
