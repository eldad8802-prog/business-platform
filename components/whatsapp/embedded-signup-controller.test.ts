/**
 * Unit tests for the Embedded Signup controller. Run with:
 *   npx tsx components/whatsapp/embedded-signup-controller.test.ts
 *
 * Framework-agnostic: the controller takes injected deps, so the whole flow
 * (preload, synchronous FB.login, timeout recovery, listener/timer cleanup) is
 * exercised here with fakes — no browser, no React, no network.
 */
import assert from "node:assert/strict";
import {
  createEmbeddedSignupController,
  isWaDiagEnabled,
} from "./embedded-signup-controller";
import type {
  EmbeddedSignupDiag,
  EmbeddedSignupEnv,
} from "./embedded-signup-controller";
import type { FacebookSdk, FbLoginResponse } from "./facebook-sdk";

type LoginOpts = {
  config_id: string;
  response_type: string;
  override_default_response_type: boolean;
  extras: { featureType: string; sessionInfoVersion: string };
};

type DiagCall = { event: string; data: Record<string, unknown> };

function makeHarness(opts?: { diag?: boolean }) {
  let loadCalls = 0;
  let loginCalls = 0;
  let lastLoginCb: ((r: FbLoginResponse) => void) | null = null;
  let lastOpts: unknown = null;

  const fakeFb: FacebookSdk = {
    init: () => {},
    login: (cb, opts) => {
      loginCalls++;
      lastLoginCb = cb;
      lastOpts = opts;
    },
  };

  let resolveSdk: ((fb: FacebookSdk) => void) | null = null;
  let rejectSdk: ((e: unknown) => void) | null = null;
  let sdkPromise: Promise<FacebookSdk> | null = null;

  let messageListeners: Array<(ev: { origin: string; data: unknown }) => void> = [];
  const timers = new Map<number, () => void>();
  let timerSeq = 1;

  const env: EmbeddedSignupEnv = {
    getConfig: () => ({ appId: "APP", configId: "CFG", graphVersion: "v25.0" }),
    loadSdk: () => {
      loadCalls++;
      sdkPromise = new Promise<FacebookSdk>((res, rej) => {
        resolveSdk = res;
        rejectSdk = rej;
      });
      return sdkPromise;
    },
    getReadyFb: () => null,
    addMessageListener: (fn) => {
      messageListeners.push(fn);
    },
    removeMessageListener: (fn) => {
      messageListeners = messageListeners.filter((f) => f !== fn);
    },
    setTimer: (fn) => {
      const id = timerSeq++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    timeoutMs: 60_000,
  };

  // Recording fake diag (only when opts.diag). Fixed, secret-free snapshot.
  const diagCalls: DiagCall[] = [];
  let nowCounter = 1000;
  if (opts?.diag) {
    const fakeDiag: EmbeddedSignupDiag = {
      log: (event, data) => diagCalls.push({ event, data: data ?? {} }),
      snapshot: () => ({
        windowFbExists: true,
        sdkScriptExists: true,
        sdkInitialized: true,
        configIdPresent: true,
        appIdPresent: true,
        graphVersion: "v25.0",
        timestamp: 111,
      }),
      isWindowFb: () => false,
      now: () => nowCounter++,
    };
    env.diag = fakeDiag;
  }

  const ctrl = createEmbeddedSignupController(env);

  return {
    ctrl,
    diagCalls,
    diagEvents: () => diagCalls.map((c) => c.event),
    diagFind: (event: string) => diagCalls.find((c) => c.event === event),
    get loadCalls() {
      return loadCalls;
    },
    get loginCalls() {
      return loginCalls;
    },
    get lastOpts() {
      return lastOpts as LoginOpts;
    },
    get timers() {
      return timers;
    },
    get messageListeners() {
      return messageListeners;
    },
    async settleSdk() {
      resolveSdk?.(fakeFb);
      await sdkPromise;
      await Promise.resolve();
    },
    async failSdk() {
      rejectSdk?.(new Error("load fail"));
      try {
        await sdkPromise;
      } catch {
        /* expected */
      }
      await Promise.resolve();
    },
    fireLogin(resp: FbLoginResponse) {
      lastLoginCb?.(resp);
    },
    fireAllTimers() {
      const fns = [...timers.values()];
      timers.clear();
      fns.forEach((f) => f());
    },
    postMessage(msg: unknown, origin = "https://www.facebook.com") {
      messageListeners.forEach((f) => f({ origin, data: msg }));
    },
  };
}

async function main() {
  // 1) SDK is preloaded exactly once (idempotent).
  {
    const h = makeHarness();
    h.ctrl.preload();
    h.ctrl.preload();
    assert.equal(h.loadCalls, 1, "SDK preloaded exactly once");
  }

  // 2) Click when SDK ready → FB.login is called SYNCHRONOUSLY (no async wait
  //    before it), with the correct Embedded Signup params.
  {
    const h = makeHarness();
    h.ctrl.preload();
    await h.settleSdk();
    assert.equal(h.loginCalls, 0);
    h.ctrl.launch();
    assert.equal(h.loginCalls, 1, "FB.login called synchronously within launch()");
    assert.equal(h.ctrl.getState().phase, "launching");
    const o = h.lastOpts;
    assert.equal(o.config_id, "CFG");
    assert.equal(o.response_type, "code");
    assert.equal(o.override_default_response_type, true);
    assert.equal(o.extras.featureType, "whatsapp_business_app_onboarding");
    assert.equal(o.extras.sessionInfoVersion, "3");
  }

  // 3) SDK not ready on click → NOT stuck at "launching"; no FB.login.
  {
    const h = makeHarness();
    h.ctrl.preload(); // in flight, never settled
    h.ctrl.launch();
    assert.equal(h.loginCalls, 0, "FB.login not called when SDK not ready");
    assert.equal(h.ctrl.getState().phase, "error", "not stuck at launching");
  }

  // 3b) SDK load failure → click surfaces error (retryable), never launching.
  {
    const h = makeHarness();
    h.ctrl.preload();
    await h.failSdk();
    h.ctrl.launch();
    assert.equal(h.ctrl.getState().phase, "error", "SDK failure → error on click");
    assert.equal(h.loginCalls, 0);
  }

  // 4) Timeout moves a stuck launching → error and removes the listener.
  {
    const h = makeHarness();
    h.ctrl.preload();
    await h.settleSdk();
    h.ctrl.launch();
    assert.equal(h.ctrl.getState().phase, "launching");
    assert.equal(h.timers.size, 1, "timer armed on launching");
    h.fireAllTimers();
    assert.equal(h.ctrl.getState().phase, "error", "timeout → error");
    assert.equal(h.messageListeners.length, 0, "listener removed on timeout");
  }

  // 5) Success clears the timeout and the listener.
  {
    const h = makeHarness();
    h.ctrl.preload();
    await h.settleSdk();
    h.ctrl.launch();
    h.fireLogin({ authResponse: { code: "CODE123" } });
    assert.equal(h.ctrl.getState().phase, "success");
    assert.equal(h.ctrl.getState().result?.code, "CODE123");
    assert.equal(h.timers.size, 0, "timer cleared on success");
    assert.equal(h.messageListeners.length, 0, "listener removed on success");
  }

  // 6) Cancel clears the timeout.
  {
    const h = makeHarness();
    h.ctrl.preload();
    await h.settleSdk();
    h.ctrl.launch();
    h.postMessage({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: {} });
    assert.equal(h.ctrl.getState().phase, "cancelled");
    assert.equal(h.timers.size, 0, "timer cleared on cancel");
    assert.equal(h.messageListeners.length, 0);
  }

  // 7) Error clears the timeout.
  {
    const h = makeHarness();
    h.ctrl.preload();
    await h.settleSdk();
    h.ctrl.launch();
    h.postMessage({ type: "WA_EMBEDDED_SIGNUP", event: "ERROR", data: {} });
    assert.equal(h.ctrl.getState().phase, "error");
    assert.equal(h.timers.size, 0, "timer cleared on error");
    assert.equal(h.messageListeners.length, 0);
  }

  // 8) Dispose (unmount) clears listener + timer.
  {
    const h = makeHarness();
    h.ctrl.preload();
    await h.settleSdk();
    h.ctrl.launch();
    assert.equal(h.timers.size, 1);
    assert.equal(h.messageListeners.length, 1);
    h.ctrl.dispose();
    assert.equal(h.timers.size, 0, "timer cleared on dispose");
    assert.equal(h.messageListeners.length, 0, "listener removed on dispose");
  }

  // 9) Retry (reset → relaunch) leaves exactly one timer + one listener — no
  //    leftovers from the previous attempt.
  {
    const h = makeHarness();
    h.ctrl.preload();
    await h.settleSdk();
    h.ctrl.launch();
    h.ctrl.reset();
    assert.equal(h.timers.size, 0, "reset clears timer");
    assert.equal(h.messageListeners.length, 0, "reset clears listener");
    h.ctrl.launch();
    assert.equal(h.timers.size, 1, "exactly one timer after retry");
    assert.equal(h.messageListeners.length, 1, "exactly one listener after retry");
  }

  // 10) An Embedded Signup progress message (not CANCEL/ERROR) keeps the flow
  //     alive and re-arms the recovery timer (so a slow user is not cut off).
  {
    const h = makeHarness();
    h.ctrl.preload();
    await h.settleSdk();
    h.ctrl.launch();
    h.postMessage({
      type: "WA_EMBEDDED_SIGNUP",
      data: { phone_number_id: "PN1", waba_id: "WABA1" },
    });
    assert.equal(h.ctrl.getState().phase, "launching", "activity keeps launching");
    assert.equal(h.timers.size, 1, "recovery timer re-armed on activity");
  }

  // ---- Diagnostics instrumentation (temporary, gated) ----

  // D0) The gate is active ONLY for ?waDiag=1.
  {
    assert.equal(isWaDiagEnabled("?waDiag=1"), true);
    assert.equal(isWaDiagEnabled("waDiag=1"), true);
    assert.equal(isWaDiagEnabled("?waDiag=1&x=2"), true);
    assert.equal(isWaDiagEnabled("?waDiag=0"), false);
    assert.equal(isWaDiagEnabled("?other=1"), false);
    assert.equal(isWaDiagEnabled(""), false);
    assert.equal(isWaDiagEnabled(undefined), false);
    assert.equal(isWaDiagEnabled(null), false);
  }

  // D1) With NO diag, nothing is logged and the flow is unchanged (the 10 tests
  //     above already ran diag-off). Sanity: a diag-off harness exposes no calls.
  {
    const h = makeHarness(); // diag off
    h.ctrl.preload();
    await h.settleSdk();
    h.ctrl.launch();
    h.fireLogin({ authResponse: { code: "CODE123" } });
    assert.equal(h.diagCalls.length, 0, "no diagnostics emitted when diag is off");
    assert.equal(h.ctrl.getState().phase, "success", "flow unchanged when diag off");
  }

  // D2) With diag ON, the flow is IDENTICAL and the expected events are logged
  //     with the exact fields, in order, up to a successful login.
  {
    const h = makeHarness({ diag: true });
    h.ctrl.preload();
    await h.settleSdk();
    assert.ok(h.diagFind("preload_resolved"), "preload_resolved logged");

    h.ctrl.launch();
    const call = h.diagFind("fb_login_call");
    assert.ok(call, "fb_login_call logged");
    assert.deepEqual(
      Object.keys(call!.data).sort(),
      [
        "appIdPresent",
        "configIdPresent",
        "graphVersion",
        "hasLoginFn",
        "hasReadyFb",
        "phase",
        "readyFbFromPreload",
        "readyFbIsWindowFb",
        "sdkInitialized",
        "sdkScriptExists",
        "timestamp",
        "windowFbExists",
      ],
      "fb_login_call has exactly the allowed fields"
    );
    assert.equal(call!.data.phase, "launching");
    assert.equal(call!.data.hasReadyFb, true);
    assert.equal(call!.data.hasLoginFn, true);
    assert.equal(call!.data.readyFbFromPreload, true);
    assert.equal(call!.data.configIdPresent, true);
    assert.equal(call!.data.appIdPresent, true);
    // Flow unchanged: FB.login still called synchronously.
    assert.equal(h.loginCalls, 1);
    assert.equal(h.ctrl.getState().phase, "launching");

    h.fireLogin({ authResponse: { code: "CODE123" }, status: "connected" });
    const cb = h.diagFind("fb_login_callback");
    assert.ok(cb, "fb_login_callback logged");
    assert.deepEqual(
      Object.keys(cb!.data).sort(),
      ["hasAuthResponse", "hasCode", "hasResponse", "hasStatus"],
      "fb_login_callback has only booleans"
    );
    assert.equal(cb!.data.hasCode, true);
    assert.equal(cb!.data.hasResponse, true);
    // Flow unchanged: success + timer cleared.
    assert.equal(h.ctrl.getState().phase, "success");
    assert.equal(h.timers.size, 0, "timer cleared on success (diag on)");
  }

  // D3) No secret values are ever emitted (App ID / Config ID / code).
  {
    const h = makeHarness({ diag: true });
    h.ctrl.preload();
    await h.settleSdk();
    h.ctrl.launch();
    h.postMessage({
      type: "WA_EMBEDDED_SIGNUP",
      event: "ERROR",
      data: { phone_number_id: "PN_SECRET", waba_id: "WABA_SECRET" },
    });
    const dump = JSON.stringify(h.diagCalls);
    for (const secret of ["APP", "CFG", "CODE123", "PN_SECRET", "WABA_SECRET"]) {
      assert.equal(dump.includes(secret), false, `no '${secret}' in diagnostics`);
    }
    // message event logs only the mapped event type, not the payload.
    const msg = h.diagFind("message");
    assert.ok(msg, "message logged");
    assert.equal(msg!.data.eventType, "ERROR");
    assert.equal(msg!.data.isWaEmbeddedSignup, true);
    assert.ok(!("data" in msg!.data), "no raw payload in message diag");
  }

  // D4) Diagnostics do not harm timeout / reset / dispose.
  {
    // timeout still fires + logs, listener/timer cleaned.
    const t = makeHarness({ diag: true });
    t.ctrl.preload();
    await t.settleSdk();
    t.ctrl.launch();
    t.fireAllTimers();
    const to = t.diagFind("timeout");
    assert.ok(to, "timeout logged");
    assert.equal(to!.data.phase, "launching");
    assert.equal(to!.data.callbackReceived, false);
    assert.equal(typeof to!.data.elapsedMs, "number");
    assert.equal(t.ctrl.getState().phase, "error", "timeout still → error (diag on)");
    assert.equal(t.messageListeners.length, 0, "listener cleaned (diag on)");

    // reset + dispose still clean up with diag on.
    const r = makeHarness({ diag: true });
    r.ctrl.preload();
    await r.settleSdk();
    r.ctrl.launch();
    r.ctrl.reset();
    assert.equal(r.timers.size, 0, "reset clears timer (diag on)");
    assert.equal(r.messageListeners.length, 0, "reset clears listener (diag on)");
    r.ctrl.launch();
    r.ctrl.dispose();
    assert.equal(r.timers.size, 0, "dispose clears timer (diag on)");
    assert.equal(r.messageListeners.length, 0, "dispose clears listener (diag on)");
  }

  console.log("ALL EMBEDDED SIGNUP CONTROLLER TESTS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
