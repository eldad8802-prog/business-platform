/**
 * Gmail quota-unit budget for the extended scan (2026-11-09 B3-a).
 *
 * # Why units, not requests
 *
 * Gmail meters quota units, not requests: `messages.list` costs 5 and
 * `messages.get` with format=full costs 60 (Google's published table, updated
 * 2026-05-01). A request-count limit cannot tell a 5-unit call from a 60-unit
 * one, so the scan is admitted on what a page can COST at most.
 *
 * # The rule
 *
 * Before a page touches Gmail, its WORST-CASE cost (1 list + every read + the
 * whole retry budget, all charged at the read price) is reserved — atomically,
 * in one shared store, against every budget at once:
 *
 *   mailbox   the Gmail account (Gmail's per-user quota is per mailbox)
 *   business  so one business cannot spend the shared budget
 *   global    all of Dubiz, per minute and per day, leaving headroom for
 *             import, connect and the legacy scan, which do not draw on it
 *
 * Either every budget has room and all are charged, or none is charged and the
 * page does not start. Parallel requests on any number of instances therefore
 * cannot overshoot: each one's worst case is already counted before it runs.
 * After the page, what it did not use is refunded (never below zero).
 *
 * # When the store is unreachable
 *
 * The scan fails CLOSED: no shared count, no new scan page. There is no
 * per-instance fallback — a count that is not shared between Vercel instances
 * is not a bound. Import and /sync never touch this module.
 *
 * Windows are sliding-window counters (current window + the previous one
 * weighted by how much of it still overlaps), so a burst at a window edge is
 * not counted twice as fresh room.
 */

import { Redis } from "@upstash/redis";
import { RateLimiterBackendError, RateLimiterConfigError } from "@/lib/security/rate-limiter/errors";
import { GMAIL_PAGE_RETRY_BUDGET } from "./gmail-scan-page.service";

/** Gmail quota units per call (developers.google.com/workspace/gmail/api/reference/quota). */
export const GMAIL_UNITS_LIST = 5;
export const GMAIL_UNITS_GET_FULL = 60;

/** Worst case of one page: 1 list + every read + every retry, all at the read price. */
export function gmailPageWorstCaseUnits(pageSize: number): number {
  return GMAIL_UNITS_LIST + (pageSize + GMAIL_PAGE_RETRY_BUDGET) * GMAIL_UNITS_GET_FULL;
}

/** What a page actually spent, every attempted call counted (a failed call may still be metered). */
export function gmailUnitsSpent(calls: { listCalls: number; getCalls: number }): number {
  return calls.listCalls * GMAIL_UNITS_LIST + calls.getCalls * GMAIL_UNITS_GET_FULL;
}

export type GmailBudgetScope = "mailbox" | "business" | "global_minute" | "global_day";

/**
 * The budgets, in Gmail units. Planned against the STRICTER published table
 * (per-user 6,000 / minute, per-project 1,200,000 / minute, 80,000,000 / day
 * billing threshold) because Dubiz's actual project quotas were not readable
 * from here. Raise only from a verified Cloud-console value.
 *
 *   mailbox        3,500 / min  = 58% of Gmail's per-user 6,000 — the rest is
 *                  for import (80 a file) and /sync on the same mailbox
 *   business       7,000 / min, 105,000 / hour — at most two mailboxes at full
 *                  speed; 0.6% of the global minute budget
 *   global_minute  600,000 / min = 50% of the project quota; the other half
 *                  is headroom for import, connect and /sync
 *   global_day     20,000,000 / day = 25% of the daily billing threshold
 */
export const GMAIL_SCAN_BUDGETS = {
  mailbox: { limit: 3_500, windowSeconds: 60 },
  business_minute: { limit: 7_000, windowSeconds: 60 },
  business_hour: { limit: 105_000, windowSeconds: 60 * 60 },
  global_minute: { limit: 600_000, windowSeconds: 60 },
  global_day: { limit: 20_000_000, windowSeconds: 24 * 60 * 60 },
} as const;

type BudgetName = keyof typeof GMAIL_SCAN_BUDGETS;

const SCOPE_OF: Record<BudgetName, GmailBudgetScope> = {
  mailbox: "mailbox",
  business_minute: "business",
  business_hour: "business",
  global_minute: "global_minute",
  global_day: "global_day",
};

/** One budget line of a reservation: the two window keys and the numbers to check them with. */
export type BudgetLine = {
  name: BudgetName;
  curKey: string;
  prevKey: string;
  limit: number;
  /** Share of the previous window still inside the sliding window (0..1]. */
  prevWeight: number;
  ttlSeconds: number;
};

/** The shared store. `reserve` is all-or-nothing; it returns the 1-based index of the first full line, or 0. */
export interface GmailBudgetStore {
  reserve(lines: BudgetLine[], amount: number): Promise<number>;
  refund(curKeys: string[], amount: number): Promise<void>;
}

// All keys share one hash tag, so a clustered Redis keeps them in one slot (one atomic script).
const keyFor = (name: BudgetName, id: string, windowIndex: number) => `gq:{gmail-scan}:${name}:${id}:${windowIndex}`;

export function budgetLines(ids: { connectionId: number; businessId: number }, nowMs: number): BudgetLine[] {
  const idOf: Record<BudgetName, string> = {
    mailbox: `c${ids.connectionId}`,
    business_minute: `b${ids.businessId}`,
    business_hour: `b${ids.businessId}`,
    global_minute: "all",
    global_day: "all",
  };
  return (Object.keys(GMAIL_SCAN_BUDGETS) as BudgetName[]).map((name) => {
    const { limit, windowSeconds } = GMAIL_SCAN_BUDGETS[name];
    const windowMs = windowSeconds * 1000;
    const index = Math.floor(nowMs / windowMs);
    const elapsed = (nowMs - index * windowMs) / windowMs;
    return {
      name,
      curKey: keyFor(name, idOf[name], index),
      prevKey: keyFor(name, idOf[name], index - 1),
      limit,
      prevWeight: 1 - elapsed,
      ttlSeconds: windowSeconds * 2,
    };
  });
}

/**
 * Atomic all-or-nothing reserve. KEYS = [cur1, prev1, cur2, prev2, …];
 * ARGV = [amount, limit1, weight1, ttl1, limit2, weight2, ttl2, …].
 * Checks EVERY line first; only if all have room are all charged. Redis does
 * not roll back a script that errors half-way, so everything that could fail
 * (a missing or non-integer counter) is validated in the check phase, before
 * the first write; such a counter answers -1 (treated as unavailable: closed).
 */
export const RESERVE_LUA = [
  "local amount = tonumber(ARGV[1])",
  "local n = #KEYS / 2",
  "for i = 0, n - 1 do",
  "  local cur = tonumber(redis.call('GET', KEYS[2 * i + 1]) or '0')",
  "  local prev = tonumber(redis.call('GET', KEYS[2 * i + 2]) or '0')",
  "  if cur == nil or prev == nil or cur ~= math.floor(cur) or prev ~= math.floor(prev) then return -1 end",
  "  local limit = tonumber(ARGV[2 + 3 * i])",
  "  local weight = tonumber(ARGV[3 + 3 * i])",
  "  if prev * weight + cur + amount > limit then return i + 1 end",
  "end",
  "for i = 0, n - 1 do",
  "  redis.call('INCRBY', KEYS[2 * i + 1], amount)",
  "  redis.call('EXPIRE', KEYS[2 * i + 1], tonumber(ARGV[4 + 3 * i]))",
  "end",
  "return 0",
].join("\n");

/** Refund what a page did not use, never below zero. KEYS = the cur keys charged; ARGV = [amount]. */
export const REFUND_LUA = [
  "local amount = tonumber(ARGV[1])",
  "for i = 1, #KEYS do",
  "  local v = tonumber(redis.call('GET', KEYS[i]) or '0')",
  "  if v ~= nil and v == math.floor(v) then",
  "    local d = math.min(v, amount)",
  "    if d > 0 then redis.call('DECRBY', KEYS[i], d) end",
  "  end",
  "end",
  "return 0",
].join("\n");

const TIMEOUT_MS = 1000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RateLimiterBackendError("Gmail budget store timed out")), TIMEOUT_MS);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(new RateLimiterBackendError("Gmail budget store failed", { cause: e }));
      }
    );
  });
}

/** Minimal client surface, so a test can stand in for Redis. */
export type EvalClient = { eval(script: string, keys: string[], args: string[]): Promise<unknown> };

export function redisBudgetStore(client: () => EvalClient): GmailBudgetStore {
  return {
    async reserve(lines, amount) {
      const keys = lines.flatMap((l) => [l.curKey, l.prevKey]);
      const args = [String(amount), ...lines.flatMap((l) => [String(l.limit), String(l.prevWeight), String(l.ttlSeconds)])];
      return Number(await withTimeout(client().eval(RESERVE_LUA, keys, args)));
    },
    async refund(curKeys, amount) {
      await withTimeout(client().eval(REFUND_LUA, curKeys, [String(amount)]));
    },
  };
}

let upstash: Redis | null = null;
function upstashClient(): EvalClient {
  if (upstash) return upstash as unknown as EvalClient;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) throw new RateLimiterConfigError("Gmail budget store needs UPSTASH_REDIS_REST_URL / _TOKEN");
  upstash = new Redis({ url, token });
  return upstash as unknown as EvalClient;
}

/**
 * Dev / test store: the same algorithm on one process's memory. Never chosen in
 * production (see activeStore) — it is not shared between instances.
 */
export function memoryBudgetStore(map: Map<string, number> = new Map()): GmailBudgetStore {
  return {
    async reserve(lines, amount) {
      for (let i = 0; i < lines.length; i += 1) {
        const l = lines[i];
        const used = (map.get(l.prevKey) ?? 0) * l.prevWeight + (map.get(l.curKey) ?? 0);
        if (used + amount > l.limit) return i + 1;
      }
      for (const l of lines) map.set(l.curKey, (map.get(l.curKey) ?? 0) + amount);
      return 0;
    },
    async refund(curKeys, amount) {
      for (const k of curKeys) {
        const v = map.get(k) ?? 0;
        map.set(k, v - Math.min(v, amount));
      }
    },
  };
}

let override: GmailBudgetStore | null = null;
const devStore = memoryBudgetStore();

function activeStore(): GmailBudgetStore {
  if (override) return override;
  const explicit = process.env.RATE_LIMIT_BACKEND?.trim().toLowerCase();
  const useRedis = explicit === "redis" || (explicit !== "memory" && process.env.NODE_ENV === "production");
  return useRedis ? redisBudgetStore(upstashClient) : devStore;
}

/** Test-only: substitute the shared store (null restores the default). */
export function configureGmailBudgetStoreForTests(store: GmailBudgetStore | null): void {
  override = store;
}

export type GmailBudgetReservation =
  | { ok: true; reserved: number; curKeys: string[] }
  | { ok: false; reason: "exhausted"; scope: GmailBudgetScope }
  | { ok: false; reason: "unavailable" };

/**
 * Reserve a page's worst case against every budget. Never throws for an
 * unreachable store — returns "unavailable" (fail closed); a missing store
 * configuration in production also fails closed here.
 */
export async function reserveGmailScanBudget(
  ids: { connectionId: number; businessId: number },
  pageSize: number,
  nowMs: number = Date.now()
): Promise<GmailBudgetReservation> {
  const lines = budgetLines(ids, nowMs);
  const amount = gmailPageWorstCaseUnits(pageSize);
  let full: number;
  try {
    full = await activeStore().reserve(lines, amount);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (full !== 0) {
    const line = lines[full - 1];
    return line ? { ok: false, reason: "exhausted", scope: SCOPE_OF[line.name] } : { ok: false, reason: "unavailable" };
  }
  return { ok: true, reserved: amount, curKeys: lines.map((l) => l.curKey) };
}

/**
 * Give back what the page did not spend. Best effort: a failed refund only
 * leaves the budget MORE conservative until the window passes.
 */
export async function settleGmailScanBudget(
  reservation: { reserved: number; curKeys: string[] },
  spent: number
): Promise<number> {
  const unused = Math.max(0, reservation.reserved - Math.max(0, spent));
  if (unused === 0) return 0;
  try {
    await activeStore().refund(reservation.curKeys, unused);
    return unused;
  } catch {
    return 0;
  }
}
