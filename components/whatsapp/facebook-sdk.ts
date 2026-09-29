/**
 * Loader for the Facebook JS SDK (Embedded Signup).
 *
 * `https://connect.facebook.net/en_US/sdk.js` is a small LOADER, not the SDK.
 * When it runs it installs a temporary `window.FB` STUB whose `init` only
 * stores the options and whose methods (incl. `login`) only push the call into
 * `FB.__buffer.calls`. It then loads the real bundle, which REPLACES
 * `window.FB` and replays that buffer exactly once.
 *
 * Production defect this fixes: the old loader ran `FB.init` at the loader's
 * `<script>` onload — on the STUB — and kept that object. The owner's click
 * later called `login` on the stale stub: the call was pushed into a buffer
 * that is never replayed again, so no window opened, no callback ran and the
 * SDK stayed silent (its own logging is off by default). Reproduced against
 * Meta's real SDK.
 *
 * Now:
 *  - init happens in Meta's documented `window.fbAsyncInit` hook, which the
 *    real SDK calls once it is ready, and only on an object that passes
 *    {@link isRealFacebookSdk};
 *  - callers must use the LIVE `window.FB` at click time
 *    ({@link getLiveFacebookSdk}), never a reference kept from the load.
 *
 * Idempotent: concurrent/repeated calls share one in-flight promise; a failed
 * load clears it so a retry can start fresh.
 */
import type { EmbeddedSignupConfig } from "./embedded-signup-config";

export type FbLoginResponse = {
  status?: string;
  authResponse?: { code?: string } | null;
};

type FbLoginOptions = {
  config_id: string;
  response_type: "code";
  override_default_response_type: boolean;
  extras?: Record<string, unknown>;
};

export type FacebookSdk = {
  init(params: {
    appId: string;
    version: string;
    cookie?: boolean;
    xfbml?: boolean;
  }): void;
  login(
    callback: (response: FbLoginResponse) => void,
    options?: FbLoginOptions
  ): void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_SCRIPT_ID = "facebook-jssdk";
const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";
/** The real bundle normally arrives within a second or two of the loader. */
export const SDK_READY_TIMEOUT_MS = 20_000;

/** Minimal environment, injectable for tests; defaults to the browser. */
export type SdkHost = {
  window: {
    FB?: unknown;
    fbAsyncInit?: () => void;
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (id: unknown) => void;
  };
  document: {
    getElementById: (id: string) => unknown;
    createElement: (tag: "script") => {
      id: string;
      src: string;
      async: boolean;
      defer: boolean;
      crossOrigin: string | null;
      onerror: null | (() => void);
      remove?: () => void;
    };
    body: { appendChild: (el: unknown) => unknown };
  };
};

function browserHost(): SdkHost | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return {
    window: window as unknown as SdkHost["window"],
    document: document as unknown as SdkHost["document"],
  };
}

let sdkPromise: Promise<FacebookSdk> | null = null;
const initializedSdks = new WeakSet<object>();

/**
 * True only for Meta's real SDK — not the loader's buffering stub (which has
 * `__buffer`), and not an arbitrary object without `init`/`login`.
 */
export function isRealFacebookSdk(candidate: unknown): candidate is FacebookSdk {
  if (!candidate || typeof candidate !== "object") return false;
  const fb = candidate as { init?: unknown; login?: unknown; __buffer?: unknown };
  return typeof fb.init === "function" && typeof fb.login === "function" && !("__buffer" in fb);
}

/** The live `window.FB` if (and only if) it is the real SDK. Read at click time. */
export function getLiveFacebookSdk(host: SdkHost | null = browserHost()): FacebookSdk | null {
  const fb = host?.window.FB;
  return isRealFacebookSdk(fb) ? fb : null;
}

function initOnce(fb: FacebookSdk, config: EmbeddedSignupConfig): FacebookSdk {
  if (!initializedSdks.has(fb)) {
    fb.init({
      appId: config.appId,
      version: config.graphVersion,
      cookie: false,
      xfbml: false,
    });
    initializedSdks.add(fb);
  }
  return fb;
}

/** Whether the LIVE SDK has been initialized by us. Diagnostics only. */
export function isFacebookSdkInitialized(host: SdkHost | null = browserHost()): boolean {
  const fb = getLiveFacebookSdk(host);
  return !!fb && initializedSdks.has(fb);
}

/** True when `window.FB` is currently the loader's buffering stub. Diagnostics only. */
export function isFacebookLoaderStubPresent(host: SdkHost | null = browserHost()): boolean {
  const fb = host?.window.FB as { __buffer?: unknown } | undefined;
  return !!fb && typeof fb === "object" && "__buffer" in fb;
}

/** For tests — forget the in-flight load. */
export function resetFacebookSdkLoaderForTests(): void {
  sdkPromise = null;
}

/**
 * Loads the SDK and resolves with the REAL, initialized `FB` object.
 * Rejects on script load failure, or when the real SDK does not arrive within
 * {@link SDK_READY_TIMEOUT_MS}.
 */
export function loadFacebookSdk(
  config: EmbeddedSignupConfig,
  host: SdkHost | null = browserHost()
): Promise<FacebookSdk> {
  if (!host) {
    return Promise.reject(new Error("Facebook SDK can only load in the browser"));
  }

  const live = getLiveFacebookSdk(host);
  if (live) {
    return Promise.resolve(initOnce(live, config));
  }

  if (sdkPromise) {
    return sdkPromise;
  }

  const { window: w, document: d } = host;
  const pending = new Promise<FacebookSdk>((resolve, reject) => {
    let settled = false;
    const timer = w.setTimeout(() => {
      fail(new Error("Facebook SDK did not become ready"));
    }, SDK_READY_TIMEOUT_MS);

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      w.clearTimeout(timer);
      if (sdkPromise === pending) sdkPromise = null;
      reject(err);
    }

    function ready() {
      if (settled) return;
      const fb = getLiveFacebookSdk(host);
      if (!fb) return; // still the stub — the real SDK calls fbAsyncInit when ready
      settled = true;
      w.clearTimeout(timer);
      try {
        resolve(initOnce(fb, config));
      } catch (err) {
        if (sdkPromise === pending) sdkPromise = null;
        reject(err);
      }
    }

    // Meta's documented readiness hook: the REAL SDK calls it once loaded.
    const previous = w.fbAsyncInit;
    w.fbAsyncInit = () => {
      try {
        previous?.();
      } catch {
        /* another integration's hook must not break ours */
      }
      ready();
    };

    if (!d.getElementById(SDK_SCRIPT_ID)) {
      const script = d.createElement("script");
      script.id = SDK_SCRIPT_ID;
      script.src = SDK_SRC;
      script.async = true;
      script.defer = true;
      script.crossOrigin = "anonymous";
      // No onload → init: at the loader's onload window.FB is still the STUB.
      script.onerror = () => {
        // Drop the failed tag so a retry injects a fresh one.
        try {
          script.remove?.();
        } catch {
          /* ignore */
        }
        fail(new Error("Facebook SDK failed to load"));
      };
      d.body.appendChild(script);
    }
  });
  sdkPromise = pending;
  return pending;
}
