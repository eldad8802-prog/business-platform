/**
 * Leads L1.5-b · A1 — an EXPIRED held receipt is archived, never a dead letter (classification only; nothing expires
 * yet — the expiry itself is a later PR, switched off).
 * Pure suite. Run with:
 *   npx tsx lib/intake/l15b-expired.test.ts
 *
 * Pins:
 *   - "expired:<reason>" is the one marker; a null / other code is not expired
 *   - the processor settles an expiry as "expired" (logged, sensed, tallied) — never as a failed receipt / dead letter
 *   - a run that only expired receipts stays healthy (no failed_receipts, no dead_letters_new)
 *   - EVERY dead-letter predicate in the store excludes expired receipts (health report + open count, the retention
 *     purge, the open-backlog read), so the owner never sees "could not be taken in" for them and the dead-letter
 *     retention never deletes their payload
 * The DB halves (real rows, real processor, health / backlog / purge / sweep) run in .m6/expired-battery.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EXPIRED_PREFIX, isExpiredCode, NOT_EXPIRED_WHERE } from "./core/expired";
import { deriveIntakeState } from "./core/trace";
import { emptyTally } from "./core/processor";
import { emptyCapacity, sweepHealth, wantsReleaseRound, type IntakeSweepReport } from "./intake-sweeper";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

console.log("\nLeads L1.5-b · A1 — expired receipts are archived — pure suite\n");

test("the marker", () => {
  assert.equal(EXPIRED_PREFIX, "expired:");
  assert.equal(isExpiredCode("expired:connection_paused"), true);
  for (const c of [null, undefined, "", "error:Error", "held:connection_paused", "unknown_source", "xexpired:"]) assert.equal(isExpiredCode(c), false, String(c));
  assert.deepEqual(NOT_EXPIRED_WHERE, { OR: [{ lastErrorCode: null }, { NOT: { lastErrorCode: { startsWith: "expired:" } } }] });
});

test("trace: an expired receipt reads as expired, a dead letter still as dead_letter", () => {
  const now = new Date("2026-11-08T10:00:00Z");
  const base = { status: "FAILED", nextAttemptAt: null, lastAttemptAt: now };
  assert.equal(deriveIntakeState({ ...base, lastErrorCode: "expired:source_disabled" }, now), "expired");
  assert.equal(deriveIntakeState({ ...base, lastErrorCode: "error:Error" }, now), "dead_letter");
  assert.equal(deriveIntakeState({ ...base, lastErrorCode: null }, now), "dead_letter");
  assert.equal(deriveIntakeState(base, now), "dead_letter", "callers that do not pass the code keep today's answer");
});

test("processor: an expiry is settled as expired — before, and instead of, the dead-letter log / sensor / tally", () => {
  const proc = read("lib/intake/core/processor.ts");
  const branch = proc.slice(proc.indexOf("if (error instanceof IntakeTerminalError) {"), proc.indexOf("const code = errorCodeOf(error);"));
  const expiredAt = branch.indexOf("if (isExpiredCode(error.code)) {");
  assert.ok(expiredAt > 0 && expiredAt < branch.indexOf('logIntake("dead_letter"'), "the expiry branch comes first");
  assert.match(branch, /if \(isExpiredCode\(error\.code\)\) \{\s*logIntake\("expired", \{ \.\.\.base, code: error\.code \}\);\s*await emitSettled\(event, "expired", null, now\);\s*return "expired";\s*\}/);
  assert.equal(emptyTally().expired, 0);
});

test("health: a run that only expired receipts is healthy; expiries count as progress for release rounds", () => {
  const r: IntakeSweepReport = {
    businesses: 1, quarantinedSkipped: 0, businessErrors: 0, events: { ...emptyTally(), expired: 40 }, payloadsPurged: 0,
    commerce: { receipts: 0, webhooksReactivated: 0, failures: 0 },
    revenueSources: { receipts: 0, unreadable: 0, failures: 0, calls: 0 },
    backlog: { deadLettersNew: 0, deadLettersOpen: 0, pendingStale: 0, pendingStaleNew: 0, held: 0, businessesNeedingAttention: 0 },
    capacity: emptyCapacity(),
  };
  assert.deepEqual(sweepHealth(r), { ok: true, job: [], events: [] });
  assert.equal(wantsReleaseRound({ ...emptyTally(), expired: 50 }, 50), true);
});

const store = read("lib/intake/intake-event.store.ts");
const fn = (name: string, next: string) => store.slice(store.indexOf(`export async function ${name}(`), store.indexOf(next));

test("store: every dead-letter predicate excludes expired receipts", () => {
  const health = fn("intakeHealthCounts", "export const FAILED_PAYLOAD_RETENTION_MS");
  assert.match(health, /const deadLetter = \{ businessId, status: "FAILED" as const, nextAttemptAt: null, \.\.\.NOT_EXPIRED_WHERE \};/, "open count");
  assert.match(health, /d\."status" = 'FAILED' AND d\."nextAttemptAt" IS NULL\s*AND \$\{notExpiredSql\("d"\)\}/, "reported once");
  const purge = fn("purgeExpiredFailedPayloads", "export function laneReserve(");
  assert.match(purge, /payloadPurgedAt: null,[\s\S]*\.\.\.NOT_EXPIRED_WHERE,\s*\},\s*data: \{ payload: Prisma\.DbNull/, "the retention never purges an expired payload");
  const backlog = fn("intakeBacklog", "export async function intakeFlow(");
  assert.match(backlog, /AND \(e\."status" <> 'FAILED' OR e\."nextAttemptAt" IS NOT NULL OR \$\{notExpiredSql\("e"\)\}\)/, "the open backlog never scans an archived receipt");
  // Catch-all: any raw `FAILED … nextAttemptAt IS NULL` predicate is followed by the guard; any Prisma one carries it.
  for (const m of store.matchAll(/'FAILED' AND (\w+)\."nextAttemptAt" IS NULL/g)) {
    assert.ok(store.slice(m.index!, m.index! + 160).includes(`notExpiredSql("${m[1]}")`), `raw predicate at ${m.index}`);
  }
  for (const m of store.matchAll(/status: "FAILED"(?: as const)?,\s*nextAttemptAt: null,/g)) {
    const before = store.slice(Math.max(0, m.index! - 40), m.index!);
    if (/data: \{\s*$/.test(before)) continue; // a write (markDeadLetter), not a predicate
    // The rest of the same `where` object (it ends at the first closing brace on its own indentation).
    const where = store.slice(m.index!, store.indexOf("\n      },", m.index!));
    assert.ok(where.includes("NOT_EXPIRED_WHERE"), `prisma predicate at ${m.index}`);
  }
});

test("owner and notifications read the same backlog: an expired receipt is never \"could not be taken in\"", () => {
  const owner = read("lib/business-status/intake-attention.ts");
  assert.match(owner, /if \(b\.deadLetters > 0\)/, "the failure item reads backlog.deadLetters only");
  assert.doesNotMatch(owner, /expired/i, "nothing in the owner translator reads expired receipts");
});

console.log(`\nALL L1.5-b EXPIRED-CLASSIFICATION TESTS PASSED — ${checks} checks\n`);
