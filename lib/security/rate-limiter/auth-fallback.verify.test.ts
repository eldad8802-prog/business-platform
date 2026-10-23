/**
 * L1 — the auth limits while the shared backend (Redis) is unreachable. No Redis needed: the shared
 * backend is a wrapper over the memory backend that can be switched to fail exactly as an unreachable
 * Upstash does (RateLimiterBackendError).
 *
 *   npx tsx lib/security/rate-limiter/auth-fallback.verify.test.ts
 *
 * Covers: the sign-in lock keeps working during an outage (warning count, lock, parallel burst), the
 * shared backend is rested between retries and authoritative again on recovery, a lock taken during
 * the outage survives recovery, a failed shared lock is kept locally, auth:* raw limits stay bounded
 * while other keys keep their fail-open posture, config errors still propagate, logs carry no address
 * digest or IP, and the local maps stay capped.
 */

process.env.RATE_LIMIT_BACKEND = "memory";

import { LOGIN_FAILURE_POLICY, loginAccountRateKey } from "@/lib/auth/account-rate-key";
import { consumeRateLimit, reserveAttempt } from "@/lib/security/rate-limit";

import { RateLimiterBackendError, RateLimiterConfigError } from "./errors";
import { configureRateLimiterForTests } from "./index";
import { LOCAL_FALLBACK_CAPS, localFallbackSizesForTests, resetLocalFallbackForTests } from "./local-fallback";
import { memoryBackend, resetMemoryBackendForTests } from "./memory-backend";
import type { RateLimitBackend } from "./types";

let failed = 0;
let passed = 0;
function ok(name: string, condition: boolean) {
  if (condition) {
    passed += 1;
    console.log("  ok  -", name);
  } else {
    failed += 1;
    console.error("  FAIL -", name);
  }
}

type Mode = "up" | "down" | "config";
let mode: Mode = "up";
let sharedCalls = 0;
let failLockOnly = false;

function guard() {
  sharedCalls += 1;
  if (mode === "down") throw new RateLimiterBackendError("Redis rate limit call timed out after 1000ms");
  if (mode === "config") throw new RateLimiterConfigError("Upstash env missing");
}

const shared: RateLimitBackend = {
  name: "redis",
  async evaluate(prefix, identifier, limit, windowSeconds) {
    guard();
    return memoryBackend.evaluate(`shared:${prefix}`, identifier, limit, windowSeconds);
  },
  async reserveAttempt(prefix, identifier, member, limit, windowMs, nowMs) {
    guard();
    return memoryBackend.reserveAttempt(`shared:${prefix}`, identifier, member, limit, windowMs, nowMs);
  },
  async clearAttempts(prefix, identifier) {
    guard();
    return memoryBackend.clearAttempts(`shared:${prefix}`, identifier);
  },
  async lockAttempts(prefix, identifier, lockMs, nowMs) {
    if (failLockOnly) throw new RateLimiterBackendError("Redis rate limit call failed");
    guard();
    return memoryBackend.lockAttempts(`shared:${prefix}`, identifier, lockMs, nowMs);
  },
};

function reset(retryMs = 60_000) {
  resetMemoryBackendForTests();
  resetLocalFallbackForTests();
  configureRateLimiterForTests({ backend: shared, retryMs });
  mode = "up";
  sharedCalls = 0;
  failLockOnly = false;
}

const KEY = loginAccountRateKey("owner@example.com");
const P = LOGIN_FAILURE_POLICY;
const reserve = (nowMs?: number) => reserveAttempt({ key: KEY, limit: P.limit, windowMs: P.windowMs, nowMs });

/** Drives the login route's own sequence: reserve, then lock on the limit-th failure. */
async function failedLogin(nowMs?: number) {
  const t = await reserve(nowMs);
  if (!t.allowed) return { allowed: false as const, locked: t.locked };
  if (t.count >= P.limit) await t.lock(P.lockMs);
  return { allowed: true as const, count: t.count };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    // 1. Baseline: healthy shared backend — 4 failures lock, the 5th attempt is refused as locked.
    reset();
    const healthy = [];
    for (let i = 0; i < P.limit + 1; i += 1) healthy.push(await failedLogin());
    ok("healthy: counts 1..4 on the shared ledger", healthy.slice(0, 4).every((r, i) => r.allowed && r.count === i + 1));
    ok("healthy: the 5th attempt is refused (locked)", !healthy[4].allowed && healthy[4].locked === true);

    // 2. Outage: the lock keeps working — counts are real (warning at 3), lock at 4, 5th refused.
    reset();
    mode = "down";
    const down = [];
    for (let i = 0; i < P.limit + 1; i += 1) down.push(await failedLogin());
    ok("outage: attempts are COUNTED (1..4), never count 0", down.slice(0, 4).every((r, i) => r.allowed && r.count === i + 1));
    ok("outage: the third failure carries the warning count", down[2].allowed && down[2].count === P.warnAtFailure);
    ok("outage: the 5th attempt is refused as locked", !down[4].allowed && down[4].locked === true);

    // 3. Outage: the shared backend is rested — one failed call, then local only, until the interval ends.
    ok("outage: the shared backend was tried once, then rested", sharedCalls === 1);

    // 4. Outage: a parallel burst of 20 runs at most 4 attempts.
    reset();
    mode = "down";
    const burst = await Promise.all(Array.from({ length: 20 }, () => reserve()));
    ok("outage burst: exactly 4 of 20 parallel attempts reserved", burst.filter((t) => t.allowed).length === P.limit);

    // 5. Healthy burst for comparison (shared ledger): also exactly 4.
    reset();
    const hburst = await Promise.all(Array.from({ length: 20 }, () => reserve()));
    ok("healthy burst: exactly 4 of 20 parallel attempts reserved", hburst.filter((t) => t.allowed).length === P.limit);

    // 6. Recovery: after the rest interval the shared backend answers again and is authoritative.
    reset(30);
    mode = "down";
    await failedLogin();
    const callsDuringOutage = sharedCalls;
    mode = "up";
    await failedLogin(); // still resting -> local
    ok("recovery: still resting inside the interval (no shared call)", sharedCalls === callsDuringOutage);
    await sleep(45);
    const after = await reserve();
    ok("recovery: after the interval the shared backend is used again", sharedCalls === callsDuringOutage + 1);
    ok("recovery: the shared ledger counts from its own state", after.allowed && after.count === 1);

    // 7. A lock taken during the outage still holds after recovery, until it expires.
    reset(30);
    mode = "down";
    for (let i = 0; i < P.limit; i += 1) await failedLogin();
    mode = "up";
    await sleep(45);
    const stillLocked = await reserve();
    ok("recovery: a lock recorded during the outage still refuses", !stillLocked.allowed && stillLocked.locked === true);
    const expired = await reserve(Date.now() + P.lockMs + 1);
    ok("recovery: the local lock expires on time", expired.allowed === true);

    // 8. A success clears the window wherever it was counted (no stale failures after the outage).
    reset();
    mode = "down";
    await failedLogin();
    await failedLogin();
    const good = await reserve();
    if (good.allowed) await good.clear();
    const next = await reserve();
    ok("outage: a successful sign-in clears the local window (count restarts at 1)", next.allowed && next.count === 1);

    // 9. The shared lock call fails after a shared reservation: the lock is kept locally, not lost.
    reset();
    for (let i = 0; i < P.limit - 1; i += 1) await failedLogin();
    failLockOnly = true;
    const fourth = await failedLogin();
    failLockOnly = false;
    const fifth = await reserve();
    ok("lock write fails: the 4th failure still locks (kept locally)", fourth.allowed && !fifth.allowed && fifth.locked === true);

    // 10. auth:* raw limits stay bounded during an outage; other keys keep their fail-open posture.
    reset();
    mode = "down";
    const authRaw = [];
    for (let i = 0; i < 4; i += 1) authRaw.push(await consumeRateLimit({ key: "auth:reset:ip:203.0.113.9", limit: 3, windowMs: 60_000 }));
    ok("outage: auth:* raw limit allows 3 then refuses the 4th", authRaw.slice(0, 3).every((r) => r.allowed) && !authRaw[3].allowed);
    const mfaRaw = [];
    for (let i = 0; i < 6; i += 1) mfaRaw.push(await consumeRateLimit({ key: "admin:mfa:verify:7", limit: 5, windowMs: 60_000 }));
    ok("outage: platform-admin MFA limit stays bounded", !mfaRaw[5].allowed);
    const other = [];
    for (let i = 0; i < 10; i += 1) other.push(await consumeRateLimit({ key: "pos:sale:biz:1", limit: 3, windowMs: 60_000 }));
    ok("outage: non-auth keys keep the previous fail-open posture", other.every((r) => r.allowed));

    // 11. Healthy auth raw limit still uses the shared backend (behavior unchanged when Redis is up).
    reset();
    await consumeRateLimit({ key: "auth:login:203.0.113.9", limit: 10, windowMs: 60_000 });
    ok("healthy: auth raw limit goes to the shared backend", sharedCalls === 1);

    // 12. A configuration error is never masked by the fallback.
    reset();
    mode = "config";
    let threw = false;
    try {
      await reserve();
    } catch (e) {
      threw = e instanceof RateLimiterConfigError;
    }
    ok("config error still propagates (fail hard)", threw);

    // 13. Logs: the degraded path names the limit class, never the address digest or the IP.
    reset();
    errors.length = 0;
    mode = "down";
    await failedLogin();
    await consumeRateLimit({ key: "auth:login:203.0.113.77", limit: 10, windowMs: 60_000 });
    configureRateLimiterForTests({});
    await consumeRateLimit({ key: "pos:sale:198.51.100.4", limit: 10, windowMs: 60_000 });
    const digest = KEY.split(":")[3];
    const joined = errors.join("\n");
    ok("logs: the degradation is logged", /backend_unavailable/.test(joined) && /key=auth:login/.test(joined));
    ok("logs: no address digest in any log line", !joined.includes(digest));
    ok("logs: no IP in any log line", !/203\.0\.113\.77|198\.51\.100\.4/.test(joined));

    // 14. The local maps stay capped under an address spray.
    reset();
    mode = "down";
    const now = Date.now();
    for (let i = 0; i < LOCAL_FALLBACK_CAPS.MAX_WINDOWS + 1_500; i += 1) {
      await reserveAttempt({ key: loginAccountRateKey(`spray${i}@example.com`), limit: P.limit, windowMs: P.windowMs, nowMs: now });
    }
    const sizes = localFallbackSizesForTests();
    ok("caps: windows + attempts stay within MAX_WINDOWS", sizes.windows + sizes.attempts <= LOCAL_FALLBACK_CAPS.MAX_WINDOWS);
  } finally {
    console.error = realError;
    configureRateLimiterForTests({ backend: null, retryMs: 10_000 });
  }

  console.log(`\n[auth-fallback] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
