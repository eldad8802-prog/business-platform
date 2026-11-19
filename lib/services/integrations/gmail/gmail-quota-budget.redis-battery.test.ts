/**
 * Gmail quota-unit budget — REAL Redis battery (2026-11-09 B3-a, owner-approved isolated check).
 *
 * Runs the production Lua scripts (RESERVE_LUA / REFUND_LUA) inside a real Redis 7.4, reached the way
 * Production reaches Upstash: the @upstash/redis REST client, here through serverless-redis-http (the
 * Upstash REST emulator). Ephemeral CI containers, a synthetic token, no secrets, no Gmail, no database.
 *
 * Refuses to run unless the REST URL is localhost — it can never touch a real Upstash.
 *
 *   R1  the real script reserves on all five lines, with expiries
 *   R2  per-mailbox exhaustion; a refusal charges nothing
 *   R3  a LATER line full → no earlier line charged (all-or-nothing)
 *   R4  a corrupted counter (non-integer, wrong type) → refused before ANY write
 *   R5  a parallel burst through two clients ("instances") → exactly what fits; every line equal
 *   R6  refunds: unused units come back, never below zero, lines stay equal
 *   R7  sliding window on real Redis
 *   R8  Redis hangs (paused) mid-burst → fail closed, no partial charge; recovers
 *   R9  Redis crashes (stopped) mid-burst → fail closed, no partial charge; GMAIL_SCAN refused,
 *       an open bucket still answers; recovers on restart
 *
 *   RATE_LIMIT_BACKEND=redis UPSTASH_REDIS_REST_URL=http://localhost:8079 \
 *   UPSTASH_REDIS_REST_TOKEN=… REDIS_CONTAINER=<id> npx tsx lib/services/integrations/gmail/gmail-quota-budget.redis-battery.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Redis } from "@upstash/redis";
import {
  GMAIL_SCAN_BUDGETS,
  budgetLines,
  configureGmailBudgetStoreForTests,
  gmailPageWorstCaseUnits,
  redisBudgetStore,
  reserveGmailScanBudget,
  settleGmailScanBudget,
  type EvalClient,
  type GmailBudgetStore,
} from "@/lib/services/integrations/gmail/gmail-quota-budget";
import { checkRateLimit } from "@/lib/security/rate-limiter";

const URL_ = process.env.UPSTASH_REDIS_REST_URL ?? "";
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
const CONTAINER = process.env.REDIS_CONTAINER ?? "";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(URL_)) {
  console.error("REFUSED: this battery only runs against a local Redis emulator (http://localhost:…).");
  process.exit(2);
}
if (process.env.RATE_LIMIT_BACKEND !== "redis") {
  console.error("REFUSED: set RATE_LIMIT_BACKEND=redis so the production code path is exercised.");
  process.exit(2);
}

const redis = new Redis({ url: URL_, token: TOKEN });
const PER = gmailPageWorstCaseUnits(25); // 1,745
const NOW = Date.UTC(2026, 10, 9, 12, 0, 30);

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`OK  : ${name}`);
}

async function flush() {
  await redis.flushdb();
}
async function val(key: string): Promise<number> {
  const v = await redis.get<string | number | null>(key);
  return v == null ? 0 : Number(v);
}
/** Totals per budget line (summed over every id), from the real keys. */
async function lineTotals(): Promise<Record<string, number>> {
  const keys = await redis.keys("gq:{gmail-scan}:*");
  const totals: Record<string, number> = { mailbox: 0, business_minute: 0, business_hour: 0, global_minute: 0, global_day: 0 };
  for (const k of keys) {
    const name = k.split(":")[2];
    if (name in totals) totals[name] += await val(k);
  }
  return totals;
}
function assertLinesEqual(t: Record<string, number>, msg: string) {
  const values = Object.values(t);
  assert.ok(values.every((v) => v === values[0]), `${msg}: lines differ ${JSON.stringify(t)}`);
}
async function waitForRedis() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await redis.ping()) === "PONG") return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Redis did not come back");
}
function docker(...args: string[]) {
  execFileSync("docker", args, { stdio: "ignore" });
}

async function main() {
  await waitForRedis();

  await check("R1 the real Lua reserves the worst case on all five lines, each with an expiry", async () => {
    await flush();
    const r = await reserveGmailScanBudget({ connectionId: 1, businessId: 9 }, 25, NOW);
    assert.ok(r.ok, JSON.stringify(r));
    for (const l of budgetLines({ connectionId: 1, businessId: 9 }, NOW)) {
      assert.equal(await val(l.curKey), PER, l.name);
      const ttl = await redis.ttl(l.curKey);
      assert.ok(ttl > 0 && ttl <= l.ttlSeconds, `${l.name} ttl ${ttl}`);
    }
  });

  await check("R2 per-mailbox exhaustion on real Redis; a refusal charges nothing", async () => {
    await flush();
    const ids = { connectionId: 2, businessId: 9 };
    assert.ok((await reserveGmailScanBudget(ids, 25, NOW)).ok);
    assert.ok((await reserveGmailScanBudget(ids, 25, NOW)).ok);
    const before = await lineTotals();
    assert.deepEqual(await reserveGmailScanBudget(ids, 25, NOW), { ok: false, reason: "exhausted", scope: "mailbox" });
    assert.deepEqual(await lineTotals(), before, "nothing charged by the refusal");
  });

  await check("R3 a LATER line full → no earlier line is charged (all-or-nothing)", async () => {
    await flush();
    const lines = budgetLines({ connectionId: 3, businessId: 50 }, NOW);
    const business = lines.find((l) => l.name === "business_minute")!;
    await redis.set(business.curKey, String(GMAIL_SCAN_BUDGETS.business_minute.limit - 100));
    const r = await reserveGmailScanBudget({ connectionId: 3, businessId: 50 }, 25, NOW);
    assert.deepEqual(r, { ok: false, reason: "exhausted", scope: "business" });
    assert.equal(await val(lines[0].curKey), 0, "mailbox (line 1) not charged");
    assert.equal(await val(lines.find((l) => l.name === "global_minute")!.curKey), 0, "global not charged");
    // Same with the LAST line (global day) full.
    await flush();
    const day = lines.find((l) => l.name === "global_day")!;
    await redis.set(day.curKey, String(GMAIL_SCAN_BUDGETS.global_day.limit));
    assert.deepEqual(await reserveGmailScanBudget({ connectionId: 3, businessId: 50 }, 25, NOW), { ok: false, reason: "exhausted", scope: "global_day" });
    for (const l of lines.filter((x) => x.name !== "global_day")) assert.equal(await val(l.curKey), 0, l.name);
  });

  await check("R4 a corrupted counter is refused before ANY write (no half-charged reservation)", async () => {
    const lines = budgetLines({ connectionId: 4, businessId: 51 }, NOW);
    const globalMinute = lines.find((l) => l.name === "global_minute")!;
    for (const corrupt of ["1.5", "abc"]) {
      await flush();
      await redis.set(globalMinute.curKey, corrupt);
      const r = await reserveGmailScanBudget({ connectionId: 4, businessId: 51 }, 25, NOW);
      assert.deepEqual(r, { ok: false, reason: "unavailable" }, corrupt);
      for (const l of lines.filter((x) => x.name !== "global_minute")) assert.equal(await val(l.curKey), 0, `${corrupt}: ${l.name}`);
    }
    // Wrong type (a hash): Redis errors in the CHECK phase → nothing written, fail closed.
    await flush();
    await redis.hset(globalMinute.curKey, { a: "1" });
    assert.deepEqual(await reserveGmailScanBudget({ connectionId: 4, businessId: 51 }, 25, NOW), { ok: false, reason: "unavailable" });
    for (const l of lines.filter((x) => x.name !== "global_minute")) assert.equal(await val(l.curKey), 0, `hash: ${l.name}`);
  });

  let granted = 0;
  await check("R5 parallel burst through two clients: exactly what fits globally; every line equal", async () => {
    await flush();
    const clientA = new Redis({ url: URL_, token: TOKEN }) as unknown as EvalClient;
    const clientB = new Redis({ url: URL_, token: TOKEN }) as unknown as EvalClient;
    const a = redisBudgetStore(() => clientA);
    const b = redisBudgetStore(() => clientB);
    const both: GmailBudgetStore = {
      reserve: (lines, amount) => (Math.random() < 0.5 ? a : b).reserve(lines, amount),
      refund: (keys, amount) => a.refund(keys, amount),
    };
    configureGmailBudgetStoreForTests(both);
    const results = await Promise.all(
      Array.from({ length: 500 }, (_, i) => reserveGmailScanBudget({ connectionId: 20_000 + i, businessId: 20_000 + i }, 25, NOW))
    );
    configureGmailBudgetStoreForTests(null);
    granted = results.filter((r) => r.ok).length;
    const refusedGlobal = results.filter((r) => !r.ok && r.reason === "exhausted" && r.scope === "global_minute").length;
    const fits = Math.floor(GMAIL_SCAN_BUDGETS.global_minute.limit / PER);
    assert.equal(granted, fits, `granted ${granted}, fits ${fits}`);
    assert.equal(granted + refusedGlobal, 500);
    const t = await lineTotals();
    assertLinesEqual(t, "after burst");
    assert.equal(t.global_minute, granted * PER);
    assert.ok(t.global_minute <= GMAIL_SCAN_BUDGETS.global_minute.limit);
  });

  await check("R6 refunds on real Redis: unused units come back, never below zero, lines stay equal", async () => {
    // Settle every granted page of R5 as a typical page (1 list + 25 reads): 240 back each.
    const lines = (i: number) => budgetLines({ connectionId: 20_000 + i, businessId: 20_000 + i }, NOW).map((l) => l.curKey);
    let refunded = 0;
    for (let i = 0; i < 500 && refunded < granted; i += 1) {
      const keys = lines(i);
      if ((await val(keys[0])) === 0) continue; // this one was refused in R5
      assert.equal(await settleGmailScanBudget({ reserved: PER, curKeys: keys }, 5 + 25 * 60), 240);
      refunded += 1;
    }
    assert.equal(refunded, granted);
    const t = await lineTotals();
    assertLinesEqual(t, "after refunds");
    assert.equal(t.global_minute, granted * (PER - 240));
    // Never below zero.
    await redis.set("gq:{gmail-scan}:mailbox:c999:1", "100");
    await settleGmailScanBudget({ reserved: PER, curKeys: ["gq:{gmail-scan}:mailbox:c999:1"] }, 0);
    assert.equal(await val("gq:{gmail-scan}:mailbox:c999:1"), 0);
  });

  await check("R7 sliding window on real Redis: the end of last minute still counts now", async () => {
    await flush();
    const end = Date.UTC(2026, 10, 9, 12, 0, 59, 900);
    const ids = { connectionId: 7, businessId: 9 };
    assert.ok((await reserveGmailScanBudget(ids, 25, end)).ok);
    assert.ok((await reserveGmailScanBudget(ids, 25, end)).ok);
    assert.deepEqual(await reserveGmailScanBudget(ids, 25, end + 200), { ok: false, reason: "exhausted", scope: "mailbox" });
  });

  async function burstDuring(action: () => void, label: string) {
    await flush();
    const pending = Array.from({ length: 200 }, (_, i) =>
      new Promise<void>((r) => setTimeout(r, i * 3)).then(() =>
        reserveGmailScanBudget({ connectionId: 30_000 + i, businessId: 30_000 + i }, 25, NOW)
      )
    );
    await new Promise((r) => setTimeout(r, 150));
    action();
    const results = await Promise.all(pending);
    const ok = results.filter((r) => r.ok).length;
    const unavailable = results.filter((r) => !r.ok && r.reason === "unavailable").length;
    assert.equal(ok + unavailable, 200, `${label}: only granted or closed`);
    assert.ok(unavailable > 0, `${label}: the failure was observed`);
    return { ok, unavailable };
  }

  await check("R8 Redis hangs mid-burst (paused): fail closed, never a partial charge; recovers", async () => {
    assert.ok(CONTAINER, "REDIS_CONTAINER is required for the failure checks");
    const { ok } = await burstDuring(() => docker("pause", CONTAINER), "paused");
    docker("unpause", CONTAINER);
    await waitForRedis();
    const t = await lineTotals();
    assertLinesEqual(t, "after a hang");
    // Granted ones are all there; a request that ran but whose answer was lost counts as closed (over-, never under-charged).
    assert.ok(t.global_minute >= ok * PER && t.global_minute % PER === 0, JSON.stringify(t));
    assert.ok((await reserveGmailScanBudget({ connectionId: 1, businessId: 1 }, 25, NOW)).ok, "works again");
  });

  await check("R9 Redis crashes mid-burst (stopped): fail closed; GMAIL_SCAN refused, an open bucket answers; recovers", async () => {
    const { ok } = await burstDuring(() => docker("stop", "-t", "1", CONTAINER), "stopped");
    // While down: the extended scan's limiter refuses (closed) …
    const errors = console.error;
    console.error = () => {};
    try {
      const scan = await checkRateLimit({ bucket: "GMAIL_SCAN", user: 1, business: 9 });
      assert.equal(scan.allowed, false);
      assert.equal(scan.outcome, "backend_unavailable");
      // … while an open bucket (document reads) keeps answering: the outage blocks only the new scan.
      assert.equal((await checkRateLimit({ bucket: "DOCUMENTS_API", user: 1, business: 9 })).allowed, true);
      assert.deepEqual(await reserveGmailScanBudget({ connectionId: 1, businessId: 1 }, 25, NOW), { ok: false, reason: "unavailable" });
    } finally {
      console.error = errors;
    }
    docker("start", CONTAINER);
    await waitForRedis();
    const t = await lineTotals();
    assertLinesEqual(t, "after a crash");
    assert.ok(t.global_minute % PER === 0, JSON.stringify(t));
    console.log(`      (crash: ${ok} granted before the stop; counters after restart ${JSON.stringify(t)})`);
    await flush();
    assert.ok((await reserveGmailScanBudget({ connectionId: 1, businessId: 1 }, 25, NOW)).ok, "works again");
  });

  console.log(`GMAIL QUOTA BUDGET REDIS BATTERY PASS — ${passed} checks green (real Redis 7.4 via the Upstash REST emulator).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
