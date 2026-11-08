/**
 * Leads L1.5-b · PR-4 — owner notifications about the intake of their own leads.
 * Pure suite. Run with:
 *   npx tsx lib/notifications/intake-notifications.verify.test.ts
 *
 * Pins:
 *   - the facts: the home screen's (same translator) plus an abnormal backlog (≥ 1,000 waiting) and a recovery (taken
 *     in during the last hour, nothing waiting any more)
 *   - the decision: the policy is UNCHANGED — intake facts ride the existing leads rules (in-app, 24 h); never PUSH;
 *     a Dubiz hold, "still processing" and a recovery are silent; each situation has its own dedupe key
 *   - the sync: gated by intake_status_visibility, resolves only after a complete (uncapped) read, never throws, and
 *     runs from the sweep's own capacity read
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HELD_BACKLOG_NOTIFY, INTAKE_NOTIFICATION_SCOPE, intakeNotificationItems } from "./intake-notifications";
import { buildDedupeKey, decideNotification } from "./notification-policy";
import { finalizeBusinessStatusItem } from "../business-status/priority";
import { totalsOf, type BusinessBacklog, type ConnectionBacklog } from "../intake/intake-capacity";
import type { IntakeConnectionRow } from "../business-status/intake-attention";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const MIDDAY = new Date("2026-11-07T10:00:00Z"); // 12:00 Israel — outside quiet hours
const BIZ = 9;
const DAY = 86_400_000;

const conn = (id: number, sourceKey: string, status: string): IntakeConnectionRow =>
  ({ id, sourceKey, status, publicId: `P${id}xxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, externalResourceId: null, label: null });
const cb = (sourceKey: string, ref: string, p: Partial<ConnectionBacklog>): ConnectionBacklog =>
  ({ sourceKey, providerAccountRef: ref, held: 0, heldByReason: {}, due: 0, retrying: 0, deadLetters: 0, oldestHeldAt: null, oldestUnfinishedAt: null, ...p });
const bl = (c: ConnectionBacklog[], capped = false): BusinessBacklog => ({ connections: c, totals: totalsOf(c), oldestHeldAt: null, capped });

console.log("\nLeads L1.5-b · PR-4 — intake notifications — pure suite\n");

const web = conn(1, "web.form", "PAUSED");
const g = conn(2, "google.lead_form", "ERROR");
const m = { ...conn(3, "meta.lead_ads", "ACTIVE"), externalResourceId: "PAGE9" };
const all = intakeNotificationItems(BIZ, [web, g, m], bl([
  cb("web.form", web.publicId, { held: 1200, heldByReason: { connection_paused: 1200 }, oldestHeldAt: new Date(MIDDAY.getTime() - 8 * DAY) }),
  cb("google.lead_form", g.publicId, { deadLetters: 2, due: 3, oldestUnfinishedAt: new Date(MIDDAY.getTime() - DAY) }),
  cb("meta.lead_ads", "PAGE9", { held: 4, heldByReason: { emergency_disabled: 4 } }),
]), { receivedLastHour: 1, receivedLastDay: 9, processedLastHour: 2, recoveredLastHour: 2, capped: false }, MIDDAY).map(finalizeBusinessStatusItem);

test("facts: the translator's plus an abnormal backlog; no recovery while enquiries still wait", () => {
  const ids = all.map((i) => i.itemId).sort();
  assert.ok(ids.includes(`leads:intake_backlog:${BIZ}`), "1,204 waiting ≥ 1,000");
  assert.ok(!ids.includes(`leads:intake_recovered:${BIZ}`), "something still waits — not a recovery yet");
  assert.ok(ids.includes("leads:intake_paused:1") && ids.includes("leads:intake_failed:2") && ids.includes("leads:intake_check_connection:2") && ids.includes("leads:intake_platform_hold:3"));
  assert.equal(HELD_BACKLOG_NOTIFY, 1000);
  const rec = intakeNotificationItems(BIZ, [], bl([]), { receivedLastHour: 0, receivedLastDay: 0, processedLastHour: 5, recoveredLastHour: 5, capped: false }, MIDDAY);
  assert.deepEqual(rec.map((i) => i.itemId), [`leads:intake_recovered:${BIZ}`]);
  assert.equal(rec[0].title, "5 פניות שהמתינו נקלטו בהצלחה");
  for (const i of all) for (const t of [i.title, i.summary ?? ""]) assert.doesNotMatch(t, /held:|error:|P\d+x|webhook|prisma/i);
});

test("decision: in-app only or silent — never push; info / warning / action told apart", () => {
  const d = new Map(all.map((i) => [i.itemId, decideNotification(BIZ, i, MIDDAY)]));
  for (const [id, dec] of d) {
    if (dec.notify) assert.deepEqual(dec.channels, ["IN_APP"], `${id}: never push`);
  }
  assert.equal(d.get("leads:intake_paused:1")!.notify, true);
  assert.equal(d.get("leads:intake_failed:2")!.notify, true);
  assert.equal(d.get("leads:intake_check_connection:2")!.notify, true);
  assert.equal(d.get(`leads:intake_backlog:${BIZ}`)!.notify, true);
  assert.equal(d.get("leads:intake_platform_hold:3")!.notify, false, "a Dubiz hold — nothing to do, home only");
  const rec = intakeNotificationItems(BIZ, [], bl([]), { receivedLastHour: 0, receivedLastDay: 0, processedLastHour: 1, recoveredLastHour: 1, capped: false }, MIDDAY).map(finalizeBusinessStatusItem);
  const r = decideNotification(BIZ, rec[0], MIDDAY);
  assert.equal(r.notify, false, "a recovery stays silent until a rule for it is approved");
  assert.equal(rec[0].severity, "INFO");
  assert.equal(all.find((i) => i.itemId === "leads:intake_failed:2")!.semanticCategory, "ACTION_REQUIRED", "not taken in rides the existing rule");
  assert.equal(all.find((i) => i.itemId === "leads:intake_paused:1")!.semanticCategory, "ACTION_REQUIRED");
});

test("each situation is its own fact (dedupe key), inside the resolution scope", () => {
  const keys = all.map((i) => buildDedupeKey(BIZ, i));
  assert.equal(new Set(keys).size, keys.length, "two situations on one connection never merge");
  for (const i of all) assert.ok((INTAKE_NOTIFICATION_SCOPE.entityTypes as readonly string[]).includes(i.entityRef.type), i.entityRef.type);
});

test("a paused source outside the plan is never offered \"resume\" (same as the home screen)", () => {
  const b = bl([cb("web.form", web.publicId, { held: 6, heldByReason: { connection_paused: 6 }, oldestHeldAt: new Date(MIDDAY.getTime() - DAY) })]);
  const out = intakeNotificationItems(BIZ, [web], b, null, MIDDAY, { "web.form": false }).find((i) => i.itemId === "leads:intake_paused:1")!;
  assert.equal(out.primaryAction?.label, "לפרטים");
  const inPlan = intakeNotificationItems(BIZ, [web], b, null, MIDDAY, { "web.form": true }).find((i) => i.itemId === "leads:intake_paused:1")!;
  assert.equal(inPlan.primaryAction?.label, "להפעלה");
  const mod = read("lib/notifications/intake-notifications.ts");
  assert.match(mod, /Promise\.all\(\[listConnections\(\), enabledSources\(businessId\)\]\)/, "the sync reads the plan's sources");
});

test("sync: gated, resolves only after a complete read, never throws, runs from the sweep", () => {
  const mod = read("lib/notifications/intake-notifications.ts");
  const sync = mod.slice(mod.indexOf("export async function syncIntakeNotifications("));
  assert.match(sync, /resolveFeatureAccess\(businessId, PLATFORM_FEATURE_KEYS\.INTAKE_STATUS_VISIBILITY\)/);
  assert.match(sync, /if \(!access\.allowed\) return \{ ok: true, skipped: "feature_off"/);
  assert.match(sync, /const resolved = backlog\.capped\s*\? 0\s*: await resolveAbsentNotifications\(/);
  assert.match(sync, /\} catch \(error\) \{[\s\S]*return \{ ok: false/);
  const sweeper = read("lib/intake/intake-sweeper.ts");
  assert.match(sweeper, /const f = await intakeFlow\(businessId, now\);\s*\/\/[^\n]*\n\s*await syncIntakeNotifications\(businessId, b, f, now\);/);
  const policy = read("lib/notifications/notification-policy.ts");
  const leadsRules = policy.slice(policy.indexOf("// ── Leads"), policy.indexOf("// ── Inbox"));
  assert.doesNotMatch(leadsRules, /"PUSH"/, "no leads rule grants push");
  assert.doesNotMatch(leadsRules, /ruleKey\("leads", "(FAILURE_EVENT|WARNING|ALERT)"/, "the policy is unchanged: no new leads rule");
  assert.match(read("lib/notifications/notification-policy.verify.test.ts"), /notifying <= 12,/, "the matrix guard is unchanged");
});

console.log(`\nALL L1.5-b INTAKE NOTIFICATION TESTS PASSED — ${checks} checks\n`);
