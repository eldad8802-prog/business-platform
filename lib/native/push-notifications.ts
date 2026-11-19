"use client";

/**
 * Native push (Android app, FCM) — the web half.
 *
 * What it does, and what it never does:
 *  - It NEVER asks for the notification permission by itself. `requestPushPermission`
 *    exists for an explicit action by the person (a button) and is never called at
 *    start-up. On start-up the device is re-registered ONLY if the permission was
 *    already granted earlier (FCM rotates tokens; the server must hold the current one).
 *  - The token goes to the server with the app's ordinary Bearer header
 *    (lib/client-session buildClientAuthHeaders); without a signed-in session nothing
 *    is sent. The token is never logged and never written to storage.
 *  - A tap on a notification opens `data.href` only when it is an internal path under
 *    one of the app's real sections (`isAllowedPushHref`); anything else opens
 *    /notifications. The destination screen's own session guard still decides access.
 *  - A push received while the app is open is NOT drawn by the system; a window event
 *    (`dubiz:push-received`) carries the non-sensitive data for any screen that cares.
 *
 * Everywhere but the Android app (a browser, iOS, an app build without the plugin)
 * every function is a silent no-op.
 *
 * Server contract (notifications engine, devices API):
 *   POST   /api/push/devices          {provider:"FCM", token, platform:"android", appVersion}
 *   DELETE /api/push/devices/current  revoke this session's devices (best effort)
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import { buildClientAuthHeaders, getClientAuthToken } from "@/lib/client-session";

// ── Deep links ─────────────────────────────────────────────────────────────

/**
 * Sections a notification may open (first path segment, matched whole: `/tasks` and
 * `/tasks/…` yes, `/tasksx` no). Every entry is a real route under app/.
 */
export const PUSH_HREF_ALLOWED_PREFIXES = [
  "/app",
  "/tasks",
  "/notifications",
  "/calendar",
  "/inbox",
  "/inventory",
  "/billing",
  "/documents",
  "/business-documents",
  "/secretary",
  "/leads",
  "/service-desk",
  "/customers",
  "/collection",
  "/payments",
  "/payables",
  "/money",
  "/suppliers",
  "/attention",
  "/settings",
] as const;

export const PUSH_FALLBACK_HREF = "/notifications";
export const PUSH_HREF_MAX_LENGTH = 512;

/**
 * Pure. True only for an internal app path under an allowed section: starts with a
 * single "/", no scheme, no "//", no "\", no "..", no control/space characters, no
 * percent-encoded slash, backslash, dot or NUL (so nothing decodes into one of the
 * above), at most 512 characters. A query string or fragment is allowed.
 */
export function isAllowedPushHref(href: unknown): href is string {
  if (typeof href !== "string") return false;
  if (href.length === 0 || href.length > PUSH_HREF_MAX_LENGTH) return false;
  if (!href.startsWith("/")) return false;
  if (href.includes("//") || href.includes("\\") || href.includes("..")) return false;
  // Control characters and whitespace (incl. the ones URL parsers strip silently).
  if (/[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(href)) return false;
  // Encoded "/", "\", "." and NUL — and any malformed escape.
  if (/%(2f|5c|2e|00)/i.test(href)) return false;
  try {
    decodeURIComponent(href);
  } catch {
    return false;
  }
  const path = href.split(/[?#]/, 1)[0];
  if (path.includes(":")) return false;
  return PUSH_HREF_ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Where a tap goes: the validated href, or the notification center. */
export function resolvePushHref(href: unknown): string {
  return isAllowedPushHref(href) ? href : PUSH_FALLBACK_HREF;
}

// ── Plugin surface (the subset used; matches @capacitor/push-notifications 8) ──

export type PushPermissionState = "granted" | "denied" | "prompt";

type PermissionStatusLike = { receive: string };
type ListenerHandleLike = { remove(): Promise<void> };
export type PushPluginLike = {
  checkPermissions(): Promise<PermissionStatusLike>;
  requestPermissions(): Promise<PermissionStatusLike>;
  register(): Promise<void>;
  addListener(event: "registration", fn: (token: { value: string }) => void): Promise<ListenerHandleLike>;
  addListener(event: "registrationError", fn: (err: { error: string }) => void): Promise<ListenerHandleLike>;
  addListener(event: "pushNotificationReceived", fn: (n: { data?: unknown }) => void): Promise<ListenerHandleLike>;
  addListener(
    event: "pushNotificationActionPerformed",
    fn: (a: { actionId?: string; notification: { data?: unknown } }) => void
  ): Promise<ListenerHandleLike>;
};

export const PUSH_RECEIVED_EVENT = "dubiz:push-received";
export const PUSH_STATUS_EVENT = "dubiz:push-status";

/** Non-sensitive registration outcome (never a token, never an error text from the device). */
export type PushRegistrationStatus =
  | "registered"
  | "unchanged"
  | "not_signed_in"
  | "server_rejected"
  | "offline"
  | "registration_error"
  | "permission_not_granted"
  /** The build has no Firebase config (no google-services.json): register() is never called. */
  | "not_configured"
  | "unavailable";

export type PushDeps = {
  /** The Android app with the push plugin compiled in. */
  available(): boolean;
  plugin(): Promise<PushPluginLike>;
  fetch(input: string, init: RequestInit): Promise<Response>;
  /** Auth headers, or null when there is no signed-in session on this device. */
  authHeaders(): Record<string, string> | null;
  appVersion(): Promise<string | null>;
  emit(name: string, detail: unknown): void;
  navigate(href: string): void;
  setTimeout(fn: () => void, ms: number): unknown;
  /**
   * Is Firebase configured in this build (native PushSupport plugin)? The push plugin's
   * register() CRASHES the app when it is not, so false — or an older build without
   * PushSupport — means register() is never called.
   */
  firebaseConfigured(): Promise<boolean>;
  /** Did the person turn push on from this device (an explicit action)? Device-local, no token. */
  optedIn(): boolean;
  setOptedIn(): void;
};

/** Startup re-registration waits this long, so it never competes with the first screen's requests. */
export const REREGISTER_DELAY_MS = 3000;
/** How long registerDevice waits for FCM's answer before reporting a registration error. */
export const REGISTER_TIMEOUT_MS = 30000;

function mapPermission(receive: string | undefined): PushPermissionState {
  if (receive === "granted") return "granted";
  if (receive === "denied") return "denied";
  return "prompt"; // "prompt" and "prompt-with-rationale"
}

/** The non-sensitive fields of a push's data payload (the server sends only these). */
function safeData(data: unknown): { notificationId?: string; href?: string; category?: string } {
  if (!data || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;
  const out: { notificationId?: string; href?: string; category?: string } = {};
  if (typeof d.notificationId === "string") out.notificationId = d.notificationId.slice(0, 64);
  if (typeof d.category === "string") out.category = d.category.slice(0, 64);
  if (isAllowedPushHref(d.href)) out.href = d.href;
  return out;
}

/** App version as the server stores it: ^[0-9A-Za-z.+_-]{1,32}$, else null. */
export function formatAppVersion(info: { version?: unknown; build?: unknown } | null | undefined): string | null {
  if (!info) return null;
  const v = typeof info.version === "string" ? info.version.trim() : "";
  const b = typeof info.build === "string" || typeof info.build === "number" ? String(info.build).trim() : "";
  const s = v && b ? `${v}+${b}` : v || b;
  return /^[0-9A-Za-z.+_-]{1,32}$/.test(s) ? s : null;
}

export function createPushClient(deps: PushDeps) {
  let listenersReady: Promise<boolean> | null = null;
  let lastPostedToken: string | null = null;
  let postInFlight: { token: string; promise: Promise<PushRegistrationStatus> } | null = null;
  let startupScheduled = false;
  let pendingRegistration: ((s: PushRegistrationStatus) => void) | null = null;

  const report = (status: PushRegistrationStatus) => {
    deps.emit(PUSH_STATUS_EVENT, { status });
    const settle = pendingRegistration;
    pendingRegistration = null;
    settle?.(status);
  };

  async function postToken(token: string): Promise<PushRegistrationStatus> {
    if (token === lastPostedToken) return "unchanged";
    if (postInFlight && postInFlight.token === token) return postInFlight.promise;
    const headers = deps.authHeaders();
    if (!headers) return "not_signed_in";
    const promise = (async (): Promise<PushRegistrationStatus> => {
      try {
        const appVersion = await deps.appVersion().catch(() => null);
        const res = await deps.fetch("/api/push/devices", {
          method: "POST",
          headers,
          cache: "no-store",
          body: JSON.stringify({ provider: "FCM", token, platform: "android", appVersion }),
        });
        if (!res.ok) return "server_rejected";
        lastPostedToken = token;
        return "registered";
      } catch {
        return "offline";
      }
    })();
    postInFlight = { token, promise };
    try {
      return await promise;
    } finally {
      if (postInFlight?.promise === promise) postInFlight = null;
    }
  }

  /** Wire the plugin listeners once. Resolves false when push is not available. */
  function attachListeners(): Promise<boolean> {
    if (!deps.available()) return Promise.resolve(false);
    if (listenersReady) return listenersReady;
    listenersReady = (async () => {
      try {
        const p = await deps.plugin();
        await p.addListener("registration", (t) => {
          const token = typeof t?.value === "string" ? t.value : "";
          if (!token) return report("registration_error");
          void postToken(token).then(report);
        });
        // The device's error text is not forwarded: it can be long and is of no use to a screen.
        await p.addListener("registrationError", () => report("registration_error"));
        await p.addListener("pushNotificationReceived", (n) => {
          deps.emit(PUSH_RECEIVED_EVENT, safeData(n?.data));
        });
        await p.addListener("pushNotificationActionPerformed", (a) => {
          const data = a?.notification?.data as Record<string, unknown> | undefined;
          deps.navigate(resolvePushHref(data?.href));
        });
        return true;
      } catch {
        listenersReady = null;
        return false;
      }
    })();
    return listenersReady;
  }

  async function permissionStatus(): Promise<PushPermissionState | "unavailable"> {
    if (!deps.available()) return "unavailable";
    try {
      return mapPermission((await (await deps.plugin()).checkPermissions()).receive);
    } catch {
      return "unavailable";
    }
  }

  /**
   * Register with FCM when the permission is granted. Resolves with the outcome of the
   * resulting token upload (or of the failure). Never asks for the permission.
   */
  async function registerDevice(): Promise<PushRegistrationStatus> {
    if (!(await attachListeners())) return "unavailable";
    if ((await permissionStatus()) !== "granted") return "permission_not_granted";
    if (!(await deps.firebaseConfigured().catch(() => false))) {
      report("not_configured");
      return "not_configured";
    }
    try {
      const p = await deps.plugin();
      const settled = new Promise<PushRegistrationStatus>((resolve) => {
        pendingRegistration?.("unchanged");
        pendingRegistration = resolve;
        // FCM answers with 'registration' or 'registrationError'; never wait forever.
        deps.setTimeout(() => {
          if (pendingRegistration === resolve) {
            pendingRegistration = null;
            resolve("registration_error");
          }
        }, REGISTER_TIMEOUT_MS);
      });
      await p.register();
      return await settled;
    } catch {
      // register() itself threw — e.g. no google-services.json in this build.
      report("registration_error");
      return "registration_error";
    }
  }

  /** ONLY from an explicit action by the person. Asks, and registers if granted. */
  async function requestPushPermission(): Promise<PushPermissionState | "unavailable"> {
    if (!deps.available()) return "unavailable";
    let state: PushPermissionState;
    try {
      state = mapPermission((await (await deps.plugin()).requestPermissions()).receive);
    } catch {
      return "unavailable";
    }
    if (state === "granted") {
      deps.setOptedIn();
      void registerDevice();
    }
    return state;
  }

  /**
   * App start: wire the tap/foreground listeners, then — once per page lifetime, after
   * a short delay — re-register only if the permission is ALREADY granted.
   */
  function startOnAppStart(): void {
    if (!deps.available()) return;
    void attachListeners();
    if (startupScheduled) return;
    startupScheduled = true;
    deps.setTimeout(() => {
      void (async () => {
        // Android 12 and older report "granted" without ever asking, so the permission
        // alone is not consent: only a device whose person turned push on is re-registered.
        if (!deps.optedIn()) return;
        if ((await permissionStatus()) !== "granted") return;
        await registerDevice();
      })().catch(() => {});
    }, REREGISTER_DELAY_MS);
  }

  /** Best effort: ask the server to drop this session's devices. Never throws. */
  async function unregisterCurrentDevice(): Promise<boolean> {
    if (!deps.available()) return false;
    const headers = deps.authHeaders();
    if (!headers) return false;
    try {
      const res = await deps.fetch("/api/push/devices/current", { method: "DELETE", headers, cache: "no-store" });
      if (res.ok) lastPostedToken = null;
      return res.ok;
    } catch {
      return false;
    }
  }

  return { permissionStatus, requestPushPermission, registerDevice, startOnAppStart, unregisterCurrentDevice };
}

// ── The app's instance ─────────────────────────────────────────────────────

export function isNativePushAvailable(): boolean {
  try {
    return (
      Capacitor.isNativePlatform() &&
      Capacitor.getPlatform() === "android" &&
      Capacitor.isPluginAvailable("PushNotifications")
    );
  } catch {
    return false;
  }
}

/** Device-local marker: the person turned push on here. A flag, never a token. */
export const PUSH_OPT_IN_KEY = "dubiz.push.optedIn";

const PushSupport = registerPlugin<{ status(): Promise<{ configured?: boolean }> }>("PushSupport");

let navigateImpl:((href: string) => void) | null = null;
let queuedHref: string | null = null;

/** The bootstrap hands over the app router once the app is ready; a tap before that waits. */
export function setPushNavigator(fn: ((href: string) => void) | null): void {
  navigateImpl = fn;
  if (fn && queuedHref) {
    const href = queuedHref;
    queuedHref = null;
    fn(href);
  }
}

const client = createPushClient({
  available: isNativePushAvailable,
  plugin: async () => (await import("@capacitor/push-notifications")).PushNotifications as unknown as PushPluginLike,
  fetch: (input, init) => fetch(input, init),
  authHeaders: () => (getClientAuthToken() ? buildClientAuthHeaders() : null),
  appVersion: async () => formatAppVersion(await (await import("@capacitor/app")).App.getInfo()),
  emit: (name, detail) => {
    if (typeof window === "undefined") return;
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {
      /* no listeners is fine */
    }
  },
  navigate: (href) => {
    if (navigateImpl) navigateImpl(href);
    else queuedHref = href;
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  firebaseConfigured: async () => {
    if (!Capacitor.isPluginAvailable("PushSupport")) return false;
    const r = await PushSupport.status();
    return r?.configured === true;
  },
  optedIn: () => {
    try {
      return localStorage.getItem(PUSH_OPT_IN_KEY) === "1";
    } catch {
      return false;
    }
  },
  setOptedIn: () => {
    try {
      localStorage.setItem(PUSH_OPT_IN_KEY, "1");
    } catch {
      /* without the marker the next start just doesn't re-register on its own */
    }
  },
});

export const permissionStatus = client.permissionStatus;
export const requestPushPermission = client.requestPushPermission;
export const registerDevice = client.registerDevice;
export const startNativePushOnAppStart = client.startOnAppStart;
export const unregisterCurrentDevice = client.unregisterCurrentDevice;
