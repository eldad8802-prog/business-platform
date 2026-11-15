/**
 * Cookie-jar persistence hook (no browser, no device):
 *   npx tsx lib/native/auth-cookies.test.ts
 *
 * The device proof lives in the emulator QA (kill 3 s after sign-in / after a
 * refresh, then relaunch). This locks the web half: the refresh client asks for
 * persistence once per RECEIVED auth response — success or refusal, since either
 * may set or clear the cookie — and never when no response arrived; and the
 * helper is a silent no-op outside the Android app.
 */

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

async function main() {
  const { createRefresher } = await import("@/lib/auth/refresh-client");

  const store = new Map<string, string>([["token", "t0"]]);
  const env = (respond: () => Promise<Response>, counter: { n: number }) => ({
    storage: () => ({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }),
    locks: () => null,
    fetch: respond,
    sleep: async () => {},
    now: () => Date.now(),
    setInterval: () => 0,
    clearInterval: () => {},
    ownerId: "t",
    afterAuthResponse: () => { counter.n += 1; },
  });

  for (const [label, status, body] of [["200 rotated", 200, { token: "t1" }], ["401 refused", 401, {}], ["500 error", 500, {}]] as const) {
    store.set("token", "t0");
    const c = { n: 0 };
    let calls = 0;
    const r = createRefresher(env(async () => { calls += 1; return { ok: status === 200, status, json: async () => body } as unknown as Response; }, c));
    await r.refresh({ startToken: "t0" });
    ok(`${label}: persistence requested once per received response`, c.n === calls && c.n >= 1, `requests=${calls} persists=${c.n}`);
  }
  {
    const c = { n: 0 };
    const r = createRefresher(env(async () => { throw new TypeError("Failed to fetch"); }, c));
    await r.refresh({ startToken: "t0" });
    ok("network failure: no response, nothing to persist", c.n === 0, `${c.n}`);
  }

  const { flushAuthCookies } = await import("@/lib/native/auth-cookies");
  let threw = false;
  try { await flushAuthCookies(); } catch { threw = true; }
  ok("outside the Android app the helper is a silent no-op", !threw);

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

void main().catch((e) => { console.error("TEST ERROR:", e); process.exit(1); });
