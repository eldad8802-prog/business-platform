/**
 * Notification preferences — pure checks of the resolver and the request validation.
 *
 *   npx tsx lib/notifications/preferences.test.ts
 *
 *  1. Defaults: every NULL settings column reads the product default (push on, quiet 22:00–07:00, digest 08:00,
 *     lock-screen details off); each stored value wins over its default.
 *  2. Resolution order: catalog defaults ← domain override ← category override ← settings (the push master switch
 *     turns every push off); an aspect the category does not let the user change is never overridden (security
 *     in-app); a NULL override aspect is no override.
 *  3. Availability: a category whose feature is unavailable is inactive (in-app / push false, available false) —
 *     the overrides passed in are untouched; unknown categories are in-app only, never push.
 *  4. Read-side hiding: only categories the user switched off in-app; nothing without overrides.
 *  5. Validation: settings PATCH (unknown fields, types, minute ranges, empty), preference keys (domain / category
 *     of the catalog only), preference bodies (unknown fields, types, NOT_MUTABLE).
 */
import { getCategory, NOTIFICATION_CATEGORIES } from "./catalog";
import {
  DEFAULT_SETTINGS,
  EMPTY_SETTINGS,
  effectiveSettings,
  hiddenInAppCategories,
  resolveAll,
  resolveCategory,
  validatePreferenceBody,
  validatePreferenceKey,
  validateSettingsPatch,
  type StoredPreference,
} from "./preferences";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}`, detail ?? ""); }
}
const cat = (k: string) => getCategory(k)!;
const pref = (key: string, p: Partial<StoredPreference>): StoredPreference => ({ key, inApp: null, push: null, delivery: null, ...p });

console.log("1. defaults");
ok("no row ⇒ every default", JSON.stringify(effectiveSettings(null)) === JSON.stringify(DEFAULT_SETTINGS));
ok("all-NULL row ⇒ every default", JSON.stringify(effectiveSettings(EMPTY_SETTINGS)) === JSON.stringify(DEFAULT_SETTINGS));
ok("the defaults: push on, quiet 22:00–07:00, digest on at 08:00, lock-screen details off",
  DEFAULT_SETTINGS.pushEnabled && DEFAULT_SETTINGS.quietHoursEnabled && DEFAULT_SETTINGS.quietStartMinute === 1320 &&
  DEFAULT_SETTINGS.quietEndMinute === 420 && DEFAULT_SETTINGS.digestEnabled && DEFAULT_SETTINGS.digestMinute === 480 && !DEFAULT_SETTINGS.lockScreenDetails);
const s1 = effectiveSettings({ ...EMPTY_SETTINGS, digestMinute: 600, lockScreenDetails: true, pushEnabled: false });
ok("a stored value wins, the rest stay default", s1.digestMinute === 600 && s1.lockScreenDetails && !s1.pushEnabled && s1.quietStartMinute === 1320);

console.log("2. resolution order");
const D = effectiveSettings(null);
const inv = cat("inventory.critical_stock");
ok("catalog default", resolveCategory(inv, D, [], true).push === true && resolveCategory(inv, D, [], true).delivery === "instant");
ok("domain override turns push off", resolveCategory(inv, D, [pref("domain:inventory", { push: false })], true).push === false);
ok("category override beats the domain override",
  resolveCategory(inv, D, [pref("domain:inventory", { push: false }), pref("category:inventory.critical_stock", { push: true })], true).push === true);
ok("a NULL aspect is no override", resolveCategory(inv, D, [pref("category:inventory.critical_stock", { inApp: false })], true).push === true);
ok("delivery: digest by override", resolveCategory(inv, D, [pref("domain:inventory", { delivery: "digest" })], true).delivery === "digest");
ok("an unknown delivery value is ignored", resolveCategory(inv, D, [pref("domain:inventory", { delivery: "weekly" })], true).delivery === "instant");
ok("the master switch turns push off whatever the override says",
  resolveCategory(inv, { ...D, pushEnabled: false }, [pref("category:inventory.critical_stock", { push: true })], true).push === false);
ok("a domain override does not reach another domain", resolveCategory(cat("billing.failure"), D, [pref("domain:inventory", { push: false })], true).push === true);
const sec = cat("security.new_device");
ok("security in-app cannot be switched off", resolveCategory(sec, D, [pref("category:security.new_device", { inApp: false }), pref("domain:security", { inApp: false })], true).inApp === true);
ok("security push CAN be switched off", resolveCategory(sec, D, [pref("category:security.new_device", { push: false })], true).push === false);
ok("tasks.reminder delivery is not mutable (stays instant)", resolveCategory(cat("tasks.reminder"), D, [pref("category:tasks.reminder", { delivery: "digest" })], true).delivery === "instant");
ok("quiet bypass / rate exemption come from the catalog", resolveCategory(cat("tasks.reminder"), D, [], true).quietBypass && resolveCategory(cat("tasks.reminder"), D, [], true).rateExempt);

console.log("3. availability and unknown");
const prefs = [pref("category:inventory.critical_stock", { push: true, inApp: true })];
const off = resolveCategory(inv, D, prefs, false);
ok("feature unavailable ⇒ inactive (available false, no in-app, no push)", !off.available && !off.inApp && !off.push);
ok("…and the stored overrides are untouched", prefs.length === 1 && prefs[0].push === true);
const unk = resolveCategory(null, D, [], true);
ok("unknown category ⇒ in-app only, never push", unk.inApp && !unk.push && unk.key === "unknown");
const all = resolveAll(D, [], (c) => c.featureKey === null);
ok("resolveAll covers every catalog category", all.length === NOTIFICATION_CATEGORIES.length);
ok("resolveAll reports unavailable categories as unavailable", all.find((c) => c.key === "inventory.critical_stock")!.available === false && all.find((c) => c.key === "security.new_device")!.available === true);

console.log("4. read-side hiding");
ok("no overrides ⇒ nothing hidden", hiddenInAppCategories(D, []).length === 0);
ok("in-app off for a domain hides its categories",
  JSON.stringify(hiddenInAppCategories(D, [pref("domain:inventory", { inApp: false })]).sort()) === JSON.stringify(["inventory.attention", "inventory.critical_stock"]));
ok("security cannot be hidden", hiddenInAppCategories(D, [pref("domain:security", { inApp: false })]).length === 0);
ok("push off hides nothing", hiddenInAppCategories(D, [pref("domain:inventory", { push: false })]).length === 0);

console.log("5. validation");
const vs = (b: unknown) => validateSettingsPatch(b);
ok("a valid patch", vs({ pushEnabled: false, digestMinute: 540 }).ok);
ok("null = back to default", (() => { const r = vs({ quietStartMinute: null }); return r.ok && r.value.quietStartMinute === null; })());
ok("unknown field refused", !vs({ pushEnabled: true, userId: 5 }).ok);
ok("businessId refused", !vs({ businessId: 1 }).ok);
ok("wrong type refused", !vs({ pushEnabled: "yes" }).ok && !vs({ digestMinute: "480" }).ok);
ok("minute out of range refused", !vs({ quietEndMinute: 1440 }).ok && !vs({ quietEndMinute: -1 }).ok && !vs({ digestMinute: 1.5 }).ok);
ok("empty / non-object refused", !vs({}).ok && !vs([]).ok && !vs(null).ok && !vs("x").ok && !vs(undefined).ok);
const vk = (k: unknown) => validatePreferenceKey(k);
ok("category key accepted", vk("category:inventory.critical_stock").ok);
ok("domain key accepted and covers its categories", (() => { const r = vk("domain:inventory"); return r.ok && r.value.categories.length === 2; })());
ok("unknown category refused", !vk("category:inventory.nope").ok);
ok("unknown domain refused", !vk("domain:payroll").ok);
ok("malformed key refused", !vk("inventory").ok && !vk("user:5").ok && !vk("category:Inventory").ok && !vk(5).ok && !vk("domain:" + "a".repeat(80)).ok);
const vb = (b: unknown, k = "category:inventory.critical_stock") => { const key = vk(k); return key.ok ? validatePreferenceBody(b, key.value.categories) : key; };
ok("a valid body", vb({ push: false, delivery: "digest" }).ok);
ok("null aspects allowed", vb({ push: null }).ok);
ok("unknown field refused", !vb({ push: false, userId: 9 }).ok);
ok("wrong types refused", !vb({ push: "no" }).ok && !vb({ delivery: "weekly" }).ok);
ok("empty refused", !vb({}).ok);
ok("security in-app: NOT_MUTABLE", (() => { const r = vb({ inApp: false }, "category:security.new_device"); return !r.ok && r.error === "NOT_MUTABLE"; })());
ok("security push: allowed", vb({ push: false }, "category:security.new_device").ok);
ok("system.test push: NOT_MUTABLE", (() => { const r = vb({ push: false }, "category:system.test"); return !r.ok && r.error === "NOT_MUTABLE"; })());

console.log(`\n[preferences] PASS=${passed} FAIL=${failed}`);
if (failed > 0) process.exit(1);
