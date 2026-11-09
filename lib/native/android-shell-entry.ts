/**
 * Android shell entry: the app opens on sign-in, never on the marketing page.
 *
 * The Android app loads https://promaxgroup.co.il/ (capacitor.config.ts server.url), and
 * next.config.ts rewrites `/` on the apex host to the public homepage (/home) on the server,
 * before anything knows who is signed in. This script runs first in <head>, before anything is
 * painted, and only inside the Android shell:
 *   - marks <html data-shell="android"> so app-only CSS (globals.css: [data-shell-hide] /
 *     [data-shell-only]) applies from the first frame — no layout shift;
 *   - on `/` or `/home`, hides the page and replaces it with /login. /login already validates an
 *     existing session against the server and goes straight to /app when it is valid (no form
 *     flash); otherwise it shows the form. /login never sends anyone back to `/`, so no loop, and
 *     replace() keeps the marketing page out of history (Android back minimizes from /login).
 *
 * `CapacitorSystemBarsAndroidInterface` is the JavaScript interface Capacitor's SystemBars plugin
 * adds to the Android WebView from page start (the same detection as android-viewport-fit.ts) —
 * not the user agent. Browsers, iPhone and the iOS shell never have it: the public site is unchanged.
 */
export const ANDROID_SHELL_ENTRY_SCRIPT = `(function(){try{if(typeof window.CapacitorSystemBarsAndroidInterface==="undefined")return;var d=document.documentElement;d.setAttribute("data-shell","android");var p=location.pathname;if(p==="/"||p==="/home"){d.style.visibility="hidden";location.replace("/login");}}catch(e){}})();`;

/** The marketing routes the Android app never shows (`/` is rewritten to /home on the apex host). */
export const ANDROID_SHELL_MARKETING_PATHS: readonly string[] = ["/", "/home"];

type EntryWindow = {
  CapacitorSystemBarsAndroidInterface?: unknown;
  location: { replace(url: string): void };
};

/**
 * Client backstop for in-app navigation, where the <head> script does not run again: a public page
 * opened from the app (e.g. the privacy policy linked from sign-up) has the site header, whose logo
 * links to /home. Inside the Android shell only, landing on a marketing route sends the app to
 * /login instead. Returns whether it redirected.
 */
export function leaveMarketingInAndroidShell(
  pathname: string | null,
  win: EntryWindow = window as unknown as EntryWindow
): boolean {
  if (typeof win.CapacitorSystemBarsAndroidInterface === "undefined") return false;
  if (!pathname || !ANDROID_SHELL_MARKETING_PATHS.includes(pathname)) return false;
  win.location.replace("/login");
  return true;
}
