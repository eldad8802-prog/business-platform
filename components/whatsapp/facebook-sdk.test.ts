/**
 * Facebook SDK loader. Run with:
 *   npx tsx components/whatsapp/facebook-sdk.test.ts
 *
 * Reproduces Meta's real two-stage load against a fake host: `sdk.js` installs
 * a buffering STUB (`__buffer`, `init` stores options, `login` pushes into a
 * buffer), then the real bundle REPLACES `window.FB`, replays the buffer once,
 * and calls `window.fbAsyncInit`. The Production defect was initializing and
 * keeping the stub; these tests prove the loader never does.
 */
import assert from "node:assert/strict";
import {
  getLiveFacebookSdk,
  isFacebookLoaderStubPresent,
  isRealFacebookSdk,
  loadFacebookSdk,
  resetFacebookSdkLoaderForTests,
  SDK_READY_TIMEOUT_MS,
  type SdkHost,
} from "./facebook-sdk";

const CONFIG = { appId: "APP", configId: "CFG", graphVersion: "v25.0" };

function makeStub() {
  const calls: unknown[] = [];
  const stub = {
    __buffer: { calls, opts: null as unknown },
    init(opts: unknown) {
      stub.__buffer.opts = opts;
    },
    login(...args: unknown[]) {
      calls.push(["login", args]);
    },
  };
  return stub;
}

function makeReal() {
  const inits: unknown[] = [];
  const logins: unknown[] = [];
  return {
    inits,
    logins,
    init(opts: unknown) {
      inits.push(opts);
    },
    login(...args: unknown[]) {
      logins.push(args);
    },
  };
}

function makeHost() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let seq = 1;
  const appended: Array<Record<string, unknown>> = [];
  const byId = new Map<string, unknown>();
  const host: SdkHost = {
    window: {
      setTimeout: (fn, ms) => {
        const id = seq++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id as number);
      },
    },
    document: {
      getElementById: (id) => byId.get(id) ?? null,
      createElement: () => {
        const el: Record<string, unknown> = { id: "", src: "", async: false, defer: false, crossOrigin: null, onerror: null };
        el.remove = () => {
          byId.delete(el.id as string);
          el.removed = true;
        };
        return el as unknown as ReturnType<SdkHost["document"]["createElement"]>;
      },
      body: {
        appendChild: (el) => {
          const e = el as Record<string, unknown>;
          appended.push(e);
          byId.set(e.id as string, e);
          return el;
        },
      },
    },
  };
  return {
    host,
    appended,
    timers,
    /** sdk.js ran: the buffering stub is installed. */
    loaderRan() {
      const stub = makeStub();
      host.window.FB = stub;
      return stub;
    },
    /** The real bundle arrived: replaces window.FB and calls fbAsyncInit. */
    bundleArrived() {
      const real = makeReal();
      host.window.FB = real;
      host.window.fbAsyncInit?.();
      return real;
    },
    fireTimeout() {
      const due = [...timers.entries()].filter(([, t]) => t.ms === SDK_READY_TIMEOUT_MS);
      due.forEach(([id]) => timers.delete(id));
      due.forEach(([, t]) => t.fn());
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let checks = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  resetFacebookSdkLoaderForTests();
  await fn();
  checks++;
  console.log(`  ok  ${name}`);
}

async function main() {
  console.log("\nFacebook SDK loader\n");

  await test("the loader stub is NOT the real SDK; Meta's real SDK is", () => {
    assert.equal(isRealFacebookSdk(makeStub()), false, "stub (has __buffer) rejected");
    assert.equal(isRealFacebookSdk(makeReal()), true);
    assert.equal(isRealFacebookSdk({ init() {} }), false, "no login");
    assert.equal(isRealFacebookSdk(null), false);
  });

  await test("PRODUCTION DEFECT: the stub at the loader's onload is never initialized or returned", async () => {
    const h = makeHost();
    let resolved: unknown = null;
    void loadFacebookSdk(CONFIG, h.host).then((fb) => (resolved = fb));
    assert.equal(h.appended.length, 1, "sdk.js injected");
    const s = h.appended[0];
    assert.equal(s.src, "https://connect.facebook.net/en_US/sdk.js");
    assert.equal(s.crossOrigin, "anonymous");
    assert.equal("onload" in s && typeof s.onload === "function", false, "no init-at-onload handler");
    const stub = h.loaderRan();
    await flush();
    assert.equal(resolved, null, "not resolved while window.FB is the stub");
    assert.equal(stub.__buffer.opts, null, "init was NOT called on the stub");
    assert.equal(isFacebookLoaderStubPresent(h.host), true);
    assert.equal(getLiveFacebookSdk(h.host), null, "a stub is never handed out as the live SDK");
  });

  await test("the real bundle arrives → resolves with the REAL SDK, initialized exactly once with the config", async () => {
    const h = makeHost();
    const p = loadFacebookSdk(CONFIG, h.host);
    h.loaderRan();
    const real = h.bundleArrived();
    const fb = await p;
    assert.equal(fb, real, "resolved with the replacing real object");
    assert.deepEqual(real.inits, [{ appId: "APP", version: "v25.0", cookie: false, xfbml: false }]);
    assert.equal(getLiveFacebookSdk(h.host), real);
    assert.equal(h.timers.size, 0, "readiness timer cleared");
  });

  await test("a login on the live SDK reaches the REAL object (not a dead buffer)", async () => {
    const h = makeHost();
    const p = loadFacebookSdk(CONFIG, h.host);
    const stub = h.loaderRan();
    const real = h.bundleArrived();
    await p;
    getLiveFacebookSdk(h.host)!.login(() => {}, { config_id: "CFG", response_type: "code", override_default_response_type: true });
    assert.equal(real.logins.length, 1, "real login called");
    assert.equal(stub.__buffer.calls.length, 0, "nothing swallowed by the stub");
  });

  await test("fbAsyncInit while window.FB is still the stub is ignored; the later real call resolves", async () => {
    const h = makeHost();
    let resolved = false;
    const p = loadFacebookSdk(CONFIG, h.host).then(() => (resolved = true));
    h.loaderRan();
    h.host.window.fbAsyncInit?.();
    await flush();
    assert.equal(resolved, false);
    h.bundleArrived();
    await p;
    assert.equal(resolved, true);
  });

  await test("real SDK already present → resolves at once, no second script, init once per object", async () => {
    const h = makeHost();
    const real = makeReal();
    h.host.window.FB = real;
    const a = await loadFacebookSdk(CONFIG, h.host);
    const b = await loadFacebookSdk(CONFIG, h.host);
    assert.equal(a, real);
    assert.equal(b, real);
    assert.equal(h.appended.length, 0);
    assert.equal(real.inits.length, 1, "initialized once");
  });

  await test("concurrent loads share one in-flight promise and one script", async () => {
    const h = makeHost();
    const p1 = loadFacebookSdk(CONFIG, h.host);
    const p2 = loadFacebookSdk(CONFIG, h.host);
    assert.equal(p1, p2);
    assert.equal(h.appended.length, 1);
    h.loaderRan();
    h.bundleArrived();
    assert.equal(await p1, await p2);
  });

  await test("an existing fbAsyncInit from another integration is still called", async () => {
    const h = makeHost();
    let previousCalled = 0;
    h.host.window.fbAsyncInit = () => {
      previousCalled++;
    };
    const p = loadFacebookSdk(CONFIG, h.host);
    h.loaderRan();
    h.bundleArrived();
    await p;
    assert.equal(previousCalled, 1);
  });

  await test("script load failure → rejects, removes the failed tag, and a retry injects a fresh one", async () => {
    const h = makeHost();
    const p = loadFacebookSdk(CONFIG, h.host);
    const s = h.appended[0] as { onerror: () => void; removed?: boolean };
    s.onerror();
    await assert.rejects(p, /failed to load/);
    assert.equal(s.removed, true, "failed tag removed");
    const retry = loadFacebookSdk(CONFIG, h.host);
    assert.notEqual(retry, p);
    assert.equal(h.appended.length, 2, "fresh script on retry");
    h.loaderRan();
    h.bundleArrived();
    await retry;
  });

  await test("the real SDK never arrives → rejects after the bounded wait; retry allowed", async () => {
    const h = makeHost();
    const p = loadFacebookSdk(CONFIG, h.host);
    h.loaderRan();
    h.fireTimeout();
    await assert.rejects(p, /did not become ready/);
    const retry = loadFacebookSdk(CONFIG, h.host);
    assert.notEqual(retry, p, "a fresh attempt after the timeout");
  });

  await test("server (no host) → rejects cleanly", async () => {
    await assert.rejects(loadFacebookSdk(CONFIG, null), /only load in the browser/);
  });

  console.log(`\nALL FACEBOOK SDK LOADER TESTS PASSED — ${checks} checks\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
