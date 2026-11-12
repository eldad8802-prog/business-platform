/**
 * The push worker's decisions — pure (no database, no clock of its own).
 *
 *   npx tsx lib/notifications/engine/worker-decision.test.ts
 *
 *  1. Expiry: a row with expiresAt keeps it; a row written before the engine (no expiresAt) expires its category's
 *     TTL after creation — a week-old historical PENDING push is expired, never sent.
 *  2. The decision table, in the spec's order: resolved / dismissed → expired → unknown → feature off → preference
 *     off → digest mode → quiet hours (defer to their end; held for the digest when that is past the expiry; bypass
 *     for user-set reminders) → rate limit (exempt categories skip) → send.
 *  3. The rate limit: 4 per rolling hour, 15 per rolling 24 h; older sends do not count.
 *  4. Retries: 1 m, 5 m, 15 m, 1 h, then the 5th failure ends it.
 *  5. Devices: FCM only with a live session; session-bound web push only while live; legacy web push (no session)
 *     allowed; unconfigured providers skipped; unknown providers never.
 */
import { getCategory } from "../catalog";
import { effectiveSettings, resolveCategory } from "../preferences";
import { MAX_ATTEMPTS, decideOwed, effectiveExpiry, eligibleDevices, rateLimited, retryAfter, type OwedFacts } from "./worker-decision";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}`, detail ?? ""); }
}
const J = "Asia/Jerusalem";
const NOON = new Date("2026-01-15T10:00:00Z"); // 12:00 Jerusalem
const NIGHT = new Date("2026-01-15T21:30:00Z"); // 23:30 Jerusalem
const min = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const D = effectiveSettings(null);
const QUIET = { enabled: true, startMinute: D.quietStartMinute, endMinute: D.quietEndMinute };

function facts(over: Partial<OwedFacts> & { key?: string; available?: boolean } = {}): OwedFacts {
  const cat = over.category !== undefined ? over.category : getCategory(over.key ?? "inventory.critical_stock");
  return {
    now: NOON,
    notification: { resolvedAt: null, dismissedAt: null },
    expiresAt: min(NOON, 360),
    category: cat,
    effective: over.effective ?? resolveCategory(cat, D, [], over.available ?? true),
    quiet: QUIET,
    timeZone: J,
    recentSends: [],
    ...over,
  };
}

console.log("1. expiry");
const inv = getCategory("inventory.critical_stock")!;
ok("expiresAt is kept", effectiveExpiry({ expiresAt: min(NOON, 5), createdAt: min(NOON, -10_000) }, inv).getTime() === min(NOON, 5).getTime());
ok("no expiresAt ⇒ createdAt + the category TTL", effectiveExpiry({ expiresAt: null, createdAt: NOON }, inv).getTime() === min(NOON, inv.ttlMinutes).getTime());
ok("unknown category ⇒ 60 minutes", effectiveExpiry({ expiresAt: null, createdAt: NOON }, null).getTime() === min(NOON, 60).getTime());
const weekOld = effectiveExpiry({ expiresAt: null, createdAt: min(NOON, -7 * 24 * 60) }, inv);
ok("a week-old historical PENDING push is EXPIRED, never sent", decideOwed(facts({ expiresAt: weekOld })).kind === "expire");

console.log("2. the decision table");
ok("send at noon", decideOwed(facts()).kind === "send");
ok("resolved ⇒ suppress resolved", JSON.stringify(decideOwed(facts({ notification: { resolvedAt: NOON, dismissedAt: null } }))) === JSON.stringify({ kind: "suppress", reason: "resolved" }));
ok("dismissed ⇒ suppress resolved", (decideOwed(facts({ notification: { resolvedAt: null, dismissedAt: NOON } })) as { reason?: string }).reason === "resolved");
ok("resolved wins over expired", (decideOwed(facts({ notification: { resolvedAt: NOON, dismissedAt: null }, expiresAt: min(NOON, -1) })) as { reason?: string }).reason === "resolved");
ok("expired ⇒ expire", decideOwed(facts({ expiresAt: NOON })).kind === "expire");
ok("unknown ⇒ suppress unknown_category", (decideOwed(facts({ category: null })) as { reason?: string }).reason === "unknown_category");
ok("feature unavailable ⇒ feature_off", (decideOwed(facts({ available: false })) as { reason?: string }).reason === "feature_off");
const prefOff = resolveCategory(inv, D, [{ key: "category:inventory.critical_stock", inApp: null, push: false, delivery: null }], true);
ok("preference push off ⇒ pref_off", (decideOwed(facts({ effective: prefOff })) as { reason?: string }).reason === "pref_off");
const masterOff = resolveCategory(inv, { ...D, pushEnabled: false }, [], true);
ok("master switch off ⇒ pref_off", (decideOwed(facts({ effective: masterOff })) as { reason?: string }).reason === "pref_off");
const digestMode = resolveCategory(inv, D, [{ key: "domain:inventory", inApp: null, push: null, delivery: "digest" }], true);
ok("digest mode ⇒ to_digest", (decideOwed(facts({ effective: digestMode })) as { reason?: string }).reason === "to_digest");
const night = decideOwed(facts({ now: NIGHT, expiresAt: min(NIGHT, 12 * 60) }));
ok("quiet hours ⇒ defer to 07:00 local (05:00Z)", night.kind === "defer" && night.until.toISOString() === "2026-01-16T05:00:00.000Z", night);
ok("quiet end past the expiry ⇒ held for the digest (quiet)", (decideOwed(facts({ now: NIGHT, expiresAt: min(NIGHT, 60) })) as { reason?: string }).reason === "quiet");
ok("quiet hours disabled ⇒ send at night", decideOwed(facts({ now: NIGHT, quiet: { ...QUIET, enabled: false }, expiresAt: min(NIGHT, 60) })).kind === "send");
ok("a user-set reminder bypasses quiet hours", decideOwed(facts({ key: "tasks.reminder", now: NIGHT, expiresAt: min(NIGHT, 60) })).kind === "send");
ok("a money category does NOT bypass quiet hours", decideOwed(facts({ key: "billing.failure", now: NIGHT, expiresAt: min(NIGHT, 12 * 60) })).kind === "defer");
const four = [1, 2, 3, 4].map((i) => min(NOON, -i * 10));
ok("4 sends in the last hour ⇒ rate_limited", (decideOwed(facts({ recentSends: four })) as { reason?: string }).reason === "rate_limited");
ok("…but a user-set reminder is exempt", decideOwed(facts({ key: "tasks.reminder", recentSends: four })).kind === "send");
ok("…and so is a critical security alert", decideOwed(facts({ key: "security.new_device", recentSends: four })).kind === "send");
ok("3 in the last hour ⇒ send", decideOwed(facts({ recentSends: four.slice(0, 3) })).kind === "send");
ok("quiet is decided before the rate limit (deferred, not dropped)", decideOwed(facts({ now: NIGHT, expiresAt: min(NIGHT, 12 * 60), recentSends: [1, 2, 3, 4].map((i) => min(NIGHT, -i)) })).kind === "defer");

console.log("3. the rate limit");
ok("empty ⇒ not limited", !rateLimited([], NOON));
ok("4 within the hour ⇒ limited", rateLimited(four, NOON));
ok("4 more than an hour ago, 14 in the day ⇒ not limited", !rateLimited(Array.from({ length: 14 }, (_, i) => min(NOON, -61 - i * 30)), NOON));
ok("15 within 24 h (none in the last hour) ⇒ limited", rateLimited(Array.from({ length: 15 }, (_, i) => min(NOON, -61 - i * 60)), NOON));
ok("sends older than 24 h do not count", !rateLimited(Array.from({ length: 30 }, (_, i) => min(NOON, -25 * 60 - i)), NOON));

console.log("4. retries");
ok("1st failure → +1 m", retryAfter(1, NOON)!.getTime() === min(NOON, 1).getTime());
ok("2nd → +5 m, 3rd → +15 m, 4th → +60 m",
  retryAfter(2, NOON)!.getTime() === min(NOON, 5).getTime() && retryAfter(3, NOON)!.getTime() === min(NOON, 15).getTime() && retryAfter(4, NOON)!.getTime() === min(NOON, 60).getTime());
ok(`the ${MAX_ATTEMPTS}th failure ends it`, MAX_ATTEMPTS === 5 && retryAfter(5, NOON) === null && retryAfter(9, NOON) === null);

console.log("5. devices");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const devs = [
  { id: 1, provider: "FCM", authSessionId: S1 },
  { id: 2, provider: "FCM", authSessionId: S2 },
  { id: 3, provider: "FCM", authSessionId: null },
  { id: 4, provider: "WEB_PUSH", authSessionId: null },
  { id: 5, provider: "WEB_PUSH", authSessionId: S2 },
  { id: 6, provider: "WEB_PUSH", authSessionId: S1 },
  { id: 7, provider: "APNS", authSessionId: S1 },
];
const live = new Set([S1]);
ok("FCM live / legacy web / live web only", JSON.stringify(eligibleDevices(devs, live, () => true).map((d) => d.id)) === JSON.stringify([1, 4, 6]));
ok("no live session ⇒ only legacy web push", JSON.stringify(eligibleDevices(devs, new Set(), () => true).map((d) => d.id)) === JSON.stringify([4]));
ok("FCM not configured ⇒ skipped", JSON.stringify(eligibleDevices(devs, live, (p) => p === "WEB_PUSH").map((d) => d.id)) === JSON.stringify([4, 6]));
ok("nothing configured ⇒ nothing", eligibleDevices(devs, live, () => false).length === 0);

console.log(`\n[worker-decision] PASS=${passed} FAIL=${failed}`);
if (failed > 0) process.exit(1);
