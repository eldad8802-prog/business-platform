/**
 * Native push client (no browser, no device — the Capacitor plugin is mocked):
 *   npx tsx lib/native/push-notifications.test.ts
 *
 * Locks: permission is never requested at start-up; re-registration only when already
 * granted, once per page lifetime; token upload shape + auth; "registered" ONLY on the
 * server's 2xx to this attempt (no "unchanged" shortcut — a revoked device is bound again);
 * concurrent registrations share one FCM call and one POST; every failure has a class and
 * an allow-listed code (never device text); disconnect; tap deep-link validation (attacks
 * included); foreground data passthrough is non-sensitive; tokens never logged; everything
 * a silent no-op off the Android app.
 * The device proof (no prompt at start-up, no crash without google-services.json)
 * is the emulator QA.
 */

import { readFileSync } from "node:fs";
import {
  createPushClient,
  fcmErrorCode,
  plainPushPlugin,
  formatAppVersion,
  isAllowedPushHref,
  resolvePushHref,
  PUSH_RECEIVED_EVENT,
  PUSH_STATUS_EVENT,
  REREGISTER_DELAY_MS,
  type PushDeps,
  type PushPluginLike,
} from "@/lib/native/push-notifications";

let failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`[PASS] ${name}`);
  else {
    failed += 1;
    console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const TOKEN_A = "fcm-token-AAAA-secret-value";
const TOKEN_B = "fcm-token-BBBB-secret-value";

type Listener = (arg: unknown) => void;

function makeHarness(opts: {
  available?: boolean;
  permission?: string;
  requestResult?: string;
  signedIn?: boolean;
  onRegister?: (fire: (event: string, arg: unknown) => void) => void;
  registerThrows?: boolean;
  fetchStatus?: number;
  fetchThrows?: boolean;
  configured?: boolean;
  optedIn?: boolean;
}) {
  const listeners = new Map<string, Listener[]>();
  const calls = { check: 0, request: 0, register: 0, fetch: [] as { url: string; init: RequestInit }[], navigate: [] as string[], emit: [] as { name: string; detail: unknown }[] };
  const timers: { fn: () => void; ms: number }[] = [];
  const state = { permission: opts.permission ?? "prompt", optedIn: opts.optedIn ?? true, setOptedIn: 0 };
  const fire = (event: string, arg: unknown) => (listeners.get(event) ?? []).forEach((fn) => fn(arg));

  const plugin: PushPluginLike = {
    async checkPermissions() {
      calls.check += 1;
      return { receive: state.permission };
    },
    async requestPermissions() {
      calls.request += 1;
      if (opts.requestResult) state.permission = opts.requestResult;
      return { receive: state.permission };
    },
    async register() {
      calls.register += 1;
      if (opts.registerThrows) throw new Error("Default FirebaseApp is not initialized");
      opts.onRegister?.(fire);
    },
    addListener: (async (event: string, fn: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return { remove: async () => {} };
    }) as PushPluginLike["addListener"],
  };

  const deps: PushDeps = {
    available: () => opts.available ?? true,
    plugin: async () => plugin,
    fetch: async (url, init) => {
      calls.fetch.push({ url, init });
      if (opts.fetchThrows) throw new TypeError("Failed to fetch");
      return { ok: (opts.fetchStatus ?? 200) < 300, status: opts.fetchStatus ?? 200 } as Response;
    },
    authHeaders: () => (opts.signedIn === false ? null : { "Content-Type": "application/json", Authorization: "Bearer jwt" }),
    appVersion: async () => "1.0+2",
    emit: (name, detail) => calls.emit.push({ name, detail }),
    navigate: (href) => calls.navigate.push(href),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return 0;
    },
    firebaseConfigured: async () => opts.configured ?? true,
    optedIn: () => state.optedIn,
    setOptedIn: () => {
      state.optedIn = true;
      state.setOptedIn += 1;
    },
  };
  const runTimers = (ms?: number) => {
    const due = timers.filter((t) => ms === undefined || t.ms === ms);
    for (const t of due) timers.splice(timers.indexOf(t), 1);
    due.forEach((t) => t.fn());
  };
  return { client: createPushClient(deps), calls, fire, state, runTimers, timers };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await tick();
};

// A hung await would end the process silently with exit code 0; never count that as a pass.
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.error("[FAIL] test run ended before completing (a promise never settled)");
    process.exitCode = 1;
  }
});

async function main() {
  // Capture every console line: no token may ever reach a log.
  const logged: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  const capture = (...args: unknown[]) => logged.push(args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  const muteStart = () => {
    console.warn = capture;
    console.info = capture;
    console.debug = capture;
  };
  muteStart();

  // ── href validation ──
  const allowed = [
    "/tasks",
    "/tasks/123",
    "/tasks?x=1",
    "/tasks?x=1#frag",
    "/notifications",
    "/calendar/booking",
    "/inbox",
    "/inventory/items/9",
    "/billing",
    "/documents/accountant-pack",
    "/secretary",
    "/leads/abc",
    "/settings/security",
    "/service-desk",
    "/app",
  ];
  for (const h of allowed) check(`href allowed: ${h}`, isAllowedPushHref(h));
  const rejected: unknown[] = [
    "https://evil",
    "http://evil.com/tasks",
    "//evil",
    "//evil.com/tasks",
    "/\\evil",
    "\\\\evil",
    "/tasks/../admin",
    "/..%2f",
    "/tasks/%2e%2e/admin",
    "/tasks%2f..%2fadmin",
    "/tasks/%5c",
    "/tasks/%00",
    "/tasks/%E0%A4%A",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "/javascript:alert(1)",
    "/tasks:evil",
    "data:text/html,x",
    "tasks",
    "",
    " /tasks",
    "/tasks\n",
    "/tasks\t/x",
    "/ta sks",
    "/tasks ",
    "/tasksx",
    "/admin",
    "/api/push/devices",
    "/login",
    "/",
    "/tasks//x",
    `/tasks/${"a".repeat(600)}`,
    null,
    undefined,
    42,
    { href: "/tasks" },
  ];
  for (const h of rejected) check(`href rejected: ${JSON.stringify(h)?.slice(0, 40)}`, !isAllowedPushHref(h));
  check("href at 512 chars allowed, 513 rejected", isAllowedPushHref(`/tasks/${"a".repeat(505)}`) && !isAllowedPushHref(`/tasks/${"a".repeat(506)}`));
  check("resolvePushHref: invalid → /notifications", resolvePushHref("https://evil") === "/notifications" && resolvePushHref(undefined) === "/notifications");
  check("resolvePushHref: valid kept", resolvePushHref("/tasks?x=1") === "/tasks?x=1");

  // ── app version shape ──
  check("appVersion: version+build", formatAppVersion({ version: "1.0", build: "2" }) === "1.0+2");
  check("appVersion: bad chars → null", formatAppVersion({ version: "1.0 (beta)", build: "2" }) === null);
  check("appVersion: missing → null", formatAppVersion(null) === null && formatAppVersion({}) === null);

  // ── web / unavailable: everything a no-op ──
  {
    const h = makeHarness({ available: false, permission: "granted" });
    h.client.startOnAppStart();
    const st = await h.client.permissionStatus();
    const rq = await h.client.requestPushPermission();
    const rg = await h.client.registerDevice();
    const un = await h.client.unregisterCurrentDevice();
    await settle();
    check("unavailable: permissionStatus → unavailable", st === "unavailable");
    check("unavailable: request/register/unregister no-op", rq === "unavailable" && rg.status === "unavailable" && un === false);
    check("unavailable: plugin never touched, no fetch, no timer", h.calls.check + h.calls.request + h.calls.register === 0 && h.calls.fetch.length === 0 && h.timers.length === 0);
  }

  // ── permission mapping ──
  for (const [raw, mapped] of [["granted", "granted"], ["denied", "denied"], ["prompt", "prompt"], ["prompt-with-rationale", "prompt"]] as const) {
    const h = makeHarness({ permission: raw });
    check(`permission ${raw} → ${mapped}`, (await h.client.permissionStatus()) === mapped);
  }

  // ── start-up: prompt state → nothing asked, nothing registered ──
  {
    const h = makeHarness({ permission: "prompt" });
    h.client.startOnAppStart();
    await settle();
    check("startup: re-register is delayed (debounced)", h.calls.register === 0 && h.timers.some((t) => t.ms === REREGISTER_DELAY_MS));
    h.runTimers(REREGISTER_DELAY_MS);
    await settle();
    check("startup (prompt): permission never requested", h.calls.request === 0);
    check("startup (prompt): no register, no POST", h.calls.register === 0 && h.calls.fetch.length === 0);
  }
  {
    const h = makeHarness({ permission: "denied" });
    h.client.startOnAppStart();
    h.runTimers(REREGISTER_DELAY_MS);
    await settle();
    check("startup (denied): no request, no register", h.calls.request === 0 && h.calls.register === 0);
  }

  // ── start-up: granted → register once per page lifetime; POST shape ──
  {
    const h = makeHarness({ permission: "granted", onRegister: (fire) => fire("registration", { value: TOKEN_A }) });
    h.client.startOnAppStart();
    h.client.startOnAppStart();
    await settle();
    h.runTimers(REREGISTER_DELAY_MS);
    await settle();
    check("startup (granted): register called once", h.calls.register === 1, `${h.calls.register}`);
    check("startup (granted): permission never requested", h.calls.request === 0);
    check("startup (granted): one POST", h.calls.fetch.length === 1, `${h.calls.fetch.length}`);
    const f = h.calls.fetch[0];
    const body = f ? JSON.parse(String(f.init.body)) : null;
    check("POST url /api/push/devices", f?.url === "/api/push/devices" && f?.init.method === "POST");
    check(
      "POST body {provider, token, platform, appVersion}",
      body && Object.keys(body).sort().join(",") === "appVersion,platform,provider,token" && body.provider === "FCM" && body.token === TOKEN_A && body.platform === "android" && body.appVersion === "1.0+2",
      JSON.stringify(Object.keys(body ?? {}))
    );
    check("POST carries the app's Bearer header", (f?.init.headers as Record<string, string>)?.Authorization === "Bearer jwt");
    check("status event: registered", h.calls.emit.some((e) => e.name === PUSH_STATUS_EVENT && (e.detail as { status: string }).status === "registered"));
    check("status events carry no token", !JSON.stringify(h.calls.emit).includes("fcm-token"));

    // Rotation: the same token fired twice at once → one request; a new token → its own POST.
    h.fire("registration", { value: TOKEN_B });
    h.fire("registration", { value: TOKEN_B });
    await settle();
    check("rotation: new token posted once (in-flight dedupe)", h.calls.fetch.length === 2 && JSON.parse(String(h.calls.fetch[1].init.body)).token === TOKEN_B, `${h.calls.fetch.length}`);

    // Explicit registerDevice again with the SAME token: it POSTs again and is "registered" only on the server's 2xx
    // (there is no "unchanged" shortcut that could report a device the server revoked as connected).
    const before = h.calls.fetch.length;
    const again = await h.client.registerDevice();
    check("registerDevice again → POSTs again, registered on 2xx", again.status === "registered" && h.calls.fetch.length === before + 1, JSON.stringify(again));
  }

  // ── success is ONLY the server's 2xx ──
  {
    const statuses: string[] = [];
    for (const code of [200, 201, 204]) {
      const h = makeHarness({ permission: "granted", fetchStatus: code, onRegister: (fire) => fire("registration", { value: TOKEN_A }) });
      statuses.push((await h.client.registerDevice()).status);
    }
    check("2xx → registered", statuses.every((x) => x === "registered"), statuses.join(","));
    for (const code of [301, 400, 401, 403, 404, 409, 429, 500, 503]) {
      const h = makeHarness({ permission: "granted", fetchStatus: code, onRegister: (fire) => fire("registration", { value: TOKEN_A }) });
      const r = await h.client.registerDevice();
      check(`HTTP ${code} → server_rejected/HTTP_${code}, never registered`, r.status === "server_rejected" && r.code === `HTTP_${code}`, JSON.stringify(r));
      check(`HTTP ${code}: no "registered" status event`, !h.calls.emit.some((e) => (e.detail as { status?: string })?.status === "registered"));
    }
  }

  // ── concurrent registrations share one FCM call and one POST ──
  {
    const h = makeHarness({ permission: "granted", onRegister: (fire) => setTimeout(() => fire("registration", { value: TOKEN_A }), 0) });
    const [a, b, c] = await Promise.all([h.client.registerDevice(), h.client.registerDevice(), h.client.registerDevice()]);
    check("concurrent: one register() call", h.calls.register === 1, `${h.calls.register}`);
    check("concurrent: one POST", h.calls.fetch.length === 1, `${h.calls.fetch.length}`);
    check("concurrent: every caller gets the server's outcome (no 'unchanged' for the earlier ones)", [a, b, c].every((o) => o.status === "registered"), JSON.stringify([a, b, c]));
    // After it settled, a new call is a new registration.
    const d = await h.client.registerDevice();
    check("after settle: a new registration runs (second register(), second POST)", d.status === "registered" && h.calls.register === 2 && h.calls.fetch.length === 2);
  }
  {
    // Start-up registration + the settings screen opening while it runs: one registration, both see a failure.
    const h = makeHarness({ permission: "granted", fetchStatus: 404, onRegister: (fire) => setTimeout(() => fire("registration", { value: TOKEN_A }), 0) });
    h.client.startOnAppStart();
    h.runTimers(REREGISTER_DELAY_MS);
    const screen = await h.client.registerDevice();
    await settle();
    check("startup + screen concurrently: one register(), one POST", h.calls.register === 1 && h.calls.fetch.length === 1, `${h.calls.register}/${h.calls.fetch.length}`);
    check("startup + screen concurrently: the screen sees the failure, not a success", screen.status === "server_rejected" && screen.code === "HTTP_404", JSON.stringify(screen));
  }
  {
    // A concurrent failure (timeout) is reported to every waiter as the timeout — never as connected.
    const h = makeHarness({ permission: "granted", onRegister: () => {} });
    const p1 = h.client.registerDevice();
    const p2 = h.client.registerDevice();
    await settle();
    h.runTimers();
    const [r1, r2] = await Promise.all([p1, p2]);
    check("concurrent timeout: both waiters get registration_timeout", r1.status === "registration_timeout" && r2.status === "registration_timeout" && h.calls.register === 1, JSON.stringify([r1, r2]));
  }

  // ── start-up: granted but never opted in on this device (Android <= 12) → nothing ──
  {
    const h = makeHarness({ permission: "granted", optedIn: false, onRegister: (fire) => fire("registration", { value: TOKEN_A }) });
    h.client.startOnAppStart();
    h.runTimers(REREGISTER_DELAY_MS);
    await settle();
    check("startup (granted, not opted in): no register, no POST, no prompt", h.calls.register === 0 && h.calls.fetch.length === 0 && h.calls.request === 0);
  }

  // ── build without google-services.json: register() is never called (it would crash) ──
  {
    const h = makeHarness({ permission: "granted", configured: false });
    const r = await h.client.registerDevice();
    check("not configured → not_configured, register() never called", r.status === "not_configured" && h.calls.register === 0 && h.calls.fetch.length === 0, JSON.stringify(r));
    check("not configured → status event not_configured", h.calls.emit.some((e) => (e.detail as { status?: string })?.status === "not_configured"));
    const h2 = makeHarness({ permission: "granted", configured: false });
    h2.client.startOnAppStart();
    h2.runTimers(REREGISTER_DELAY_MS);
    await settle();
    check("not configured: startup never calls register()", h2.calls.register === 0);
  }

  // ── user action: requestPushPermission ──
  {
    const h = makeHarness({ permission: "prompt", requestResult: "granted", onRegister: (fire) => fire("registration", { value: TOKEN_A }) });
    const r = await h.client.requestPushPermission();
    await settle();
    check("request: granted → registers and POSTs", r === "granted" && h.calls.request === 1 && h.calls.register === 1 && h.calls.fetch.length === 1);
    check("request: granted → device marked opted in", h.state.setOptedIn === 1);
  }
  {
    const h = makeHarness({ permission: "prompt", requestResult: "denied", optedIn: false });
    const r = await h.client.requestPushPermission();
    await settle();
    check("request: denied → no register, not opted in", r === "denied" && h.calls.register === 0 && h.calls.fetch.length === 0 && h.state.setOptedIn === 0);
  }

  // ── error paths ──
  {
    const h = makeHarness({ permission: "granted", onRegister: (fire) => fire("registrationError", { error: "java.io.IOException: SERVICE_NOT_AVAILABLE at com.google secret-detail" }) });
    const r = await h.client.registerDevice();
    check("registrationError → registration_error/SERVICE_NOT_AVAILABLE, no POST", r.status === "registration_error" && r.code === "SERVICE_NOT_AVAILABLE" && h.calls.fetch.length === 0, JSON.stringify(r));
    check("registrationError: only the allow-listed name leaves, never the device text", !JSON.stringify(h.calls.emit).includes("secret-detail") && !JSON.stringify(h.calls.emit).includes("java.io"));
  }
  {
    check("fcmErrorCode: known names", fcmErrorCode("AUTHENTICATION_FAILED") === "AUTHENTICATION_FAILED" && fcmErrorCode("x: TOO_MANY_REGISTRATIONS") === "TOO_MANY_REGISTRATIONS" && fcmErrorCode("FIS_AUTH_ERROR") === "FIS_AUTH_ERROR");
    check("fcmErrorCode: Firebase Installations text → FIS_ERROR", fcmErrorCode("Firebase Installations Service is unavailable. Please try again later.") === "FIS_ERROR");
    check("fcmErrorCode: unknown / not a string → OTHER", fcmErrorCode("SOME_SECRET_VALUE abc") === "OTHER" && fcmErrorCode(undefined) === "OTHER" && fcmErrorCode(42) === "OTHER");
  }
  {
    const h = makeHarness({ permission: "granted", onRegister: (fire) => fire("registration", { value: "" }) });
    const r = await h.client.registerDevice();
    check("empty token → registration_error/EMPTY_TOKEN, no POST", r.status === "registration_error" && r.code === "EMPTY_TOKEN" && h.calls.fetch.length === 0, JSON.stringify(r));
  }
  {
    const h = makeHarness({ permission: "granted", registerThrows: true });
    const r = await h.client.registerDevice();
    check("register() throws (no google-services.json) → registration_error/REGISTER_THREW, no crash", r.status === "registration_error" && r.code === "REGISTER_THREW", JSON.stringify(r));
  }
  {
    const h = makeHarness({ permission: "granted", onRegister: () => {} });
    const p = h.client.registerDevice();
    await settle();
    h.runTimers();
    const r = await p;
    check("no answer from FCM → registration_timeout (its own class)", r.status === "registration_timeout", JSON.stringify(r));
    check("timeout: status event registration_timeout", h.calls.emit.some((e) => (e.detail as { status?: string })?.status === "registration_timeout"));
    // A late token after the timeout still uploads, and its own outcome is reported (the screen may connect then).
    h.fire("registration", { value: TOKEN_A });
    await settle();
    check("late token after timeout: uploaded and reported registered", h.calls.fetch.length === 1 && h.calls.emit.some((e) => (e.detail as { status?: string })?.status === "registered"));
  }
  {
    const h = makeHarness({ permission: "prompt" });
    const r = await h.client.registerDevice();
    check("registerDevice without permission → permission_not_granted, no prompt", r.status === "permission_not_granted" && h.calls.request === 0 && h.calls.register === 0);
  }
  {
    const h = makeHarness({ permission: "granted", signedIn: false, onRegister: (fire) => fire("registration", { value: TOKEN_A }) });
    const r = await h.client.registerDevice();
    check("not signed in → not_signed_in, no POST", r.status === "not_signed_in" && h.calls.fetch.length === 0, JSON.stringify(r));
  }
  {
    const h = makeHarness({ permission: "granted", fetchStatus: 500, onRegister: (fire) => fire("registration", { value: TOKEN_A }) });
    const r = await h.client.registerDevice();
    check("server 500 → server_rejected/HTTP_500", r.status === "server_rejected" && r.code === "HTTP_500", JSON.stringify(r));
    h.fire("registration", { value: TOKEN_A });
    await settle();
    check("server 500: same token retried on next registration", h.calls.fetch.length === 2);
  }
  {
    const h = makeHarness({ permission: "granted", fetchThrows: true, onRegister: (fire) => fire("registration", { value: TOKEN_A }) });
    check("network down → offline", (await h.client.registerDevice()).status === "offline");
  }
  {
    const h = makeHarness({ permission: "granted", configured: true, available: false });
    check("not the Android app → unavailable", (await h.client.registerDevice()).status === "unavailable" && h.calls.register === 0);
  }

  // ── tap handling ──
  {
    const h = makeHarness({ permission: "prompt" });
    h.client.startOnAppStart();
    await settle();
    const tap = (data: unknown) => h.fire("pushNotificationActionPerformed", { actionId: "tap", notification: { data } });
    tap({ href: "/tasks/12?x=1" });
    tap({ href: "https://evil" });
    tap({ href: "//evil" });
    tap({ href: "javascript:alert(1)" });
    tap({});
    tap(undefined);
    check(
      "tap: valid href navigates, everything else → /notifications",
      JSON.stringify(h.calls.navigate) === JSON.stringify(["/tasks/12?x=1", "/notifications", "/notifications", "/notifications", "/notifications", "/notifications"]),
      JSON.stringify(h.calls.navigate)
    );

    // ── foreground ──
    h.fire("pushNotificationReceived", { title: "Customer Dana owes 500", body: "secret", data: { notificationId: "n1", href: "/tasks", category: "tasks.reminder", amount: "500" } });
    h.fire("pushNotificationReceived", { data: { href: "https://evil" } });
    const received = h.calls.emit.filter((e) => e.name === PUSH_RECEIVED_EVENT).map((e) => e.detail);
    check(
      "foreground: window event with notificationId/href/category only",
      JSON.stringify(received[0]) === JSON.stringify({ notificationId: "n1", category: "tasks.reminder", href: "/tasks" }),
      JSON.stringify(received[0])
    );
    check("foreground: invalid href dropped from the event", JSON.stringify(received[1]) === "{}");
  }

  // ── unregister ──
  {
    const h = makeHarness({ permission: "granted" });
    const ok1 = await h.client.unregisterCurrentDevice();
    check("unregister: DELETE /api/push/devices/current with Bearer", ok1 && h.calls.fetch[0]?.url === "/api/push/devices/current" && h.calls.fetch[0]?.init.method === "DELETE" && (h.calls.fetch[0]?.init.headers as Record<string, string>).Authorization === "Bearer jwt");
    check("unregister: status event 'unregistered' (the screen stops showing connected)", h.calls.emit.some((e) => e.name === PUSH_STATUS_EVENT && (e.detail as { status?: string })?.status === "unregistered"));
  }
  {
    // Connected → disconnected → connect again: the same token is POSTed again (never assumed still registered).
    const h = makeHarness({ permission: "granted", onRegister: (fire) => fire("registration", { value: TOKEN_A }) });
    const first = await h.client.registerDevice();
    await h.client.unregisterCurrentDevice();
    const second = await h.client.registerDevice();
    const posts = h.calls.fetch.filter((c) => c.url === "/api/push/devices");
    check("disconnect then reconnect: POST, DELETE, POST again with the same token", first.status === "registered" && second.status === "registered" && posts.length === 2 && JSON.parse(String(posts[1].init.body)).token === TOKEN_A, `${posts.length}`);
  }
  {
    const h = makeHarness({ permission: "granted", fetchStatus: 500 });
    await h.client.unregisterCurrentDevice();
    check("unregister failed (500): no 'unregistered' event", !h.calls.emit.some((e) => (e.detail as { status?: string })?.status === "unregistered"));
    const h2 = makeHarness({ permission: "granted", fetchThrows: true });
    check("unregister: offline → false, no throw", (await h2.client.unregisterCurrentDevice()) === false);
    const h3 = makeHarness({ permission: "granted", signedIn: false });
    check("unregister: no session → nothing sent", (await h3.client.unregisterCurrentDevice()) === false && h3.calls.fetch.length === 0);
  }

  // ── the Capacitor proxy is a thenable: never resolve a promise with it ──
  {
    // Same shape as @capacitor/core's registerPlugin proxy: EVERY property is a method wrapper, `then` included,
    // and a call to a method the native side does not have never answers.
    const calls: string[] = [];
    const capacitorLikeProxy = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "then") return () => { calls.push("then"); /* native "then" never answers */ };
        return async (...args: unknown[]) => {
          calls.push(String(prop));
          if (prop === "checkPermissions") return { receive: "granted" };
          if (prop === "addListener") return { remove: async () => {} };
          void args;
          return undefined;
        };
      },
    }) as unknown as PushPluginLike;
    const race = (p: Promise<unknown>, ms: number) =>
      Promise.race([p.then(() => "resolved"), new Promise((r) => setTimeout(() => r("hung"), ms))]);

    check("hazard reproduced: resolving with the raw proxy hangs (proxy.then is called)", (await race((async () => capacitorLikeProxy)(), 200)) === "hung" && calls.includes("then"));
    calls.length = 0;
    check("plainPushPlugin: resolving with the wrapper does not hang and never calls then", (await race((async () => plainPushPlugin(capacitorLikeProxy))(), 200)) === "resolved" && !calls.includes("then"));
    const w = plainPushPlugin(capacitorLikeProxy);
    check("plainPushPlugin: has no then", (w as unknown as { then?: unknown }).then === undefined);
    await w.checkPermissions();
    await w.requestPermissions();
    await w.register();
    await w.addListener("registration", () => {});
    check("plainPushPlugin: forwards checkPermissions/requestPermissions/register/addListener", ["checkPermissions", "requestPermissions", "register", "addListener"].every((m) => calls.includes(m)), calls.join(","));

    // The whole client with a deps.plugin() shaped like the app instance (async + wrapper) and that proxy: it finishes.
    const deps: PushDeps = {
      available: () => true,
      plugin: async () => plainPushPlugin(capacitorLikeProxy),
      fetch: async () => ({ ok: true, status: 201 }) as Response,
      authHeaders: () => ({ Authorization: "Bearer jwt" }),
      appVersion: async () => "1.1.0+2",
      emit: () => {},
      navigate: () => {},
      setTimeout: () => 0,
      firebaseConfigured: async () => true,
      optedIn: () => true,
      setOptedIn: () => {},
    };
    const c = createPushClient(deps);
    check("client over the wrapped proxy: permissionStatus answers (the settings card can render)", (await race(c.permissionStatus(), 500)) === "resolved");

    const src = readFileSync("lib/native/push-notifications.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check(
      "app instance: plugin() resolves with plainPushPlugin(...), never with the raw PushNotifications proxy",
      /plugin: async \(\) => plainPushPlugin\(\(await import\("@capacitor\/push-notifications"\)\)\.PushNotifications/.test(src) &&
        !/plugin: async \(\) => \(await import\("@capacitor\/push-notifications"\)\)\.PushNotifications/.test(src)
    );
  }

  // ── the app's instance outside the Android app ──
  {
    const mod = await import("@/lib/native/push-notifications");
    let threw = false;
    try {
      mod.startNativePushOnAppStart();
      const s = await mod.permissionStatus();
      const r = await mod.requestPushPermission();
      const g = await mod.registerDevice();
      const u = await mod.unregisterCurrentDevice();
      check("default instance off-device: all unavailable/no-op", !mod.isNativePushAvailable() && s === "unavailable" && r === "unavailable" && g.status === "unavailable" && u === false);
    } catch {
      threw = true;
    }
    check("default instance off-device: never throws", !threw);
  }

  console.warn = orig.warn;
  console.info = orig.info;
  console.debug = orig.debug;
  check("no token ever logged", !logged.some((l) => l.includes("fcm-token")), logged.join(" | ").slice(0, 200));

  finished = true;
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

void main().catch((e) => {
  console.error("TEST ERROR:", e);
  process.exit(1);
});
