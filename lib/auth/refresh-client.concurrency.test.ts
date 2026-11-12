/**
 * Refresh client — cross-tab lock, lost responses, retry schedule (no browser,
 * no database, virtual time):
 *   npx tsx lib/auth/refresh-client.concurrency.test.ts
 *
 * Several "tabs" are several refreshers over ONE shared localStorage and ONE
 * cookie jar, talking to a model of the server engine that implements the same
 * rules as lib/auth/refresh-session.ts: rotate on the current secret; recover a
 * rotated one only inside its fixed 120 s grace; past the grace, revoke only on
 * positive evidence of a second holder, otherwise refuse without revoking.
 *
 * The jar is last-write-wins on RESPONSE ARRIVAL, exactly like a browser, which
 * is what makes the hazard reproducible: two overlapping refreshes can leave the
 * jar holding the older secret. A control run without the lock shows that it
 * happens; the locked runs show that it does not — for Web Locks and for the
 * localStorage lease alike, across seeded randomised interleavings.
 *
 * A real-browser companion (scripts/qa/auth/refresh-multitab.browser.mjs) runs
 * the bundled module in several Chromium pages against a real HttpOnly cookie.
 */

import {
  createRefresher,
  RETRY_DELAYS_MS,
  SERVER_GRACE_MS,
  REFRESH_LEASE_KEY,
  type RefreshEnv,
  type LockManagerLike,
  type RefreshResult,
} from "@/lib/auth/refresh-client";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// ── deterministic randomness ────────────────────────────────────────────────
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── virtual clock ───────────────────────────────────────────────────────────
type Timer = { at: number; seq: number; fire: () => void };
class Clock {
  t = 0;
  private timers: Timer[] = [];
  private seq = 0;
  sleep = (ms: number) => new Promise<void>((r) => this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, fire: r }));
  setInterval = (fn: () => void, ms: number) => {
    const h = { active: true };
    const arm = () => this.timers.push({ at: this.t + ms, seq: this.seq++, fire: () => { if (h.active) { fn(); arm(); } } });
    arm();
    return h;
  };
  clearInterval = (h: unknown) => { (h as { active: boolean }).active = false; };
  now = () => this.t;
  /** Drive time forward until `p` settles (or a safety bound is hit). */
  async runUntil<T>(p: Promise<T>, maxMs = 10 * 60_000): Promise<T> {
    let settled = false;
    let value: T;
    let error: unknown;
    let threw = false;
    p.then((v) => { settled = true; value = v; }, (e) => { settled = true; threw = true; error = e; });
    const bound = this.t + maxMs;
    for (;;) {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      if (settled) break;
      this.timers = this.timers.filter((x) => x !== undefined);
      if (this.timers.length === 0) throw new Error("deadlock: nothing scheduled and the work has not settled");
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift() as Timer;
      if (next.at > bound) throw new Error(`virtual time bound exceeded (${next.at} ms)`);
      this.t = next.at;
      next.fire();
    }
    if (threw) throw error;
    return value!;
  }
}

// ── shared origin: localStorage + cookie jar ────────────────────────────────
function makeStorage() {
  const m = new Map<string, string>();
  return {
    map: m,
    api: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    },
  };
}

// ── the server engine, modelled ─────────────────────────────────────────────
class ServerModel {
  current = "s0";
  history = new Map<string, number>(); // secret -> graceUntil (fixed at rotation)
  lastUsedAt = 0;
  revoked = false;
  rotations = 0;
  revocations = 0;
  private n = 0;
  constructor(private clock: Clock) {}
  private rotate(): string {
    const prev = this.current;
    this.n += 1;
    this.current = `s${this.n}`;
    this.history.set(prev, this.clock.t + SERVER_GRACE_MS);
    this.lastUsedAt = this.clock.t;
    this.rotations += 1;
    return this.current;
  }
  handle(cookie: string | null): { status: number; setCookie?: string; token?: string } {
    if (this.revoked || cookie === null) return { status: 401 };
    if (cookie === this.current) {
      const s = this.rotate();
      return { status: 200, setCookie: s, token: `tok-${s}` };
    }
    const graceUntil = this.history.get(cookie);
    if (graceUntil === undefined) return { status: 401 };
    if (this.clock.t <= graceUntil) {
      const s = this.rotate();
      return { status: 200, setCookie: s, token: `tok-${s}` };
    }
    if (this.lastUsedAt > graceUntil) {
      this.revoked = true;
      this.revocations += 1;
    }
    return { status: 401 };
  }
}

class FifoLocks implements LockManagerLike {
  private held = false;
  private q: Array<() => void> = [];
  async request<T>(_name: string, _o: { mode: "exclusive" }, cb: () => Promise<T>): Promise<T> {
    if (this.held) await new Promise<void>((r) => this.q.push(r));
    this.held = true;
    try {
      return await cb();
    } finally {
      const next = this.q.shift();
      if (next) next();
      else this.held = false;
    }
  }
}

/** Grants immediately, excludes nobody. The control: what happens without a lock. */
class NoOpLocks implements LockManagerLike {
  request<T>(_n: string, _o: { mode: "exclusive" }, cb: () => Promise<T>): Promise<T> {
    return cb();
  }
}

type World = {
  clock: Clock;
  server: ServerModel;
  storage: ReturnType<typeof makeStorage>;
  jar: { value: string | null };
  requests: RequestInit[];
  /** Set to make the server's NEXT response(s) vanish after it has acted. */
  lose: { next: number };
  offline: { until: number };
};

function makeWorld(): World {
  const clock = new Clock();
  return {
    clock,
    server: new ServerModel(clock),
    storage: makeStorage(),
    jar: { value: "s0" },
    requests: [],
    lose: { next: 0 },
    offline: { until: -1 },
  };
}

function tabEnv(w: World, id: string, locks: LockManagerLike | null, rand: () => number): RefreshEnv {
  return {
    storage: () => w.storage.api,
    locks: () => locks,
    fetch: async (_url, init) => {
      w.requests.push(init);
      if (w.clock.t < w.offline.until) {
        await w.clock.sleep(5);
        throw new TypeError("Failed to fetch");
      }
      const cookieAtSend = w.jar.value; // the browser attaches the jar AS SENT
      await w.clock.sleep(Math.floor(rand() * 40));
      const r = w.server.handle(cookieAtSend);
      await w.clock.sleep(Math.floor(rand() * 40));
      if (w.lose.next > 0) {
        w.lose.next -= 1;
        throw new TypeError("network connection was lost"); // jar NOT updated
      }
      if (r.setCookie) w.jar.value = r.setCookie; // last response to ARRIVE wins
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => (r.token ? { token: r.token } : {}),
      } as unknown as Response;
    },
    sleep: w.clock.sleep,
    now: w.clock.now,
    setInterval: w.clock.setInterval,
    clearInterval: w.clock.clearInterval,
    ownerId: id,
  };
}

async function tabsRefreshTogether(
  w: World,
  n: number,
  locks: (i: number) => LockManagerLike | null,
  rand: () => number
): Promise<RefreshResult[]> {
  const tabs = Array.from({ length: n }, (_, i) => createRefresher(tabEnv(w, `tab-${i}`, locks(i), rand)));
  // Every tab saw the same expired token and decided to refresh in the same instant.
  return w.clock.runUntil(Promise.all(tabs.map((t) => t.refresh())));
}

async function main() {
  // ── the schedule is inside the grace ──────────────────────────────────────
  {
    const sum = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    ok(`retry schedule sums to ${sum} ms, inside the ${SERVER_GRACE_MS} ms grace`, sum < SERVER_GRACE_MS);
    ok("...with headroom for the requests themselves (>= 30 s)", SERVER_GRACE_MS - sum >= 30_000, `${SERVER_GRACE_MS - sum}`);
  }

  // ── CONTROL: without a lock, overlapping refreshes corrupt the jar ───────
  {
    let stale = 0;
    let doubleRotations = 0;
    const TRIALS = 200;
    for (let s = 1; s <= TRIALS; s++) {
      const w = makeWorld();
      w.storage.map.set("token", "tok-s0");
      const shared = new NoOpLocks();
      await tabsRefreshTogether(w, 2, () => shared, prng(s));
      if (w.server.rotations > 1) doubleRotations += 1;
      if (w.jar.value !== w.server.current) stale += 1;
    }
    console.log(`  [measured] control without a lock: ${doubleRotations}/${TRIALS} trials rotated twice, ${stale}/${TRIALS} left a STALE jar`);
    ok("CONTROL: the hazard is real without a lock (some trials leave a stale jar)", stale > 0, `${stale}`);
  }

  // ── Web Locks: one rotation, jar always current ──────────────────────────
  for (const n of [2, 5]) {
    let bad = 0;
    let detail = "";
    const TRIALS = 200;
    for (let s = 1; s <= TRIALS; s++) {
      const w = makeWorld();
      w.storage.map.set("token", "tok-s0");
      const shared = new FifoLocks();
      const results = await tabsRefreshTogether(w, n, () => shared, prng(1000 + s));
      const good =
        w.server.rotations === 1 &&
        w.jar.value === w.server.current &&
        results.every((r) => r === "refreshed") &&
        w.storage.map.get("token") === `tok-${w.server.current}`;
      if (!good && !detail) detail = `seed ${1000 + s}: rotations=${w.server.rotations} jar=${w.jar.value} current=${w.server.current} results=${results}`;
      if (!good) bad += 1;
    }
    ok(`WEB LOCKS, ${n} tabs x ${TRIALS} seeded interleavings: exactly ONE rotation, jar current, every tab refreshed`, bad === 0, detail);
  }

  // ── fallback lease: same guarantee ───────────────────────────────────────
  for (const n of [2, 5]) {
    let bad = 0;
    let detail = "";
    const TRIALS = 200;
    for (let s = 1; s <= TRIALS; s++) {
      const w = makeWorld();
      w.storage.map.set("token", "tok-s0");
      const rand = prng(5000 + s);
      // Tabs do not start in lockstep: each wakes after its own small delay.
      const tabs = Array.from({ length: n }, (_, i) => createRefresher(tabEnv(w, `tab-${i}`, null, rand)));
      const results = await w.clock.runUntil(
        Promise.all(tabs.map(async (t) => {
          await w.clock.sleep(Math.floor(rand() * 200));
          return t.refresh({ startToken: "tok-s0" });
        }))
      );
      const good =
        w.server.rotations === 1 &&
        w.jar.value === w.server.current &&
        results.every((r) => r === "refreshed") &&
        !w.storage.map.has(REFRESH_LEASE_KEY);
      if (!good && !detail) detail = `seed ${5000 + s}: rotations=${w.server.rotations} jar=${w.jar.value} current=${w.server.current} results=${results} lease=${w.storage.map.get(REFRESH_LEASE_KEY)}`;
      if (!good) bad += 1;
    }
    ok(`LEASE FALLBACK, ${n} tabs x ${TRIALS} seeded interleavings: ONE rotation, jar current, lease released`, bad === 0, detail);
  }

  // ── lost response, recovered inside the grace ────────────────────────────
  {
    const w = makeWorld();
    w.storage.map.set("token", "tok-s0");
    w.lose.next = 1; // the server rotates, the response never arrives
    const r = await w.clock.runUntil(createRefresher(tabEnv(w, "t", new FifoLocks(), prng(7))).refresh());
    ok("LOST RESPONSE: the retry recovers the session", r === "refreshed", r);
    ok("...two rotations: the lost one and the grace recovery", w.server.rotations === 2, `${w.server.rotations}`);
    ok("...the jar holds the CURRENT secret afterwards", w.jar.value === w.server.current, `${w.jar.value}/${w.server.current}`);
    ok("...recovered well inside the grace", w.clock.t < SERVER_GRACE_MS, `${w.clock.t}`);
    ok("...nothing was revoked", w.server.revocations === 0);
  }
  {
    // Lost, then offline through the WHOLE schedule. The client reports a
    // failure; it does not widen the window and it does not sign out.
    const w = makeWorld();
    w.storage.map.set("token", "tok-s0");
    w.lose.next = 1;
    w.offline.until = 10 * 60_000; // set after the first request (below)
    const env = tabEnv(w, "t", new FifoLocks(), prng(8));
    let first = true;
    const inner = env.fetch;
    env.fetch = async (u, i) => {
      if (first) {
        first = false;
        const saved = w.offline.until;
        w.offline.until = -1;
        try { return await inner(u, i); } finally { w.offline.until = saved; }
      }
      return inner(u, i);
    };
    const r = await w.clock.runUntil(createRefresher(env).refresh());
    ok("LOST + OFFLINE: reported as a transient failure", r === "failed", r);
    ok("...the token is untouched", w.storage.map.get("token") === "tok-s0");
    ok(`...attempts made: 1 + ${RETRY_DELAYS_MS.length} retries`, w.requests.length === 1 + RETRY_DELAYS_MS.length, `${w.requests.length}`);
    // Back online long after the grace: the server refuses the stale secret
    // WITHOUT revoking — no second holder ever used the session.
    w.offline.until = -1;
    w.clock.t = 10 * 60_000 + 1;
    const later = await w.clock.runUntil(createRefresher(env).refresh());
    ok("...past the grace the server refuses (unauthenticated)", later === "unauthenticated", later);
    ok("...and NOTHING was revoked: a lost response is not treated as theft", w.server.revocations === 0 && !w.server.revoked);
  }

  // ── verdicts are final; requests are keepalive and never aborted ─────────
  for (const status of [401, 403]) {
    const w = makeWorld();
    w.storage.map.set("token", "tok-s0");
    w.server.revoked = true;
    const env = tabEnv(w, "t", new FifoLocks(), prng(9));
    const inner = env.fetch;
    env.fetch = async (u, i) => { const res = await inner(u, i); return { ...res, ok: false, status, json: async () => ({}) } as unknown as Response; };
    const r = await w.clock.runUntil(createRefresher(env).refresh());
    ok(`${status}: unauthenticated after ONE request (no retry on a verdict)`, r === "unauthenticated" && w.requests.length === 1, `${r} ${w.requests.length}`);
  }
  {
    const w = makeWorld();
    w.storage.map.set("token", "tok-s0");
    await w.clock.runUntil(createRefresher(tabEnv(w, "t", new FifoLocks(), prng(10))).refresh());
    ok("every request is keepalive", w.requests.length > 0 && w.requests.every((i) => i.keepalive === true));
    ok("...and carries no AbortSignal", w.requests.every((i) => i.signal === undefined || i.signal === null));
    ok("...and sends the cookie (credentials same-origin)", w.requests.every((i) => i.credentials === "same-origin"));
  }

  // ── lease edge cases ─────────────────────────────────────────────────────
  {
    // A tab died holding the lease: no heartbeat. The waiter takes over after
    // the TTL, refreshes once, and the jar ends current.
    const w = makeWorld();
    w.storage.map.set("token", "tok-s0");
    w.storage.map.set(REFRESH_LEASE_KEY, JSON.stringify({ owner: "dead-tab", until: 15_000 }));
    const r = await w.clock.runUntil(createRefresher(tabEnv(w, "t", null, prng(11))).refresh());
    ok("DEAD HOLDER: the waiter takes over after the lease lapses", r === "refreshed" && w.clock.t >= 15_000, `${r} t=${w.clock.t}`);
    ok("...one rotation", w.server.rotations === 1);
  }
  {
    // A LIVE holder whose retries outlast the TTL keeps the lease by heartbeat;
    // the other tab must not enter until it is released.
    const w = makeWorld();
    w.storage.map.set("token", "tok-s0");
    w.offline.until = 30_000; // the holder fails for 30 s, then succeeds on a retry
    const rand = prng(12);
    const aEnv = tabEnv(w, "a", null, rand);
    const bEnv = tabEnv(w, "b", null, rand);
    let bRequests = 0;
    const bFetch = bEnv.fetch;
    bEnv.fetch = (u, i) => { bRequests += 1; return bFetch(u, i); };
    const a = createRefresher(aEnv);
    const b = createRefresher(bEnv);
    const results = await w.clock.runUntil(Promise.all([
      a.refresh({ startToken: "tok-s0" }),
      (async () => { await w.clock.sleep(500); return b.refresh({ startToken: "tok-s0" }); })(),
    ]));
    ok("LIVE HOLDER beyond the TTL: the holder took > TTL (the case under test)", w.clock.t > 15_000, `${w.clock.t}`);
    ok("...the waiter sent ZERO requests while the holder was still retrying", bRequests === 0, `${bRequests}`);
    ok("...one rotation, jar current", w.server.rotations === 1 && w.jar.value === w.server.current, `rotations=${w.server.rotations}`);
    ok("...both tabs end refreshed (the waiter adopts the holder's token)", results.every((r) => r === "refreshed"), `${results}`);
  }
  {
    // A holder that never finishes (a request that hangs forever). The waiter
    // gives up and reports a failure rather than refreshing without the lock.
    const w = makeWorld();
    w.storage.map.set("token", "tok-s0");
    const hung = tabEnv(w, "hung", null, prng(13));
    hung.fetch = () => new Promise<Response>(() => {});
    const waiterEnv = tabEnv(w, "waiter", null, prng(14));
    void createRefresher(hung).refresh({ startToken: "tok-s0" });
    const before = w.requests.length;
    const r = await w.clock.runUntil((async () => { await w.clock.sleep(1000); return createRefresher(waiterEnv).refresh({ startToken: "tok-s0" }); })());
    ok("HUNG HOLDER: the waiter gives up with a failure", r === "failed", r);
    ok("...and never sent a request without the lock", w.requests.length === before, `${w.requests.length - before}`);
  }

  // ── adoption and release ────────────────────────────────────────────────
  {
    const w = makeWorld();
    w.storage.map.set("token", "tok-other");
    const r = await w.clock.runUntil(createRefresher(tabEnv(w, "t", new FifoLocks(), prng(15))).refresh({ startToken: "tok-rejected" }));
    ok("ALREADY REPLACED: no request, reported refreshed", r === "refreshed" && w.requests.length === 0);
  }
  {
    const w = makeWorld();
    w.storage.map.set("token", "tok-s0");
    const env = tabEnv(w, "t", null, prng(16));
    const inner = env.fetch;
    let n = 0;
    env.fetch = async (u, i) => { n += 1; if (n === 1) throw new Error("boom"); return inner(u, i); };
    const refresher = createRefresher(env);
    const r1 = await w.clock.runUntil(refresher.refresh());
    ok("an exception inside an attempt is a transient failure, retried", r1 === "refreshed", r1);
    ok("...and the lease is released afterwards", !w.storage.map.has(REFRESH_LEASE_KEY));
  }
  {
    // Web Locks + a lost response in the tab holding the lock: the tab waiting
    // behind it adopts the recovered token instead of rotating again.
    const w = makeWorld();
    w.storage.map.set("token", "tok-s0");
    w.lose.next = 1;
    const shared = new FifoLocks();
    const results = await tabsRefreshTogether(w, 3, () => shared, prng(17));
    ok("LOST RESPONSE under contention: every tab refreshed", results.every((r) => r === "refreshed"), `${results}`);
    ok("...exactly two rotations (lost + recovery), never one per tab", w.server.rotations === 2, `${w.server.rotations}`);
    ok("...jar current", w.jar.value === w.server.current);
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

void main().catch((e) => {
  console.error("TEST ERROR:", e);
  process.exit(1);
});
