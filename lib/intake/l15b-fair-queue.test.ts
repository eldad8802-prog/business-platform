/**
 * Leads L1.5-b · PR-1 — held receipts never take the whole drain (the fair queue).
 * Pure suite. Run with:
 *   npx tsx lib/intake/l15b-fair-queue.test.ts
 *
 * Pins:
 *   - the lane split: each lane keeps min(its due, limit / 5) when the other is full; unused slots go to the other
 *     lane; never more than the limit
 *   - both lanes list exactly claimEvent's "due" (a live lease is never listed), held = lastErrorCode "held:*",
 *     fair by source (ready) and by connection (held), with UTC instants (session TimeZone cannot shift "due")
 *   - one look settles a connection only for hold codes, only that business / source / connection, only receipts
 *     already waiting on a hold and due now, at most SIBLING_BATCH per look, skipping rows a racing worker holds —
 *     attempts untouched; called only from the hydrate hold branch, and its failure never fails the receipt
 *   - every hold code carries the "held:" prefix the lanes and the sibling deferral match on
 * The DB halves (loads of 50 / 500 / 2,000 / 20,000 held with ready work alongside, racing sweeps, a live lease,
 * emergency release, RLS isolation, fairness between sources) run in .m6/held-fair-queue-battery.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HOLD_CODES } from "./acquisition/gate";
import { laneReserve, pickLanes, SIBLING_BATCH } from "./intake-event.store";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

console.log("\nLeads L1.5-b · PR-1 — fair queue — pure suite\n");

test("lane split: reserve, overflow, cap", () => {
  const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);
  const split = (r: number, h: number, l: number) => {
    const out = pickLanes(ids(r), ids(h, 1_000_000), l);
    const ready = out.filter((x) => x < 1_000_000).length;
    return [ready, out.length - ready];
  };
  assert.equal(laneReserve(50), 10);
  assert.equal(laneReserve(25), 5);
  assert.equal(laneReserve(1), 1);
  assert.deepEqual(split(100, 100, 50), [40, 10]); // both full: held keeps its fifth, ready the rest
  assert.deepEqual(split(100, 0, 50), [50, 0]); // nothing held: all to ready
  assert.deepEqual(split(0, 20_000, 50), [0, 50]); // nothing ready: all to held (release at full speed)
  assert.deepEqual(split(30, 20_000, 50), [30, 20]); // ready first, held gets the rest
  assert.deepEqual(split(45, 3, 50), [45, 3]);
  assert.deepEqual(split(100, 100, 25), [20, 5]); // the webhook-time drain's 25
  for (let r = 0; r <= 60; r += 7) for (let h = 0; h <= 60; h += 9) for (const l of [1, 4, 25, 50]) {
    const [gr, gh] = split(r, h, l);
    assert.ok(gr + gh <= l, "never above the limit");
    assert.ok(gr >= Math.min(r, l - Math.min(h, laneReserve(l))), "ready keeps all but the held reserve");
    assert.ok(gh >= Math.min(h, laneReserve(l)), "held keeps its reserve");
    assert.ok(gr + gh === Math.min(l, r + h), "no slot wasted");
  }
});

const store = read("lib/intake/intake-event.store.ts");
const lane = store.slice(store.indexOf("async function dueLane("), store.indexOf("export async function listDueEventIds("));
const siblings = store.slice(store.indexOf("export async function deferHeldSiblings("));
const DUE = `(e."status" = 'RECEIVED' AND e."nextAttemptAt" IS NULL)`;

test("both lanes list claimEvent's due, split on the held: prefix, fair, UTC", () => {
  assert.equal(lane.split(DUE).length - 1, 2, "both lanes carry the never-claimed condition");
  assert.equal(lane.split(`e."status" IN ('RECEIVED', 'PERSISTED', 'FAILED') AND e."nextAttemptAt" <= \${utc(now)}`).length - 1, 2);
  assert.match(lane, /e\."lastErrorCode" LIKE 'held:%'/);
  assert.match(lane, /e\."lastErrorCode" IS NULL OR e\."lastErrorCode" NOT LIKE 'held:%'/);
  assert.match(lane, /PARTITION BY e\."sourceKey", e\."providerAccountRef" ORDER BY e\."receivedAt", e\."id"/, "held: fair by connection");
  assert.match(lane, /PARTITION BY e\."sourceKey" ORDER BY e\."receivedAt", e\."id"/, "ready: fair by source");
  assert.match(lane, /e\."businessId" = \$\{businessId\}::int/);
  assert.match(store, /const utc = \(d: Date\) => Prisma\.sql`\(\$\{d\.toISOString\(\)\}::timestamptz AT TIME ZONE 'UTC'\)`/);
  // claimEvent's own due rule is unchanged (listing proposes; the lease decides).
  assert.match(store, /\{ status: "RECEIVED", nextAttemptAt: null \},\s*\{ status: \{ in: \["RECEIVED", "PERSISTED", "FAILED"\] \}, nextAttemptAt: \{ lte: now \} \}/);
});

test("one look settles only its own connection's due held receipts, attempts untouched", () => {
  assert.match(siblings, /if \(!code\.startsWith\("held:"\)\) return 0;/);
  for (const clause of [
    `"businessId" = \${businessId}::int`,
    `s."sourceKey" = \${probe.sourceKey}::text`,
    `s."providerAccountRef" IS NOT DISTINCT FROM \${probe.providerAccountRef}::text`,
    `s."id" <> \${probe.id}::int`,
    `s."lastErrorCode" LIKE 'held:%'`,
    `(s."status" = 'RECEIVED' AND s."nextAttemptAt" IS NULL)`,
    `s."nextAttemptAt" <= \${utc(now)}`,
    `LIMIT \${SIBLING_BATCH}::int`,
    "FOR UPDATE SKIP LOCKED",
    "WITH picked AS MATERIALIZED (",
    // re-checked on the row actually updated
    `AND e."businessId" = \${businessId}::int`,
    `AND e."lastErrorCode" LIKE 'held:%'`,
    `(e."status" = 'RECEIVED' AND e."nextAttemptAt" IS NULL)`,
    `e."nextAttemptAt" <= \${utc(now)}`,
  ]) assert.ok(siblings.includes(clause), clause);
  assert.match(siblings, /set_config\('statement_timeout', \$\{String\(SIBLING_STATEMENT_TIMEOUT_MS\)\}, true\)/, "server-side ceiling, local to the transaction");
  assert.match(store, /const SIBLING_STATEMENT_TIMEOUT_MS = (\d+);/);
  assert.ok(Number(/const SIBLING_STATEMENT_TIMEOUT_MS = (\d+);/.exec(store)![1]) < 5000, "inside the 5 s transaction timeout");
  assert.ok(SIBLING_BATCH > 0 && SIBLING_BATCH <= 1000, "bounded per look");
  assert.doesNotMatch(siblings.slice(0, siblings.indexOf("\n}\n")), /"attempts"/, "no attempt is spent or refunded");
  assert.match(siblings, /withTenantTransaction/, "under the business's RLS");
});

test("the processor settles siblings only from the hydrate hold branch", () => {
  const proc = read("lib/intake/core/processor.ts");
  assert.equal(proc.split("deferHeldSiblings(").length - 1, 1);
  const hydrate = proc.slice(proc.indexOf("const h = await adapter.hydrate(ctx, event);"), proc.indexOf('if (h.kind === "ignored")'));
  assert.match(hydrate, /await markDeferred\(businessId, event, h\.until, h\.code\);[\s\S]*const siblings = await deferHeldSiblings\(businessId, event, h\.until, h\.code, now\)\.catch\(/);
  assert.match(hydrate, /logIntake\("hold_siblings_failed", \{ \.\.\.base, code: errorCodeOf\(error\) \}\);\s*return 0;/, "a failure settling siblings never fails the receipt");
});

test("every hold code carries the held: prefix", () => {
  for (const code of Object.values(HOLD_CODES)) assert.ok(code.startsWith("held:"), code);
});

console.log(`\nALL L1.5-b FAIR-QUEUE TESTS PASSED — ${checks} checks\n`);
