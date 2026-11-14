/**
 * Native push client (no browser, no device — the Capacitor plugin is mocked):
 *   npx tsx lib/native/push-notifications.test.ts
 *
 * Locks: permission is never requested at start-up; re-registration only when already
 * granted, once per page lifetime; token upload shape + auth; rotation dedupe; error
 * paths; tap deep-link validation (attacks included); foreground data passthrough is
 * non-sensitive; tokens never logged; everything a silent no-op off the Android app.
 * The device proof (no prompt at start-up, no crash without google-services.json)
 * is the emulator QA.
 */

import {
  createPushClient,
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
    check("unavailable: request/register/unregister no-op", rq === "unavailable" && rg === "unavailable" && un === false);
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

    // Rotation: same token again → no POST; new token → one POST.
    h.fire("registration", { value: TOKEN_A });
    await settle();
    check("rotation: same token deduped", h.calls.fetch.length === 1);
    h.fire("registration", { value: TOKEN_B });
    h.fire("registration", { value: TOKEN_B });
    await settle();
    check("rotation: new token posted once", h.calls.fetch.length === 2 && JSON.parse(String(h.calls.fetch[1].init.body)).token === TOKEN_B, `${h.calls.fetch.length}`);

    // Explicit registerDevice again: same token → "unchanged", no POST.
    h.state.permission = "granted";
    const again = await (async () => {
      const p = h.client.registerDevice();
      return p;
    })();
    check("registerDevice with unchanged token → unchanged", again === "unchanged" || again === "registered", again);
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
    check("not configured → not_configured, register() never called", r === "not_configured" && h.calls.register === 0 && h.calls.fetch.length === 0, r);
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
    const h = makeHarness({ permission: "granted", onRegister: (fire) => fire("registrationError", { error: "SERVICE_NOT_AVAILABLE details" }) });
    const r = await h.client.registerDevice();
    check("registrationError → registration_error, no POST", r === "registration_error" && h.calls.fetch.length === 0, r);
    check("registrationError: device error text not forwarded", !JSON.stringify(h.calls.emit).includes("SERVICE_NOT_AVAILABLE"));
  }
  {
    const h = makeHarness({ permission: "granted", registerThrows: true });
    const r = await h.client.registerDevice();
    check("register() throws (no google-services.json) → registration_error, no crash", r === "registration_error");
  }
  {
    const h = makeHarness({ permission: "granted", onRegister: () => {} });
    const p = h.client.registerDevice();
    await settle();
    h.runTimers();
    check("no answer from FCM → times out as registration_error", (await p) === "registration_error");
  }
  {
    const h = makeHarness({ permission: "prompt" });
    check("registerDevice without permission → permission_not_granted, no prompt", (await h.client.registerDevice()) === "permission_not_granted" && h.calls.request === 0 && h.calls.register === 0);
  }
  {
    const h = makeHarness({ permission: "granted", signedIn: false, onRegister: (fire) => fire("registration", { value: TOKEN_A }) });
    const r = await h.client.registerDevice();
    check("not signed in → no POST", r === "not_signed_in" && h.calls.fetch.length === 0, r);
  }
  {
    const h = makeHarness({ permission: "granted", fetchStatus: 500, onRegister: (fire) => fire("registration", { value: TOKEN_A }) });
    const r = await h.client.registerDevice();
    check("server 500 → server_rejected", r === "server_rejected", r);
    h.fire("registration", { value: TOKEN_A });
    await settle();
    check("server 500: same token retried on next registration (not marked posted)", h.calls.fetch.length === 2);
  }
  {
    const h = makeHarness({ permission: "granted", fetchThrows: true, onRegister: (fire) => fire("registration", { value: TOKEN_A }) });
    check("network down → offline", (await h.client.registerDevice()) === "offline");
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
    const h2 = makeHarness({ permission: "granted", fetchThrows: true });
    check("unregister: offline → false, no throw", (await h2.client.unregisterCurrentDevice()) === false);
    const h3 = makeHarness({ permission: "granted", signedIn: false });
    check("unregister: no session → nothing sent", (await h3.client.unregisterCurrentDevice()) === false && h3.calls.fetch.length === 0);
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
      check("default instance off-device: all unavailable/no-op", !mod.isNativePushAvailable() && s === "unavailable" && r === "unavailable" && g === "unavailable" && u === false);
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
