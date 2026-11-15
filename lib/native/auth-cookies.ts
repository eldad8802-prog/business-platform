"use client";

/**
 * Make sure the refresh cookie an auth response just set is on DISK.
 *
 * In the Android app the WebView persists cookies on its own schedule (~30 s).
 * Killed before that, the device loses the cookie it was just given: the next
 * refresh then has no credential, or a stale one the server refuses after its
 * grace — and the person is asked to sign in again with a perfectly good session
 * on the server. The native AuthCookies plugin persists the jar on demand.
 *
 * Call it after an auth response has been RECEIVED (the browser has processed
 * its Set-Cookie into the jar by the time `fetch` resolves). Fire-and-forget:
 * persistence must never delay or fail a sign-in.
 *
 * A no-op everywhere else: a browser, iOS, and an older app build that does not
 * ship the plugin. Nothing is passed and nothing comes back — the cookie value
 * never reaches JavaScript.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

type AuthCookiesPlugin = { flush(): Promise<void> };

const AuthCookies = registerPlugin<AuthCookiesPlugin>("AuthCookies");

export async function flushAuthCookies(): Promise<void> {
  try {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return;
    if (!Capacitor.isPluginAvailable("AuthCookies")) return;
    await AuthCookies.flush();
  } catch {
    /* persistence is best effort; the WebView's own schedule still runs */
  }
}
