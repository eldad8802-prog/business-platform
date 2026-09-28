/**
 * Unit tests for the Embedded Signup controller. Run with:
 *   npx tsx components/whatsapp/embedded-signup-controller.test.ts
 *
 * Framework-agnostic: the controller takes injected deps, so the whole flow
 * (preload, synchronous FB.login, both result halves in either order, the
 * absolute deadline, the reconcile wait, listener/timer cleanup, stale-attempt
 * isolation) is exercised here with fakes — no browser, no React, no network.
 *
 * The closing property test drives hundreds of random event sequences and
 * proves none of them can leave the controller in "launching" once its timers
 * have run.
 */
import assert from "node:assert/strict";
import {
  createEmbeddedSignupController,
  isFinishEvent,
  isWaDiagEnabled,
} from "./embedded-signup-controller";
import type {
  EmbeddedSignupDiag,
  EmbeddedSignupEnv,
  EmbeddedSignupState,
} from "./embedded-signup-controller";
import type { FacebookSdk, FbLoginResponse } from "./facebook-sdk";

const DEADLINE = 600_000;
const RECONCILE = 20_000;

type LoginOpts = {
  config_id: string;
  response_type: string;
  override_default_response_type: boolean;
  extras: { featureType: string; sessionInfoVersion: string };
};

type DiagCall = { event: string; data: Record<string, unknown> };

function makeHarness(opts?: {
  diag?: boolean;
  config?: boolean;
  loginThrows?: boolean;
  /** Outcome the fake popup observer reports; omitted = no observer injected. */
  popup?: boolean | null;
  activation?: { isActive: boolean; hasBeenActive: boolean } | null;
  /** The fake SDK answers synchronously inside FB.login with this response. */
  syncResponse?: FbLoginResponse;
}) {
  let loadCalls = 0;
  let loginCalls = 0;
  const loginCbs: Array<(r: FbLoginResponse) => void> = [];
  let lastOpts: unknown = null;

  const fakeFb: FacebookSdk = {
    init: () => {},
    login: (cb, o) => {
      loginCalls++;
      if (opts?.loginThrows) throw new Error("boom");
      loginCbs.push(cb);
      lastOpts = o;
      if (opts?.syncResponse) cb(opts.syncResponse);
    },
  };

  // What window.FB currently is (the LIVE sdk launch() must use). Set when the
  // SDK "loads"; tests can swap it to model the loader stub being replaced.
  let live: FacebookSdk | null = null;
  let resolveSdk: ((fb: FacebookSdk) => void) | null = null;
  let rejectSdk: ((e: unknown) => void) | null = null;
  let sdkPromise: Promise<FacebookSdk> | null = null;

  let messageListeners: Array<(ev: { origin: string; data: unknown }) => void> = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerSeq = 1;

  const env: EmbeddedSignupEnv = {
    getConfig: () =>
      opts?.config === false ? null : { appId: "APP", configId: "CFG", graphVersion: "v25.0" },
    loadSdk: () => {
      loadCalls++;
      sdkPromise = new Promise<FacebookSdk>((res, rej) => {
        resolveSdk = res;
        rejectSdk = rej;
      });
      return sdkPromise;
    },
    getReadyFb: () => live,
    addMessageListener: (fn) => {
      messageListeners.push(fn);
    },
    removeMessageListener: (fn) => {
      messageListeners = messageListeners.filter((f) => f !== fn);
    },
    setTimer: (fn, ms) => {
      const id = timerSeq++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    timeoutMs: DEADLINE,
    reconcileMs: RECONCILE,
  };
  if (opts && "popup" in opts) {
    env.observePopup = (fn) => {
      fn();
      return { opened: opts.popup ?? null };
    };
  }
  if (opts && "activation" in opts) env.getUserActivation = () => opts.activation ?? null;

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
  const emitted: EmbeddedSignupState[] = [];
  ctrl.subscribe((s) => emitted.push(s));

  function fireWhere(pred: (ms: number) => boolean) {
    const due = [...timers.entries()].filter(([, t]) => pred(t.ms));
    due.forEach(([id]) => timers.delete(id));
    due.forEach(([, t]) => t.fn());
    return due.length;
  }

  const h = {
    ctrl,
    emitted,
    diagCalls,
    diagFind: (event: string) => diagCalls.find((c) => c.event === event),
    diagAll: (event: string) => diagCalls.filter((c) => c.event === event),
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
    timerMs: () => [...timers.values()].map((t) => t.ms).sort(),
    get messageListeners() {
      return messageListeners;
    },
    phase: () => ctrl.getState().phase,
    error: () => ctrl.getState().error,
    setLive(fb: FacebookSdk | null) {
      live = fb;
    },
    fakeFb,
    async settleSdk() {
      live = fakeFb;
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
    /** Fires the FB.login callback of attempt `n` (default: the latest). */
    fireLogin(resp: FbLoginResponse, n = loginCbs.length - 1) {
      loginCbs[n]?.(resp);
    },
    fireDeadline: () => fireWhere((ms) => ms === DEADLINE),
    fireReconcile: () => fireWhere((ms) => ms === RECONCILE),
    fireAllTimers() {
      let n = 0;
      while (timers.size > 0 && n < 10) {
        fireWhere(() => true);
        n++;
      }
    },
    postMessage(msg: unknown, origin = "https://www.facebook.com") {
      [...messageListeners].forEach((f) => f({ origin, data: msg }));
    },
    finish(data: Record<string, unknown> = { phone_number_id: "PN1", waba_id: "WABA1" }, event = "FINISH") {
      h.postMessage({ type: "WA_EMBEDDED_SIGNUP", event, data });
    },
    async ready() {
      ctrl.preload();
      await h.settleSdk();
    },
    /** No listener / no timer left behind. */
    assertClean(label: string) {
      assert.equal(timers.size, 0, `${label}: no timer left`);
      assert.equal(messageListeners.length, 0, `${label}: no listener left`);
    },
  };
  return h;
}

let checks = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  checks++;
  console.log(`  ok  ${name}`);
}

async function main() {
  console.log("\nEmbedded Signup controller\n");

  // ── SDK / config ───────────────────────────────────────────────────────
  await test("SDK is preloaded exactly once (idempotent)", async () => {
    const h = makeHarness();
    h.ctrl.preload();
    h.ctrl.preload();
    assert.equal(h.loadCalls, 1);
  });

  await test("SDK load success → FB.login called synchronously with the Embedded Signup params", async () => {
    const h = makeHarness();
    await h.ready();
    assert.equal(h.loginCalls, 0);
    h.ctrl.launch();
    assert.equal(h.loginCalls, 1, "FB.login called inside launch()");
    assert.equal(h.phase(), "launching");
    const o = h.lastOpts;
    assert.equal(o.config_id, "CFG");
    assert.equal(o.response_type, "code");
    assert.equal(o.override_default_response_type, true);
    assert.equal(o.extras.featureType, "whatsapp_business_app_onboarding");
    assert.equal(o.extras.sessionInfoVersion, "3");
    assert.deepEqual(h.timerMs(), [DEADLINE], "only the absolute deadline is armed at launch");
  });

  await test("SDK still loading on click → error sdk_unavailable, never launching", async () => {
    const h = makeHarness();
    h.ctrl.preload();
    h.ctrl.launch();
    assert.equal(h.loginCalls, 0);
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "sdk_unavailable");
    h.assertClean("sdk loading");
  });

  await test("SDK load failure → error sdk_unavailable, and a retry reloads the SDK", async () => {
    const h = makeHarness();
    h.ctrl.preload();
    await h.failSdk();
    h.ctrl.launch();
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "sdk_unavailable");
    assert.equal(h.loginCalls, 0);
    assert.equal(h.loadCalls, 2, "the failed load is retried in the background");
    await h.settleSdk();
    h.ctrl.launch();
    assert.equal(h.phase(), "launching", "the next click opens the popup");
  });

  await test("config missing → error config_missing, no FB.login, no timer", async () => {
    const h = makeHarness({ config: false });
    h.ctrl.preload();
    h.ctrl.launch();
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "config_missing");
    assert.equal(h.loginCalls, 0);
    h.assertClean("config missing");
  });

  await test("FB.login throwing → error login_threw", async () => {
    const h = makeHarness({ loginThrows: true });
    await h.ready();
    h.ctrl.launch();
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "login_threw");
    h.assertClean("login threw");
  });

  // ── Normal success, both orders ────────────────────────────────────────
  await test("FINISH then code → success with code + ids", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.finish({ phone_number_id: "PN1", waba_id: "WABA1", business_id: "BIZ" });
    assert.equal(h.phase(), "launching", "waits for the code");
    assert.deepEqual(h.timerMs(), [RECONCILE, DEADLINE].sort(), "reconcile armed, deadline untouched");
    h.fireLogin({ authResponse: { code: "CODE123" } });
    assert.equal(h.phase(), "success");
    assert.deepEqual(h.ctrl.getState().result, {
      code: "CODE123",
      phoneNumberId: "PN1",
      wabaId: "WABA1",
      businessId: "BIZ",
      flow: "cloud_api",
    });
    h.assertClean("finish-then-code");
  });

  await test("code then FINISH → success (the callback may arrive first)", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.fireLogin({ authResponse: { code: "CODE123" } });
    assert.equal(h.phase(), "launching", "a code without ids is not posted");
    assert.equal(h.ctrl.getState().result, null);
    h.finish();
    assert.equal(h.phase(), "success");
    assert.equal(h.ctrl.getState().result?.phoneNumberId, "PN1");
    assert.equal(h.ctrl.getState().result?.wabaId, "WABA1");
    h.assertClean("code-then-finish");
  });

  await test("coexistence finish event (FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING) completes like FINISH", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.finish({ phone_number_id: "PN1", waba_id: "WABA1" }, "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING");
    h.fireLogin({ authResponse: { code: "C" } });
    assert.equal(h.phase(), "success");
  });

  // ── Missing halves ─────────────────────────────────────────────────────
  await test("FINISH but the callback never arrives → error missing_code after the reconcile wait", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.finish();
    assert.equal(h.fireReconcile(), 1);
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "missing_code");
    h.assertClean("finish-no-callback");
  });

  await test("code but FINISH never arrives → error missing_ids after the reconcile wait", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.fireLogin({ authResponse: { code: "C" } });
    assert.equal(h.fireReconcile(), 1);
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "missing_ids");
    h.assertClean("code-no-finish");
  });

  await test("FINISH_ONLY_WABA (no phone number) + code → error no_phone_number", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.finish({ waba_id: "WABA1" }, "FINISH_ONLY_WABA");
    h.fireLogin({ authResponse: { code: "C" } });
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "no_phone_number");
    h.assertClean("only-waba");
  });

  await test("malformed FINISH (no data) + code → error missing_ids, never a partial post", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.postMessage({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH" });
    h.fireLogin({ authResponse: { code: "C" } });
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "missing_ids");
    assert.equal(h.ctrl.getState().result, null);
  });

  await test("unparseable / foreign messages are ignored", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.postMessage("{not json");
    h.postMessage({ type: "SOMETHING_ELSE", event: "FINISH", data: { phone_number_id: "X", waba_id: "Y" } });
    h.postMessage(
      { type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: {} },
      "https://evil.example.com"
    );
    assert.equal(h.phase(), "launching");
    h.fireLogin({ authResponse: { code: "C" } });
    assert.equal(h.phase(), "launching", "ids from a foreign message were not used");
  });

  await test("callback without a code (popup closed) → cancelled", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.fireLogin({ status: "unknown", authResponse: null });
    assert.equal(h.phase(), "cancelled");
    assert.equal(h.error(), null);
    h.assertClean("closed");
  });

  await test("callback without a code AFTER FINISH → error missing_code (not a silent cancel)", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.finish();
    h.fireLogin({ authResponse: null });
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "missing_code");
  });

  // ── Meta CANCEL / ERROR ───────────────────────────────────────────────
  await test("Meta CANCEL → cancelled, clean", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.postMessage({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "x" } });
    assert.equal(h.phase(), "cancelled");
    h.assertClean("cancel");
  });

  await test("Meta ERROR → error meta_error, clean", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.postMessage({ type: "WA_EMBEDDED_SIGNUP", event: "ERROR", data: { error_message: "x" } });
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "meta_error");
    h.assertClean("meta error");
  });

  // ── Deadline: absolute, never extended ─────────────────────────────────
  await test("callback never arrives → the absolute deadline ends it (error timeout)", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    assert.equal(h.fireDeadline(), 1);
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "timeout");
    h.assertClean("deadline");
  });

  await test("repeated progress/other messages do not re-arm or extend anything", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    const before = [...h.timers.keys()];
    for (let i = 0; i < 50; i++) {
      h.postMessage({ type: "WA_EMBEDDED_SIGNUP", event: "PROGRESS", data: {} });
      h.postMessage({ type: "WA_EMBEDDED_SIGNUP", data: { phone_number_id: "PN1" } });
    }
    assert.deepEqual([...h.timers.keys()], before, "same single deadline timer, never re-armed");
    h.fireDeadline();
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "timeout");
  });

  await test("FINISH does not extend the deadline", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    const deadlineId = [...h.timers.entries()].find(([, t]) => t.ms === DEADLINE)![0];
    h.finish();
    assert.ok(h.timers.has(deadlineId), "the original deadline timer is still the one armed");
    h.fireDeadline();
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "timeout");
    h.assertClean("finish-then-deadline");
  });

  await test("duplicate FINISH is recorded once; nothing re-armed", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.finish();
    const afterFirst = [...h.timers.keys()];
    h.finish();
    h.finish();
    assert.deepEqual([...h.timers.keys()], afterFirst, "no timer added by duplicates");
    h.fireLogin({ authResponse: { code: "C" } });
    assert.equal(h.phase(), "success");
    const emittedSuccess = h.emitted.filter((s) => s.phase === "success").length;
    h.finish(); // after success — listener is gone
    assert.equal(h.emitted.filter((s) => s.phase === "success").length, emittedSuccess);
    assert.equal(emittedSuccess, 1, "success emitted exactly once");
  });

  await test("duplicate FB.login callback is ignored", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.fireLogin({ authResponse: null }); // cancelled
    h.fireLogin({ authResponse: { code: "LATE" } });
    assert.equal(h.phase(), "cancelled", "a second callback cannot flip a settled attempt");
  });

  await test("late callback after the deadline cannot overwrite the timeout", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.finish();
    h.fireDeadline();
    h.fireLogin({ authResponse: { code: "LATE" } });
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "timeout");
    assert.equal(h.ctrl.getState().result, null);
  });

  // ── Retry / cancel / unmount ───────────────────────────────────────────
  await test("launch while launching is a no-op (one popup, one timer)", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.ctrl.launch();
    assert.equal(h.loginCalls, 1);
    assert.equal(h.timers.size, 1);
    assert.equal(h.messageListeners.length, 1);
  });

  await test("owner cancel (reset) while launching → idle, clean", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.ctrl.reset();
    assert.equal(h.phase(), "idle");
    h.assertClean("reset");
  });

  await test("retry after failure: a stale callback of the old attempt is ignored", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch(); // attempt 0
    h.postMessage({ type: "WA_EMBEDDED_SIGNUP", event: "ERROR", data: {} });
    assert.equal(h.phase(), "error");
    h.ctrl.launch(); // attempt 1
    assert.equal(h.phase(), "launching");
    assert.equal(h.timers.size, 1, "exactly one deadline after retry");
    assert.equal(h.messageListeners.length, 1, "exactly one listener after retry");
    h.fireLogin({ authResponse: { code: "OLD" } }, 0); // stale
    assert.equal(h.phase(), "launching", "old attempt's callback ignored");
    h.finish();
    h.fireLogin({ authResponse: { code: "NEW" } }, 1);
    assert.equal(h.phase(), "success");
    assert.equal(h.ctrl.getState().result?.code, "NEW");
  });

  await test("retry after timeout works and starts a fresh deadline", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.fireDeadline();
    assert.equal(h.error(), "timeout");
    h.ctrl.launch();
    assert.equal(h.phase(), "launching");
    assert.equal(h.error(), null, "the old error is cleared");
    assert.deepEqual(h.timerMs(), [DEADLINE]);
    h.finish();
    h.fireLogin({ authResponse: { code: "C" } });
    assert.equal(h.phase(), "success");
  });

  await test("dispose (unmount) during launch: clean, and nothing is emitted afterwards", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    const count = h.emitted.length;
    h.ctrl.dispose();
    h.assertClean("dispose");
    h.fireLogin({ authResponse: { code: "C" } });
    h.finish();
    assert.equal(h.emitted.length, count, "no state emitted after dispose");
  });

  await test("isFinishEvent recognises Meta's finish variants only", () => {
    assert.equal(isFinishEvent("FINISH"), true);
    assert.equal(isFinishEvent("FINISH_ONLY_WABA"), true);
    assert.equal(isFinishEvent("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"), true);
    assert.equal(isFinishEvent("FINISHED"), false);
    assert.equal(isFinishEvent("CANCEL"), false);
    assert.equal(isFinishEvent(undefined), false);
  });

  // ── Stale SDK reference (Production evidence after #558) ───────────────
  await test("launch calls login on the LIVE sdk, not on the object preload resolved (loader stub)", async () => {
    const h = makeHarness();
    // Preload "resolved" with the sdk.js loader stub…
    const stubCalls: unknown[] = [];
    const stub = { init() {}, login: (...a: unknown[]) => void stubCalls.push(a), __buffer: { calls: stubCalls } } as unknown as FacebookSdk;
    h.ctrl.preload();
    h.setLive(stub);
    // …then the real bundle replaced window.FB.
    await h.settleSdk();
    h.ctrl.launch();
    assert.equal(h.loginCalls, 1, "the live (real) SDK's login ran");
    assert.equal(stubCalls.length, 0, "nothing sent into the stale stub");
    assert.equal(h.phase(), "launching");
  });

  await test("preload resolved but no real SDK is live now → sdk_unavailable, no login on a stale object", async () => {
    const h = makeHarness();
    await h.ready();
    h.setLive(null); // e.g. window.FB is (again) only the loader stub
    h.ctrl.launch();
    assert.equal(h.loginCalls, 0);
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "sdk_unavailable");
  });

  // ── Popup refused by the browser (Production evidence after #557) ──────
  await test("browser refuses Meta's window → error popup_blocked immediately, clean (no silent wait)", async () => {
    const h = makeHarness({ popup: false });
    await h.ready();
    h.ctrl.launch();
    assert.equal(h.loginCalls, 1, "FB.login was called");
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "popup_blocked");
    h.assertClean("popup blocked");
  });

  await test("window opened → normal launching (deadline armed, listener on)", async () => {
    const h = makeHarness({ popup: true });
    await h.ready();
    h.ctrl.launch();
    assert.equal(h.phase(), "launching");
    assert.deepEqual(h.timerMs(), [DEADLINE]);
    assert.equal(h.messageListeners.length, 1);
  });

  await test("no open attempt observed (unknown) → no behaviour change, still bounded", async () => {
    const h = makeHarness({ popup: null });
    await h.ready();
    h.ctrl.launch();
    assert.equal(h.phase(), "launching");
    h.fireDeadline();
    assert.equal(h.error(), "timeout");
  });

  await test("a synchronous SDK answer that already settled the attempt is not overwritten by popup_blocked", async () => {
    const h = makeHarness({ popup: false, syncResponse: { status: "unknown", authResponse: null } });
    await h.ready();
    h.ctrl.launch();
    assert.equal(h.phase(), "cancelled", "the settled outcome stands");
    assert.equal(h.error(), null);
    h.assertClean("sync answer");
  });

  await test("FB.login is invoked synchronously inside launch() — no await between click and popup", async () => {
    // The observer runs FB.login inside the same call stack as launch(): if any
    // await sat between them, loginCalls would still be 0 right after launch().
    const h = makeHarness({ popup: true });
    await h.ready();
    let calledDuringLaunch = false;
    const before = h.loginCalls;
    h.ctrl.launch();
    calledDuringLaunch = h.loginCalls === before + 1;
    assert.equal(calledDuringLaunch, true);
  });

  // ── Coexistence: Meta reports waba_id only ─────────────────────────────
  await test("coexistence FINISH with waba_id only + code → success, flow=coexistence, no phone id", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.finish({ waba_id: "WABA1" }, "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING");
    h.fireLogin({ authResponse: { code: "C" } });
    assert.equal(h.phase(), "success");
    assert.deepEqual(h.ctrl.getState().result, { code: "C", wabaId: "WABA1", flow: "coexistence" });
  });

  await test("coexistence: code first, then waba-only FINISH → success", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.fireLogin({ authResponse: { code: "C" } });
    h.finish({ waba_id: "WABA1" }, "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING");
    assert.equal(h.phase(), "success");
    assert.equal(h.ctrl.getState().result?.flow, "coexistence");
  });

  await test("coexistence FINISH without waba_id → error missing_ids", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.finish({}, "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING");
    h.fireLogin({ authResponse: { code: "C" } });
    assert.equal(h.error(), "missing_ids");
  });

  await test("Cloud API FINISH still requires the phone number id", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.finish({ waba_id: "WABA1" }, "FINISH");
    h.fireLogin({ authResponse: { code: "C" } });
    assert.equal(h.phase(), "error");
    assert.equal(h.error(), "no_phone_number");
  });

  // ── Property: no event sequence can leave "launching" once timers ran ──
  await test("property: 2000 random event sequences never stay in launching", async () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const actions: Array<(h: ReturnType<typeof makeHarness>) => void> = [
      (h) => h.fireLogin({ authResponse: { code: "C" } }),
      (h) => h.fireLogin({ authResponse: null }),
      (h) => h.finish(),
      (h) => h.finish({ waba_id: "W" }, "FINISH_ONLY_WABA"),
      (h) => h.finish({}, "FINISH"),
      (h) => h.finish({ waba_id: "W" }, "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"),
      (h) => h.postMessage({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: {} }),
      (h) => h.postMessage({ type: "WA_EMBEDDED_SIGNUP", event: "ERROR", data: {} }),
      (h) => h.postMessage({ type: "WA_EMBEDDED_SIGNUP", event: "PROGRESS", data: {} }),
      (h) => h.postMessage("garbage"),
      (h) => h.fireReconcile(),
      (h) => h.ctrl.launch(),
    ];
    for (let i = 0; i < 2000; i++) {
      const h = makeHarness();
      await h.ready();
      h.ctrl.launch();
      const steps = 1 + rnd(8);
      for (let s = 0; s < steps; s++) actions[rnd(actions.length)](h);
      h.fireAllTimers();
      assert.notEqual(h.phase(), "launching", `sequence ${i} stayed in launching`);
      h.assertClean(`sequence ${i}`);
      const st = h.ctrl.getState();
      if (st.phase === "success") {
        assert.ok(st.result?.code && st.result.wabaId, "success always carries code + waba");
        if (st.result?.flow === "cloud_api") assert.ok(st.result.phoneNumberId, "cloud_api success carries the phone id");
      } else {
        assert.equal(st.result, null, "no result outside success");
      }
      if (st.phase === "error") assert.ok(st.error, "every error is named");
    }
  });

  // ── Diagnostics (gated, secret-free) ───────────────────────────────────
  await test("diag gate is active ONLY for ?waDiag=1", () => {
    assert.equal(isWaDiagEnabled("?waDiag=1"), true);
    assert.equal(isWaDiagEnabled("waDiag=1"), true);
    assert.equal(isWaDiagEnabled("?waDiag=1&x=2"), true);
    assert.equal(isWaDiagEnabled("?waDiag=0"), false);
    assert.equal(isWaDiagEnabled("?other=1"), false);
    assert.equal(isWaDiagEnabled(""), false);
    assert.equal(isWaDiagEnabled(undefined), false);
    assert.equal(isWaDiagEnabled(null), false);
  });

  await test("diag off → nothing logged, flow identical", async () => {
    const h = makeHarness();
    await h.ready();
    h.ctrl.launch();
    h.finish();
    h.fireLogin({ authResponse: { code: "CODE123" } });
    assert.equal(h.diagCalls.length, 0);
    assert.equal(h.phase(), "success");
  });

  await test("diag on → fb_login_call / fb_login_callback / settled carry only allowed fields", async () => {
    const h = makeHarness({ diag: true });
    await h.ready();
    assert.ok(h.diagFind("preload_resolved"));
    h.ctrl.launch();
    const call = h.diagFind("fb_login_call");
    assert.ok(call);
    assert.deepEqual(Object.keys(call!.data).sort(), [
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
    ]);
    h.finish({ phone_number_id: "PN_SECRET", waba_id: "WABA_SECRET" });
    h.fireLogin({ authResponse: { code: "CODE123" }, status: "connected" });
    const cb = h.diagFind("fb_login_callback");
    assert.deepEqual(Object.keys(cb!.data).sort(), ["current", "hasAuthResponse", "hasCode", "hasResponse", "hasStatus"]);
    const settled = h.diagFind("settled");
    assert.ok(settled);
    assert.equal(settled!.data.phase, "success");
    assert.equal(settled!.data.hasPhoneNumberId, true);
    assert.equal(typeof settled!.data.elapsedMs, "number");
    assert.equal(h.phase(), "success", "flow unchanged with diag on");
  });

  await test("diag never emits the code, ids, app id or config id", async () => {
    const h = makeHarness({ diag: true });
    await h.ready();
    h.ctrl.launch();
    h.finish({ phone_number_id: "PN_SECRET", waba_id: "WABA_SECRET", business_id: "BIZ_SECRET" });
    h.fireLogin({ authResponse: { code: "CODE_SECRET" } });
    h.ctrl.launch();
    h.postMessage({ type: "WA_EMBEDDED_SIGNUP", event: "ERROR", data: { error_message: "MSG_SECRET" } });
    const dump = JSON.stringify(h.diagCalls);
    for (const secret of ["APP", "CFG", "CODE_SECRET", "PN_SECRET", "WABA_SECRET", "BIZ_SECRET", "MSG_SECRET"]) {
      assert.equal(dump.includes(secret), false, `no '${secret}' in diagnostics`);
    }
    const msg = h.diagFind("message");
    assert.ok(!("data" in msg!.data), "no raw payload in message diag");
  });

  await test("diag on: FB.login returned is logged with popup + activation booleans only", async () => {
    const h = makeHarness({ diag: true, popup: false, activation: { isActive: true, hasBeenActive: true } });
    await h.ready();
    h.ctrl.launch();
    const ret = h.diagFind("fb_login_returned");
    assert.ok(ret, "fb_login_returned logged");
    assert.deepEqual(Object.keys(ret!.data).sort(), [
      "activationHasBeenActive",
      "activationIsActive",
      "current",
      "popupOpened",
    ]);
    assert.equal(ret!.data.popupOpened, false);
    assert.equal(ret!.data.activationIsActive, true);
    assert.equal(h.diagAll("settled").pop()!.data.error, "popup_blocked");
  });

  await test("diag on: FB.login throwing is logged with the error NAME only", async () => {
    const h = makeHarness({ diag: true, loginThrows: true });
    await h.ready();
    h.ctrl.launch();
    const t = h.diagFind("fb_login_threw");
    assert.ok(t);
    assert.deepEqual(Object.keys(t!.data).sort(), ["activationIsActive", "errorName"]);
    assert.equal(t!.data.errorName, "Error");
    assert.equal(JSON.stringify(h.diagCalls).includes("boom"), false, "no error message text");
    assert.equal(h.error(), "login_threw");
  });

  await test("diag on: the deadline logs a settled timeout", async () => {
    const h = makeHarness({ diag: true });
    await h.ready();
    h.ctrl.launch();
    h.fireDeadline();
    const settled = h.diagAll("settled").pop();
    assert.equal(settled!.data.phase, "error");
    assert.equal(settled!.data.error, "timeout");
    assert.equal(settled!.data.callbackReceived, false);
    h.assertClean("diag deadline");
  });

  console.log(`\nALL EMBEDDED SIGNUP CONTROLLER TESTS PASSED — ${checks} checks\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
