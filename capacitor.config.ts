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
    // built-in SystemBars handling forwards system-bar insets to the WebView
    // as CSS safe-area values ("css" is also the Capacitor 8 default — pinned
    // here so a future default change can't silently break the contract).
    // The web side consumes them ONLY via the --dz-safe-* vars in globals.css.
    SystemBars: {
      insetsHandling: "css",
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
    StatusBar: {
      style: "LIGHT",
    },
  },
};

export default config;
