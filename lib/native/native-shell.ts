"use client";

/**
 * Native shell runtime contract (Adaptive + Native Spec v1 §13–§16).
 *
 * The single place the web app talks to the Capacitor host. Everything here is
 * a no-op in a plain browser: `isNative()` gates every call, and plugin
 * modules are imported dynamically so the web bundle never ships native-only
 * code paths to browser users beyond this thin file.
 *
 * Owned behaviors:
 *  - splash hide once the app is interactive (launchAutoHide=false in config);
 *  - status-bar style for the light DS surfaces;
 *  - Android hardware/predictive back: history.back() while there is history,
 *    otherwise minimize (never blindly exit, never a WebView navigation trap);
 *  - `openExternal()` — the ONLY sanctioned way to open external/OAuth URLs:
 *    system browser (Custom Tabs / SFSafariViewController), never in-WebView
 *    (allowNavigation stays minimal by policy; Google blocks embedded
 *    user-agents for OAuth anyway).
 */

import { Capacitor } from "@capacitor/core";

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/** Open an external / OAuth / provider URL in the system browser. */
export async function openExternal(url: string): Promise<void> {
  if (!isNative()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { Browser } = await import("@capacitor/browser");
  await Browser.open({ url });
}

/**
 * Android <= 14: keep the WebView below the status bar.
 *
 * @capacitor/status-bar defaults to overlaysWebView=true (capacitor.config.ts
 * does not set it), so on launch it lays the WebView out BEHIND the status bar
 * on every Android version. On Android 15+ SystemBars pads the WebView back
 * below the bar (lib/native/android-viewport-fit.ts); below 15 nothing does, so
 * every screen drew under the clock. Turning the overlay off here fixes the
 * Google Play binary already installed (the plugin ships in it). On 15+ it
 * changes nothing: edge-to-edge is enforced, SystemBars keeps padding.
 *
 * With the overlay off, Android <= 14 paints the bar with the plugin's own
 * colour (black). setBackgroundColor only acts below Android 15 — the plugin
 * gates it itself, so no version detection here — and, while the style is
 * Default, also picks icons that contrast with that colour. The colours match
 * the strip Android 15+ shows (the DayNight window background).
 */
export const ANDROID_STATUS_BAR_COLOR = { light: "#FAFAFA", dark: "#303030" } as const;

type StatusBarApi = typeof import("@capacitor/status-bar").StatusBar;

export async function placeAndroidWebViewBelowStatusBar(statusBar: StatusBarApi): Promise<void> {
  await statusBar.setOverlaysWebView({ overlay: false });
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)");
  const paint = () =>
    statusBar.setBackgroundColor({ color: dark?.matches ? ANDROID_STATUS_BAR_COLOR.dark : ANDROID_STATUS_BAR_COLOR.light });
  await paint();
  dark?.addEventListener?.("change", () => void paint().catch(() => {}));
}

let initialized = false;

/** Idempotent; called once from NativeShellInit when running inside the shell. */
export async function initNativeShell(): Promise<void> {
  if (!isNative() || initialized) return;
  initialized = true;

  // Android back contract: in-app history first, then minimize. Registered
  // through @capacitor/app, whose Android side uses OnBackPressedCallback —
  // the AndroidX dispatcher path that stays valid under predictive back
  // (targetSdk 36: onBackPressed/KEYCODE_BACK are no longer delivered).
  try {
    const { App } = await import("@capacitor/app");
    App.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack || window.history.length > 1) {
        window.history.back();
      } else {
        void App.minimizeApp();
      }
    });
  } catch (err) {
    console.error("[native-shell] back handler failed:", err);
  }

  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    // Android: Capacitor now pads the WebView below the status bar (see
    // lib/native/android-viewport-fit.ts), so the strip behind the icons is the
    // window background — light in light mode, dark grey in dark mode until the
    // theme sets a cream windowBackground. Default makes the icons follow the
    // system theme so they stay readable on that strip. iOS keeps Light: its
    // strip is the cream WebView background in both modes.
    await StatusBar.setStyle({ style: Capacitor.getPlatform() === "android" ? Style.Default : Style.Light });
    if (Capacitor.getPlatform() === "android") await placeAndroidWebViewBelowStatusBar(StatusBar);
  } catch (err) {
    console.error("[native-shell] status bar failed:", err);
  }

  // Hide the splash as soon as the web shell is interactive. This is now an
  // OPTIMIZATION, not the only exit: capacitor.config.ts keeps launchAutoHide
  // true (+ launchShowDuration) after W7 proved a held splash can leave the
  // activity without a focused window and ANR. Calling hide() when it is
  // already hidden is a no-op.
  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  } catch (err) {
    console.error("[native-shell] splash hide failed:", err);
  }
}
