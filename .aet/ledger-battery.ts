/**
 * The attempt ledger behind the sign-in lock (lib/security/rate-limit.ts reserveAttempt), on the backend
 * selected by RATE_LIMIT_BACKEND — `redis` runs the REAL Lua scripts through @upstash/redis (in CI: a
 * real Redis behind serverless-redis-http, the Upstash REST emulator), `memory` the in-process one.
 * Real clock, short windows (window 3s, lock 2s), so expiry is observed, not simulated.
 *
 *   1. four reservations count 1..4; a fifth inside the window is refused (not a lock) with the wait;
 *   2. lock → refused as LOCKED with ~the lock time left; after it passes → allowed, ledger empty;
 *   3. the window ROLLS: an attempt older than the window stops counting;
 *   4. clear → the next attempt counts 1;
 *   5. a parallel burst of 20 → exactly 4 reserved (atomic);
 *   6. ledgers are per key: one address's lock does not touch another's.
 *
 * env: RATE_LIMIT_BACKEND (redis | memory), and for redis UPSTASH_REDIS_REST_URL / _TOKEN. ZERO Production.
 */
import { randomUUID } from "node:crypto";

import { reserveAttempt } from "@/lib/security/rate-limit";

const backend = process.env.RATE_LIMIT_BACKEND ?? "memory";
if (backend === "redis" && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(process.env.UPSTASH_REDIS_REST_URL ?? "")) {
  throw new Error("DENY: the ledger battery runs only against a local Redis emulator");
}

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const W = 3000;
const L = 2000;
const key = () => `ledger-battery:${randomUUID()}`;
const reserve = (k: string) => reserveAttempt({ key: k, limit: 4, windowMs: W });

async function main() {
  console.log(`— attempt ledger on backend=${backend} —`);

  const k1 = key();
  const counts = [];
  for (let i = 0; i < 4; i++) {
    const r = await reserve(k1);
    counts.push(r.allowed ? r.count : -1);
  }
  ok("1. four reservations count 1, 2, 3, 4", counts.join() === "1,2,3,4", counts.join());
  const fifth = await reserve(k1);
  ok("1. a fifth inside the window is refused — not a lock — with a wait within the window",
    !fifth.allowed && !fifth.locked && fifth.retryAfterMs > 0 && fifth.retryAfterMs <= W, JSON.stringify(fifth));

  const k2 = key();
  const t = await reserve(k2);
  if (t.allowed) await t.lock(L);
  const locked = await reserve(k2);
  ok("2. after lock(): refused as LOCKED with about the lock time left",
    !locked.allowed && locked.locked && locked.retryAfterMs > L - 500 && locked.retryAfterMs <= L, JSON.stringify(locked));
  await sleep(L + 300);
  const unlocked = await reserve(k2);
  ok("2. once the lock has passed: allowed again, and the ledger starts empty", unlocked.allowed && unlocked.count === 1, JSON.stringify(unlocked));

  const k3 = key();
  await reserve(k3);
  await sleep(1000);
  await reserve(k3);
  await sleep(1000);
  await reserve(k3);
  await sleep(1300); // the first attempt is now older than the 3s window
  const rolled = await reserve(k3);
  ok("3. the window ROLLS: the oldest attempt left it, so this one counts 3, not 4", rolled.allowed && rolled.count === 3, JSON.stringify(rolled));

  const k4 = key();
  for (let i = 0; i < 3; i++) await reserve(k4);
  const fourth = await reserve(k4);
  if (fourth.allowed) await fourth.clear();
  const afterClear = await reserve(k4);
  ok("4. clear() empties the ledger: the next attempt counts 1", afterClear.allowed && afterClear.count === 1, JSON.stringify(afterClear));

  const k5 = key();
  const burst = await Promise.all(Array.from({ length: 20 }, () => reserve(k5)));
  const allowed = burst.filter((b) => b.allowed);
  ok("5. a parallel burst of 20 → exactly 4 reserved (atomic)", allowed.length === 4, `allowed=${allowed.length}`);
  ok("5. …counted 1..4 exactly once each",
    allowed.map((b) => (b.allowed ? b.count : 0)).sort().join() === "1,2,3,4", allowed.map((b) => (b.allowed ? b.count : 0)).join());

  const k6a = key();
  const k6b = key();
  const a = await reserve(k6a);
  if (a.allowed) await a.lock(L);
  const b = await reserve(k6b);
  ok("6. one key's lock does not touch another key", b.allowed && b.count === 1);

  console.log(`\n[ledger-battery:${backend}] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
