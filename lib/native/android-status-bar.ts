/**
 * Android shell: keep the WebView below the status bar on Android 14 and older
 * (issue 2, part 2 — the part lib/native/android-viewport-fit.ts cannot reach).
 *
 * Two native plugins decide where the WebView sits:
 *   - @capacitor/status-bar loads with `overlaysWebView` defaulting to TRUE
 *     (StatusBarConfig.java; capacitor.config.ts does not set it), which sets
 *     SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN — the WebView is laid out BEHIND the
 *     status bar on every Android version;
 *   - Capacitor's SystemBars pads the WebView by the system bars only on
 *     Android 15+ (API 35, SystemBars.java), and reports zero insets to the page.
 * So below Android 15 every screen draws under the status bar and the page is
 * told there is nothing to reserve. Proven on the API 34 emulator: identical
 * overlap before and after the viewport switch.
 *
 * The fix is the plugin's own switch, called at runtime because the installed
 * Play binary cannot change: setOverlaysWebView({ overlay: false }) clears the
 * fullscreen layout flags, so Android itself places the WebView below the bar.
 * Turning the overlay off restores the bar's saved colour, which is the plugin's
 * default BLACK — with the LIGHT style's dark icons that is unreadable — so the
 * bar is painted the DS cream the pages sit on. On Android 15+ both calls are
 * inert (edge-to-edge is enforced; the plugin skips the colour itself), and
 * SystemBars keeps padding as before.
 *
 * The call runs twice-guarded, once per document:
 *   - ANDROID_SHELL_STATUS_BAR_SCRIPT, inline in the root layout, before first
 *     paint — Capacitor injects its bridge (window.Capacitor.nativePromise) at
 *     document start, so the native call needs no app bundle. It leaves its
 *     promise on window.__dzStatusBarBelow;
 *   - placeAndroidStatusBarBelow(), from initNativeShell, waits for that promise
 *     or, on documents where the inline script never ran, makes the calls itself.
 * Every native failure is swallowed: a missing plugin must never break a page.
 */

export const ANDROID_STATUS_BAR_COLOR = "#FEF8F2";

export const ANDROID_SHELL_STATUS_BAR_SCRIPT = `(function(){try{if(typeof window.CapacitorSystemBarsAndroidInterface==="undefined"||window.__dzStatusBarBelow)return;var C=window.Capacitor;if(!C||typeof C.nativePromise!=="function")return;var q=function(m,o){try{return Promise.resolve(C.nativePromise("StatusBar",m,o)).catch(function(){});}catch(e){return Promise.resolve();}};window.__dzStatusBarBelow=Promise.all([q("setOverlaysWebView",{overlay:false}),q("setBackgroundColor",{color:"${ANDROID_STATUS_BAR_COLOR}"})]);}catch(e){}})();`;

type StatusBarApi = {
  setOverlaysWebView(options: { overlay: boolean }): Promise<void>;
  setBackgroundColor(options: { color: string }): Promise<void>;
  getInfo(): Promise<{ color?: string }>;
};
type ShellWindow = { __dzStatusBarBelow?: Promise<unknown> };

/**
 * Makes sure the overlay is off for this document and reports whether the bar
 * now wears the cream colour — true only where the plugin may still paint the
 * bar (Android 14 and older), so the caller picks dark icons there and keeps
 * system-following icons on Android 15+, where the strip is the window background.
 */
export async function placeAndroidStatusBarBelow(
  statusBar: StatusBarApi,
  win: ShellWindow = window as unknown as ShellWindow
): Promise<boolean> {
  if (!win.__dzStatusBarBelow) {
    const quiet = (p: () => Promise<void>) => p().catch(() => undefined);
    win.__dzStatusBarBelow = Promise.all([
      quiet(() => statusBar.setOverlaysWebView({ overlay: false })),
      quiet(() => statusBar.setBackgroundColor({ color: ANDROID_STATUS_BAR_COLOR })),
    ]);
  }
  try {
    await win.__dzStatusBarBelow;
    // getInfo runs on the plugin thread, the setters on the main thread: read only after both resolved.
    const info = await statusBar.getInfo();
    return (info.color ?? "").toUpperCase() === ANDROID_STATUS_BAR_COLOR;
  } catch {
    return false;
  }
}
