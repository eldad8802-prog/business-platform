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
  appId: "co.il.promaxgroup.dubiz",
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
  },
};

export default config;
