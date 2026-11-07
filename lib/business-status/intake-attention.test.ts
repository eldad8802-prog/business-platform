/**
 * Leads L1.5-b · PR-3 — the owner's view of the intake of their own leads.
 * Pure suite. Run with:
 *   npx tsx lib/business-status/intake-attention.test.ts
 *
 * Pins:
 *   - one item per situation, per connection: paused (at risk after 7 days), not included, Dubiz hold, connection to
 *     check, failed, pending (only after 30 min and never beside a hold); a revoked connection only reports failures
 *   - wording: counts only; a waiting enquiry is never called a lead; stores say הזמנות, phone lines שיחות; capped
 *     counts read "N+"; no endpoint id, key, provider id or error code ever reaches the text
 *   - the home screen: intake items are urgent only when HIGH, never counted in the לידים badge, open the
 *     connections screen
 *   - gating: the loader returns nothing unless intake_status_visibility, fails open, caches per business; the
 *     connections API adds `waiting` only when the loader answered
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { nounOf, translateIntakeAttention, waitingByConnection, type IntakeConnectionRow } from "./intake-attention";
import { totalsOf, type BusinessBacklog, type ConnectionBacklog } from "../intake/intake-capacity";
import { buildWaiting, leadsWaitingClaim } from "../../features/home/v3/home-v3-model";
import { finalizeBusinessStatusItem } from "./priority";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const NOW = new Date("2026-11-07T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const conn = (id: number, sourceKey: string, status: string, extra: Partial<IntakeConnectionRow> = {}): IntakeConnectionRow =>
  ({ id, sourceKey, status, publicId: `PUB${id}xxxxxxxxxxxxxxxxxxxxxxxxxxx`, externalResourceId: null, label: null, ...extra });
const cb = (sourceKey: string, ref: string, p: Partial<ConnectionBacklog>): ConnectionBacklog =>
  ({ sourceKey, providerAccountRef: ref, held: 0, heldByReason: {}, due: 0, retrying: 0, deadLetters: 0, oldestHeldAt: null, oldestUnfinishedAt: null, ...p });
const backlog = (connections: ConnectionBacklog[], capped = false): BusinessBacklog =>
  ({ connections, totals: totalsOf(connections), oldestHeldAt: null, capped });

console.log("\nLeads L1.5-b · PR-3 — owner intake status — pure suite\n");

const web = conn(1, "web.form", "PAUSED");
const g = conn(2, "google.lead_form", "ACTIVE");
const meta = conn(3, "meta.lead_ads", "ACTIVE", { externalResourceId: "PAGE123" });
const woo = conn(4, "commerce.woocommerce", "ERROR");
const vc = conn(5, "telephony.voicenter", "REVOKED");
const items = translateIntakeAttention({
  connections: [web, g, meta, woo, vc],
  backlog: backlog([
    cb("web.form", web.publicId, { held: 12, heldByReason: { connection_paused: 12 }, oldestHeldAt: new Date(NOW.getTime() - 8 * DAY), oldestUnfinishedAt: new Date(NOW.getTime() - 8 * DAY) }),
    cb("google.lead_form", g.publicId, { held: 3, heldByReason: { source_disabled: 3 }, deadLetters: 2, oldestHeldAt: new Date(NOW.getTime() - DAY), oldestUnfinishedAt: new Date(NOW.getTime() - 2 * DAY) }),
    cb("meta.lead_ads", "PAGE123", { held: 5, heldByReason: { emergency_disabled: 5 }, oldestHeldAt: new Date(NOW.getTime() - 3600_000) }),
    cb("commerce.woocommerce", woo.publicId, { due: 4, oldestUnfinishedAt: new Date(NOW.getTime() - 3600_000) }),
    cb("telephony.voicenter", vc.publicId, { deadLetters: 1, held: 0, oldestUnfinishedAt: new Date(NOW.getTime() - DAY) }),
  ]),
}, NOW);
const byId = new Map(items.map((i) => [i.itemId, i]));

test("one item per situation, per connection", () => {
  assert.deepEqual(items.map((i) => i.itemId).sort(), [
    "leads:intake_check_connection:4", "leads:intake_failed:2", "leads:intake_failed:5", "leads:intake_not_included:2",
    "leads:intake_paused:1", "leads:intake_pending:4", "leads:intake_platform_hold:3",
  ].sort());
  const p = byId.get("leads:intake_paused:1")!;
  assert.equal(p.semanticCategory, "ACTION_REQUIRED");
  assert.equal(p.severity, "HIGH", "waiting 8 days ≥ 7 → at risk");
  assert.equal(p.title, "יש 12 פניות שממתינות לחידוש החיבור");
  assert.match(p.summary!, /טופס האתר מושהה\. הוותיקה ביותר ממתינה כבר 8 ימים\./);
  assert.equal(byId.get("leads:intake_platform_hold:3")!.semanticCategory, "WARNING");
  assert.equal(byId.get("leads:intake_failed:2")!.semanticCategory, "FAILURE_EVENT");
  assert.equal(byId.get("leads:intake_check_connection:4")!.severity, "HIGH");
  assert.equal(byId.get("leads:intake_pending:4")!.severity, "LOW");
  for (const i of items) {
    assert.equal(i.domain, "leads");
    assert.equal(i.primaryAction.href, "/settings/connections");
    assert.equal(i.entityRef.type, "intake_connection");
  }
});

test("severity: under 7 days a pause is MEDIUM; pending needs 30 min and no hold", () => {
  const fresh = translateIntakeAttention({ connections: [web], backlog: backlog([cb("web.form", web.publicId, { held: 1, heldByReason: { connection_paused: 1 }, oldestHeldAt: new Date(NOW.getTime() - 2 * DAY) })]) }, NOW);
  assert.equal(fresh[0].severity, "MEDIUM");
  assert.equal(fresh[0].title, "יש 1 פנייה שממתינה לחידוש החיבור");
  const young = translateIntakeAttention({ connections: [g], backlog: backlog([cb("google.lead_form", g.publicId, { due: 3, oldestUnfinishedAt: new Date(NOW.getTime() - 10 * 60_000) })]) }, NOW);
  assert.equal(young.length, 0, "10 minutes in processing is normal — nothing to say");
});

test("wording: never 'ליד', the right noun, capped counts, no internal identifier", () => {
  for (const i of items) {
    const text = `${i.title} ${i.summary ?? ""}`;
    assert.doesNotMatch(text, /ליד/, `${i.itemId}: a waiting enquiry is not a lead`);
    assert.doesNotMatch(text, /PUB\d|PAGE123|held:|error:|prisma|connection_|source_disabled|emergency|webhook/i, `${i.itemId}: no internal identifier`);
  }
  assert.match(byId.get("leads:intake_check_connection:4")!.summary!, /חנות WooCommerce/);
  assert.equal(nounOf("commerce.wix").many, "הזמנות");
  assert.equal(nounOf("telephony.cloudtalk").many, "שיחות");
  assert.equal(nounOf("web.form").many, "פניות");
  assert.match(byId.get("leads:intake_failed:5")!.summary!, /^1 שיחה מ־Voicenter לא נקלטו/);
  const capped = translateIntakeAttention({ connections: [web], backlog: backlog([cb("web.form", web.publicId, { held: 2500, heldByReason: { connection_paused: 2500 } })], true) }, NOW);
  assert.equal(capped[0].title, "יש 2,500+ פניות שממתינות לחידוש החיבור");
});

test("a revoked connection only reports what failed", () => {
  const r = items.filter((i) => i.itemId.endsWith(":5"));
  assert.deepEqual(r.map((i) => i.itemId), ["leads:intake_failed:5"]);
});

test("connections screen counts per connection (resource-ref sources by their Page / site id)", () => {
  const w = waitingByConnection([web, g, meta], backlog([
    cb("web.form", web.publicId, { held: 12, heldByReason: { connection_paused: 12 } }),
    cb("meta.lead_ads", "PAGE123", { held: 5, heldByReason: { emergency_disabled: 5 }, deadLetters: 1 }),
  ]));
  assert.deepEqual(w.get(1), { held: 12, paused: 12, platform: 0, notIncluded: 0, failed: 0, capped: false });
  assert.deepEqual(w.get(3), { held: 5, paused: 0, platform: 5, notIncluded: 0, failed: 1, capped: false });
  assert.equal(w.get(2), undefined);
});

test("home: intake items keep their own tag and never count as leads", () => {
  const status = items.map(finalizeBusinessStatusItem);
  const model = buildWaiting({ briefing: null, status, collectionWaiting: null, now: NOW });
  const paused = model.items.find((i) => i.id === "leads:intake_paused:1")!;
  assert.equal(paused.tag.label, "דחוף");
  assert.equal(paused.href, "/settings/connections");
  assert.equal(paused.actionLabel, "להפעלה");
  const hold = model.items.find((i) => i.id === "leads:intake_platform_hold:3")!;
  assert.notEqual(hold.tag.label, "דחוף");
  assert.equal(leadsWaitingClaim(status).n, 0, "the לידים badge counts leads only");
});

test("gating, fail-open, cache; the API adds waiting only when the loader answered", () => {
  const mod = read("lib/business-status/intake-attention.ts");
  const loader = mod.slice(mod.indexOf("export async function loadIntakeAttention("), mod.indexOf("/** What the connections screen shows"));
  assert.match(loader, /resolveFeatureAccess\(businessId, PLATFORM_FEATURE_KEYS\.INTAKE_STATUS_VISIBILITY\)/);
  assert.match(loader, /if \(!access\.allowed\) return \[\];/);
  assert.match(loader, /\} catch \{\s*return \[\];\s*\}/);
  assert.match(loader, /intakeBacklog\(businessId, now, \{ scanCap: OWNER_SCAN_CAP \}\)/);
  assert.match(loader, /now\.getTime\(\) - hit\.at < CACHE_TTL_MS/);
  const svc = read("lib/business-status/business-status.service.ts");
  assert.match(svc, /loadIntakeAttention\(businessId, now\)/);
  assert.match(svc, /\.\.\.intakeItems,/);
  const route = read("app/api/integrations/acquisition/route.ts");
  assert.match(route, /const waiting = await loadConnectionWaiting\(businessId, connections\);/);
  assert.match(route, /\.\.\.\(waiting \? \{ waiting: waiting\.get\(c\.id\) \?\? null \} : \{\}\),/);
  const catalog = read("lib/services/feature-access/platform-feature-catalog.ts");
  assert.match(catalog, /key: PLATFORM_FEATURE_KEYS\.INTAKE_STATUS_VISIBILITY,[\s\S]{0,400}defaultEnabled: false,/);
  assert.doesNotMatch(read("app/(shell)/secretary/page.tsx").concat(""), /intake-attention|loadIntakeAttention/, "never the Secretary");
});

console.log(`\nALL L1.5-b OWNER INTAKE STATUS TESTS PASSED — ${checks} checks\n`);
