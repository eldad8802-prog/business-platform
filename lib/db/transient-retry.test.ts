/**
 * One bounded retry for a dropped database connection — pure suite (no database, no network, no clock).
 *   npx tsx lib/db/transient-retry.test.ts
 *
 *   A  Only connection errors are retried: P1001 / P1002 / P1017 / P2024, or Prisma's "can't reach" / "closed the
 *      connection" wording without a code. Never P2002, P2028, P2025, a TypeError, a string, an unknown error.
 *   B  Bounded: one retry by default; the last error surfaces unchanged (the route still answers 500); attempts and
 *      delay are clamped.
 *   C  canRetry=false keeps the error (the sweep's "health already started" guard).
 *   D  The log carries label, attempt, class and code — never the message (it can carry the database host).
 *   E  The call sites: reminder dispatch retries only the identifier read (dueReminders), never the claim / push;
 *      the intake sweep retries the tenant list and one business, skips provider calls on the retry, and never
 *      retries once the health read began; the routes' failure answers are unchanged.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { CONNECTION_ERROR_CODES, isConnectionError, withConnectionRetry } from "./transient-retry";
import { sweepBusiness } from "../intake/intake-sweeper";

let passed = 0;
async function ok(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Shaped like Prisma's errors (name + code / errorCode), without importing the client. */
function prismaError(code: string | undefined, message = "x", name = "PrismaClientKnownRequestError") {
  const e = new Error(message) as Error & { code?: string };
  e.name = name;
  if (code !== undefined) e.code = code;
  return e;
}
function initError(errorCode: string | undefined, message: string) {
  const e = new Error(message) as Error & { errorCode?: string };
  e.name = "PrismaClientInitializationError";
  if (errorCode !== undefined) e.errorCode = errorCode;
  return e;
}
const HOST = "ep-secret-host-pooler.example.neon.tech:5432";
const noSleep = async () => {};

async function main() {
  console.log("\nA. which errors are retried");
  await ok("P1001 / P1002 / P1017 / P2024 are connection errors", () => {
    for (const c of ["P1001", "P1002", "P1017", "P2024"]) assert.equal(isConnectionError(prismaError(c)), true, c);
    assert.deepEqual([...CONNECTION_ERROR_CODES].sort(), ["P1001", "P1002", "P1017", "P2024"]);
  });
  await ok("initialization error with errorCode P1001 is a connection error", () => {
    assert.equal(isConnectionError(initError("P1001", `Can't reach database server at \`${HOST}\``)), true);
  });
  await ok("no code: Prisma's own wording (as seen in Production logs) is recognised", () => {
    assert.equal(isConnectionError(prismaError(undefined, "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nServer has closed the connection.")), true);
    assert.equal(isConnectionError(initError(undefined, `Can't reach database server at \`${HOST}\``)), true);
  });
  await ok("never retried: constraint, transaction timeout / closed, not found, bugs, strings, unknown", () => {
    for (const c of ["P2002", "P2028", "P2025", "P2034", "P1000", "P1008"]) assert.equal(isConnectionError(prismaError(c, "Server has closed the connection.")), false, c);
    assert.equal(isConnectionError(new TypeError("cannot read x")), false);
    assert.equal(isConnectionError("P1017"), false);
    assert.equal(isConnectionError({ code: "P1017" }), false);
    assert.equal(isConnectionError(null), false);
    assert.equal(isConnectionError(new Error("Transaction failed to commit")), false);
    assert.equal(isConnectionError(new Error("timed out")), false);
  });

  console.log("\nB. bounded");
  await ok("a drop then success → one retry, the result returned, the attempt number passed", async () => {
    const seen: number[] = [];
    const out = await withConnectionRetry(async (attempt) => {
      seen.push(attempt);
      if (attempt === 1) throw prismaError("P1017");
      return "rows";
    }, { label: "t", sleep: noSleep, log: () => {} });
    assert.equal(out, "rows");
    assert.deepEqual(seen, [1, 2]);
  });
  await ok("two drops → the second error surfaces unchanged (the caller's 500 path still runs)", async () => {
    const second = prismaError("P1001");
    let calls = 0;
    await assert.rejects(
      withConnectionRetry(async () => { calls += 1; throw calls === 1 ? prismaError("P1017") : second; }, { label: "t", sleep: noSleep, log: () => {} }),
      (e) => e === second,
    );
    assert.equal(calls, 2);
  });
  await ok("a non-connection error → no retry, thrown as is", async () => {
    const dup = prismaError("P2002");
    let calls = 0;
    await assert.rejects(withConnectionRetry(async () => { calls += 1; throw dup; }, { label: "t", sleep: noSleep, log: () => {} }), (e) => e === dup);
    assert.equal(calls, 1);
  });
  await ok("attempts clamped to 1..3, delay clamped to 0..2000 ms", async () => {
    const delays: number[] = [];
    let calls = 0;
    await assert.rejects(withConnectionRetry(async () => { calls += 1; throw prismaError("P1017"); }, {
      label: "t", attempts: 50, delayMs: 60_000, sleep: async (ms) => { delays.push(ms); }, log: () => {},
    }));
    assert.equal(calls, 3);
    assert.deepEqual(delays, [2000, 2000]);
    calls = 0;
    await assert.rejects(withConnectionRetry(async () => { calls += 1; throw prismaError("P1017"); }, { label: "t", attempts: 0, sleep: noSleep, log: () => {} }));
    assert.equal(calls, 1);
  });
  await ok("default: 2 attempts, 250 ms pause", async () => {
    const delays: number[] = [];
    let calls = 0;
    await assert.rejects(withConnectionRetry(async () => { calls += 1; throw prismaError("P1017"); }, { label: "t", sleep: async (ms) => { delays.push(ms); }, log: () => {} }));
    assert.equal(calls, 2);
    assert.deepEqual(delays, [250]);
  });

  console.log("\nC. canRetry");
  await ok("canRetry=false keeps the connection error; asked only after a connection error", async () => {
    let asked = 0;
    const drop = prismaError("P1017");
    await assert.rejects(withConnectionRetry(async () => { throw drop; }, { label: "t", canRetry: () => { asked += 1; return false; }, sleep: noSleep, log: () => {} }), (e) => e === drop);
    assert.equal(asked, 1);
    asked = 0;
    await assert.rejects(withConnectionRetry(async () => { throw prismaError("P2002"); }, { label: "t", canRetry: () => { asked += 1; return true; }, sleep: noSleep, log: () => {} }));
    assert.equal(asked, 0);
  });

  console.log("\nD. the log");
  await ok("label, attempt, class and code only — never the message or the host", async () => {
    const lines: string[] = [];
    await withConnectionRetry(async (a) => { if (a === 1) throw initError("P1001", `Can't reach database server at \`${HOST}\``); return 1; }, {
      label: "intake-sweep.tenants", sleep: noSleep, log: (line, meta) => { lines.push(line + JSON.stringify(meta)); },
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /intake-sweep\.tenants/);
    assert.match(lines[0], /PrismaClientInitializationError/);
    assert.match(lines[0], /P1001/);
    assert.ok(!lines[0].includes("neon.tech") && !lines[0].includes("reach"), lines[0]);
  });

  console.log("\nE. call sites");
  await ok("sweepBusiness: a drop before the health read → retried once with attempt 2", async () => {
    const attempts: number[] = [];
    const out = await sweepBusiness(9, () => true, async (attempt) => {
      attempts.push(attempt);
      if (attempt === 1) throw prismaError("P1017");
      return "drained";
    }, { sleep: noSleep, log: () => {} });
    assert.equal(out, "drained");
    assert.deepEqual(attempts, [1, 2]);
  });
  await ok("sweepBusiness: a drop after the health read began → not retried (the run stays red)", async () => {
    let calls = 0;
    await assert.rejects(sweepBusiness(9, () => false, async () => { calls += 1; throw prismaError("P1017"); }, { sleep: noSleep, log: () => {} }));
    assert.equal(calls, 1);
  });
  await ok("sweepBusiness: a non-connection failure is never retried", async () => {
    let calls = 0;
    await assert.rejects(sweepBusiness(9, () => true, async () => { calls += 1; throw new Error("adapter bug"); }, { sleep: noSleep, log: () => {} }));
    assert.equal(calls, 1);
  });

  const root = path.resolve(__dirname, "../..");
  const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
  await ok("reminder dispatch: only dueReminders (identifiers) is retried — never the claim, the bell row or the push", () => {
    const src = read("lib/services/tasks/task-reminders.service.ts");
    const calls = src.match(/withConnectionRetry\(/g) ?? [];
    assert.equal(calls.length, 1);
    assert.match(src, /withConnectionRetry\(\(\) => dueReminders\(now\), \{ label: "task-reminders\.due" \}\)/);
    // The claim (conditional UPDATE on reminderSentAt) is still the guard against a double send.
    assert.match(src, /reminderSentAt: null, remindAt: due\.remindAt/);
  });
  await ok("intake sweep: tenants + one business retried; provider calls only on attempt 1; health read stops retries", () => {
    const src = read("lib/intake/intake-sweeper.ts");
    assert.match(src, /withConnectionRetry\(\(\) => tenantsOf\(registry\), \{ label: "intake-sweep\.tenants" \}\)/);
    assert.match(src, /options\.reconcileCommerce !== false && attempt === 1/);
    assert.match(src, /options\.syncRevenueSources !== false && attempt === 1/);
    assert.match(src, /healthStarted = true;\n\s+const h = await intakeHealthCounts\(businessId, now\);/);
    assert.match(src, /sweepBusiness\(businessId, \(\) => !healthStarted,/);
    // The same `now` for both attempts: the first attempt's lease still holds on the retry.
    assert.ok(!/attempt[^\n]*new Date\(/.test(src));
  });
  await ok("routes unchanged: a surfaced error still answers 500 (QStash retries as before)", () => {
    assert.match(read("app/api/task-reminders/dispatch/route.ts"), /dispatch_failed" \}, \{ status: 500 \}/);
    assert.match(read("app/api/intake/sweep/route.ts"), /sweep_failed" \}, \{ status: 500 \}/);
  });
  await ok("the helper is pure and generic: no Prisma import, no database, no tenant", () => {
    const src = read("lib/db/transient-retry.ts");
    for (const banned of ["@prisma/client", "lib/prisma", "$transaction", "tenantTx", "businessId"]) assert.ok(!src.includes(banned), banned);
  });

  console.log(`\n[transient-retry] ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
