/**
 * Refresh client coordinator (run manually):
 *   npx tsx lib/auth/refresh-client.test.ts
 *
 * The property that matters most here is single flight. Boot, the timer and a
 * return from background can all fire in the same instant — opening a laptop lid
 * does all three — and every refresh ROTATES the credential. Overlapping
 * requests would turn one wake-up into a chain of rotations where every response
 * but the last is already stale.
 */

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

/** A token whose payload is readable but whose signature is meaningless here. */
function fakeToken(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ sub: 1, exp: expSeconds }), "utf8").toString(
    "base64url"
  );
  return `v1.${payload}.sig`;
}

type Listener = () => void;

function installBrowser(initialToken: string | null) {
  const store = new Map<string, string>();
  if (initialToken !== null) store.set("token", initialToken);
  const listeners: Record<string, Listener[]> = {};
  const add = (t: string, fn: Listener) => {
    (listeners[t] ??= []).push(fn);
  };
  const fire = (t: string) => (listeners[t] ?? []).forEach((fn) => fn());

  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    addEventListener: add,
    removeEventListener: () => {},
  };
  g.document = {
    visibilityState: "visible",
    addEventListener: add,
    removeEventListener: () => {},
  };
  return { store, fire };
}

async function main() {
  const NOW = 1_800_000_000_000;

  installBrowser(fakeToken(Math.floor(NOW / 1000) + 3600));
  const mod = await import("@/lib/auth/refresh-client");

  // ---- pure helpers -------------------------------------------------------
  {
    ok("reads exp out of the token payload", mod.readTokenExpiry(fakeToken(1000)) === 1_000_000);
    ok("a malformed token has no expiry", mod.readTokenExpiry("garbage") === null);
    ok("no token has no expiry", mod.readTokenExpiry(null) === null);
    ok(
      "refresh is due before expiry, not at it",
      mod.msUntilRefresh(NOW, NOW + 10 * 60_000) > 0 &&
        mod.msUntilRefresh(NOW, NOW + 10 * 60_000) < 10 * 60_000
    );
    ok("an already-expired token is due now", mod.msUntilRefresh(NOW, NOW - 1) === 0);
    ok("a token inside the skew window is due now", mod.msUntilRefresh(NOW, NOW + 60_000) === 0);
    ok("a far-future expiry is capped, so a long-lived tab still checks in",
      mod.msUntilRefresh(NOW, NOW + 30 * 86_400_000) <= 6 * 60 * 60 * 1000);
    ok("expiry detection", mod.isTokenExpired(NOW, NOW - 1) && !mod.isTokenExpired(NOW, NOW + 1));
  }

  // ---- single flight ------------------------------------------------------
  {
    mod.__testing.resetInFlight();
    let calls = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      calls += 1;
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: fakeToken(Math.floor(NOW / 1000) + 7200) }),
      } as unknown as Response;
    };

    const a = mod.refreshAccessToken();
    const b = mod.refreshAccessToken();
    const c = mod.refreshAccessToken();
    ok("concurrent callers share one in-flight request", a === b && b === c);
    release?.();
    const results = await Promise.all([a, b, c]);
    ok("exactly one network request was made", calls === 1, `${calls}`);
    ok("all callers see the same result", results.every((r) => r === "refreshed"));

    // A later call, after the first settled, is allowed to go again.
    const d = mod.refreshAccessToken();
    await d;
    ok("a subsequent refresh is not blocked by the finished one", calls === 2, `${calls}`);
  }

  // ---- server verdicts ----------------------------------------------------
  {
    mod.__testing.resetInFlight();
    (globalThis as unknown as { fetch: unknown }).fetch = async () =>
      ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response;
    ok("401 is reported as unauthenticated", (await mod.refreshAccessToken()) === "unauthenticated");

    mod.__testing.resetInFlight();
    (globalThis as unknown as { fetch: unknown }).fetch = async () =>
      ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response;
    ok("403 is reported as unauthenticated", (await mod.refreshAccessToken()) === "unauthenticated");

    mod.__testing.resetInFlight();
    (globalThis as unknown as { fetch: unknown }).fetch = async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;
    ok("a server error is a failure, not a sign-out", (await mod.refreshAccessToken()) === "failed");

    mod.__testing.resetInFlight();
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      throw new Error("offline");
    };
    ok("being offline is a failure, not a sign-out", (await mod.refreshAccessToken()) === "failed");

    mod.__testing.resetInFlight();
    (globalThis as unknown as { fetch: unknown }).fetch = async () =>
      ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response;
    ok("a 200 with no token is a failure", (await mod.refreshAccessToken()) === "failed");
  }

  // ---- coordinator triggers ----------------------------------------------
  {
    // Boot with a spent token: it must refresh before anything else happens.
    const browser = installBrowser(fakeToken(Math.floor(NOW / 1000) - 10));
    let refreshes = 0;
    const handle = mod.startRefreshCoordinator({
      now: () => NOW,
      refresh: async () => {
        refreshes += 1;
        browser.store.set("token", fakeToken(Math.floor(NOW / 1000) + 7200));
        return "refreshed";
      },
    });
    await new Promise((r) => setImmediate(r));
    ok("boot refreshes a token that is already spent", refreshes === 1, `${refreshes}`);

    // A wake-up with a healthy token must NOT refresh: a tab switched to and
    // from every few seconds would otherwise become a refresh generator.
    browser.fire("visibilitychange");
    await new Promise((r) => setImmediate(r));
    ok("returning to a healthy tab does not refresh", refreshes === 1, `${refreshes}`);

    // A wake-up after the token expired must refresh before activity resumes.
    browser.store.set("token", fakeToken(Math.floor(NOW / 1000) - 10));
    browser.fire("focus");
    await new Promise((r) => setImmediate(r));
    ok("returning from sleep past expiry refreshes", refreshes === 2, `${refreshes}`);

    handle.stop();
    browser.store.set("token", fakeToken(Math.floor(NOW / 1000) - 10));
    browser.fire("focus");
    await new Promise((r) => setImmediate(r));
    ok("a stopped coordinator does nothing", refreshes === 2, `${refreshes}`);
  }

  // Signed out: no token means no request. Asking would only tell an anonymous
  // visitor that they are anonymous.
  {
    installBrowser(null);
    let refreshes = 0;
    const handle = mod.startRefreshCoordinator({
      now: () => NOW,
      refresh: async () => {
        refreshes += 1;
        return "refreshed";
      },
    });
    await new Promise((r) => setImmediate(r));
    ok("no token means no refresh request", refreshes === 0);
    handle.stop();
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

void main();
