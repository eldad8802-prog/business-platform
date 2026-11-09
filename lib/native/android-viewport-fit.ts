/**
 * Android shell: keep every screen below the status bar and above the
 * navigation bar — one switch for the whole app, no per-screen CSS.
 *
 * Capacitor 8's SystemBars plugin (insetsHandling "css", capacitor.config.ts)
 * has two Android layouts, chosen on DOMContentLoaded from the page's own
 * viewport meta (SystemBars.java):
 *   - WebView >= 140 AND viewport-fit=cover → it passes the system-bar insets
 *     through to the page (edge-to-edge) and expects CSS to reserve them;
 *   - otherwise → it pads the WebView itself by the system bars (and by the
 *     keyboard), and the page sees zero insets.
 * The root layout declares viewport-fit=cover (for iPhone), but the app never
 * reserved the TOP inset — iOS is inset natively (ios.contentInset "always") and
 * older Android WebViews took the padded path. Once phones updated to WebView
 * 140+, every Android screen started drawing under the status bar.
 *
 * This script runs before DOMContentLoaded and, only inside the Android shell,
 * drops viewport-fit=cover, so Capacitor takes the padded path on every screen,
 * overlay and sheet. `CapacitorSystemBarsAndroidInterface` is the JavaScript
 * interface the SystemBars plugin adds to the Android WebView; it exists from
 * page start and nowhere else — iPhone, iOS shell and browsers are untouched.
 */
export const ANDROID_SHELL_VIEWPORT_SCRIPT = `(function(){try{if(typeof window.CapacitorSystemBarsAndroidInterface==="undefined")return;var m=document.querySelectorAll('meta[name="viewport"]');for(var i=0;i<m.length;i++){var c=m[i].getAttribute("content")||"";if(/viewport-fit\\s*=\\s*cover/i.test(c)){m[i].setAttribute("content",c.replace(/\\s*,?\\s*viewport-fit\\s*=\\s*cover/gi,"").replace(/^\\s*,\\s*/,""));}}}catch(e){}})();`;
