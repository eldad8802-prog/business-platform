import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor — Milestone A (native shell scaffold only).
 *
 * Dubiz is a Next.js SERVER app, so the native shell loads it as a remote
 * WebView via `server.url`. That URL is ENVIRONMENT-DRIVEN (CAP_SERVER_URL) so a
 * build never hard-codes a production origin:
 *   - unset            -> loads the bundled offline fallback (capacitor/www),
 *                         never silently binds to the wrong origin.
 *   - dev / preview    -> point at the local / preview origin.
 *   - production        -> set explicitly at build time to the dedicated app
 *                         origin (final domain decided before the production
 *                         build; no DNS change here).
 *
 * NOT wired yet (Milestone B+): OAuth/provider navigation origins, deep links,
 * native downloads/scanner. `allowNavigation` is intentionally empty.
 */
const serverUrl = process.env.CAP_SERVER_URL?.trim();

/**
 * Is the CLI building the Android project? Capacitor writes ONE plugins config to every platform, and iOS
 * honours StatusBar.overlaysWebView / backgroundColor and SystemBars.style as well — so the Android-only bar
 * settings below are added only for `npx cap sync|copy|update|run android`. If the platform cannot be told
 * (a bare `npx cap sync`), nothing is added: iOS is untouched and Android keeps today's behaviour (the web
 * app turns the overlay off at start-up, lib/native/native-shell.ts). Release builds run `cap sync android`.
 */
export function isAndroidCapBuild(argv: readonly string[] = process.argv): boolean {
  return argv.includes("android") && !argv.includes("ios");
}
const androidBars = isAndroidCapBuild();

/** The app background behind the bars (android/app/src/main/res/values/colors.xml dubizAppBackground). */
export const ANDROID_BAR_COLOR = "#FEF8F2";

const config: CapacitorConfig = {
  appId: "il.co.promaxgroup.dubiz",
  appName: "Dubiz",
  webDir: "capacitor/www",
  server: {
    ...(serverUrl ? { url: serverUrl } : {}),
    androidScheme: "https",
    iosScheme: "https",
    // Only the app origin is navigable in-WebView. Provider/OAuth origins are
    // added deliberately in Milestone B — never opened as arbitrary hosts.
    allowNavigation: [],
    // Branded reconnect screen (capacitor/www/index.html) shown by the native
    // shell when the remote server.url cannot be reached (no blank white view).
    errorPath: "index.html",
  },
  ios: {
    contentInset: "always",
  },
  android: {
    // Release builds must never allow cleartext (http) content.
    allowMixedContent: false,
    // DS cream behind the WebView so the splash→content hand-off (and any
    // remote-load gap) is brand cream, never a white flash.
    backgroundColor: "#FEF8F2",
  },
  plugins: {
    // Edge-to-edge contract (Adaptive+Native Spec v1 §12–§13): Capacitor 8's
    // built-in SystemBars handling ("css" is also the Capacitor 8 default —
    // pinned here so a future default change can't silently break it).
    // On Android the web app deliberately takes SystemBars' PADDED path: the
    // root layout drops viewport-fit=cover inside the Android shell
    // (lib/native/android-viewport-fit.ts), so the WebView sits below the status
    // bar and above the navigation bar and pages see zero insets — the pages
    // never reserved the top inset, and WebView 140+ otherwise drew every screen
    // under the status bar (issue 2). iOS keeps cover + ios.contentInset.
    // Android: dark icons on the cream bars in light AND dark mode. SystemBars re-applies its style on
    // every configuration change (rotation, dark mode); left at its default it would follow the system
    // theme and turn the icons light on cream.
    SystemBars: {
      insetsHandling: "css",
      ...(androidBars ? { style: "LIGHT" } : {}),
    },
    // Branded launch: DS v1 warm cream behind the splash.
    //
    // launchAutoHide MUST stay true for a REMOTE-WebView app. It was false in
    // the first native-foundation cut, so the splash was held until the web
    // shell called SplashScreen.hide(). W7 run 4 proved that traps the app: on
    // a cold emulator the remote page had not painted within 5s, the activity
    // never added a focused window, and Android raised
    //   ANR in il.co.promaxgroup.dubiz — Input dispatching timed out
    //     (Application does not have a focused window)
    // with the splash still on screen (see the W7 evidence screenshots). A
    // remote page must never be able to hold the launch window open: the
    // system now always retires the splash, and native-shell.ts still calls
    // hide() for the faster case.
    SplashScreen: {
      backgroundColor: "#FEF8F2",
      launchAutoHide: true,
      launchShowDuration: 2000,
      showSpinner: false,
    },
    // Light product surfaces → dark status-bar content on both platforms.
    // Android: the WebView below the status bar from the first frame (Android 14 and older; 15+ is
    // edge-to-edge and padded by SystemBars either way), on the cream bar the theme also sets.
    StatusBar: {
      style: "LIGHT",
      ...(androidBars ? { overlaysWebView: false, backgroundColor: ANDROID_BAR_COLOR } : {}),
    },
  },
};

export default config;
