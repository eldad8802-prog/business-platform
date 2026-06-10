/**
 * Lazy loader for the Facebook JS SDK (Ticket 3).
 *
 * The SDK script is injected ONLY when `loadFacebookSdk` is first called —
 * i.e. when the user presses "אפשר להתחיל". It is never imported at module
 * load, never prefetched, and never loaded on page mount. The load is
 * idempotent: concurrent/repeated calls share one in-flight promise.
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

let sdkPromise: Promise<FacebookSdk> | null = null;
let initialized = false;

function initOnce(config: EmbeddedSignupConfig): FacebookSdk {
  const FB = window.FB;
  if (!FB) {
    throw new Error("Facebook SDK not available after load");
  }
  if (!initialized) {
    FB.init({
      appId: config.appId,
      version: config.graphVersion,
      cookie: false,
      xfbml: false,
    });
    initialized = true;
  }
  return FB;
}

/**
 * Loads + initializes the SDK and resolves with the global `FB` object.
 * Rejects on script load failure (network / blockers); the in-flight promise
 * is cleared on failure so a later retry can attempt a fresh load.
 */
export function loadFacebookSdk(
  config: EmbeddedSignupConfig
): Promise<FacebookSdk> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Facebook SDK can only load in the browser"));
  }

  if (window.FB) {
    return Promise.resolve(initOnce(config));
  }

  if (sdkPromise) {
    return sdkPromise;
  }

  sdkPromise = new Promise<FacebookSdk>((resolve, reject) => {
    const finish = () => {
      try {
        resolve(initOnce(config));
      } catch (err) {
        sdkPromise = null;
        reject(err);
      }
    };

    const existing = document.getElementById(SDK_SCRIPT_ID);
    if (existing) {
      existing.addEventListener("load", finish, { once: true });
      existing.addEventListener(
        "error",
        () => {
          sdkPromise = null;
          reject(new Error("Facebook SDK failed to load"));
        },
        { once: true }
      );
      if (window.FB) finish();
      return;
    }

    const script = document.createElement("script");
    script.id = SDK_SCRIPT_ID;
    script.src = SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onload = finish;
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error("Facebook SDK failed to load"));
    };
    document.body.appendChild(script);
  });

  return sdkPromise;
}
