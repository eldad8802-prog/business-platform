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
 *
 * It keeps the cover out afterwards too: Capacitor reads the meta
 * asynchronously after DOMContentLoaded, and Next re-renders the viewport meta
 * on hydration — on a light page that put the cover back before Capacitor
 * looked (emulator sweep, /settings/inbound-email). A MutationObserver strips
 * it again as a microtask, before Capacitor's read can run. It watches the
 * whole document, so a viewport meta re-created anywhere is caught. Capacitor
 * reads the meta once per page load, so the observer disconnects 15 s after
 * DOMContentLoaded — no cost for the rest of the visit. Documents where this
 * script cannot run at all are covered by ensureAndroidShellViewport() below.
 */
export const ANDROID_SHELL_VIEWPORT_SCRIPT = `(function(){try{if(typeof window.CapacitorSystemBarsAndroidInterface==="undefined")return;var strip=function(){var m=document.querySelectorAll('meta[name="viewport"]');for(var i=0;i<m.length;i++){var c=m[i].getAttribute("content")||"";if(/viewport-fit\\s*=\\s*cover/i.test(c)){m[i].setAttribute("content",c.replace(/\\s*,?\\s*viewport-fit\\s*=\\s*cover/gi,"").replace(/^\\s*,\\s*/,""));}}};strip();if(typeof MutationObserver!=="undefined"&&document.documentElement){var o=new MutationObserver(strip);o.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["content"]});document.addEventListener("DOMContentLoaded",function(){setTimeout(function(){o.disconnect();},15000);});}}catch(e){}})();`;

type ShellWindow = { CapacitorSystemBarsAndroidInterface?: { onDOMReady?: () => void } };
type ViewportMeta = { getAttribute(name: string): string | null; setAttribute(name: string, value: string): void };

/**
 * Client-side backstop for documents where the inline script never ran: Next's
 * error-fallback document (a notFound() thrown inside a layout) renders the root
 * layout on the client, and a <script> React inserts is not executed. Inside the
 * Android shell only, this strips viewport-fit=cover and — only if it had to —
 * asks Capacitor to read the viewport again (SystemBars' public onDOMReady), so
 * that page also gets the padded layout. On normal pages the script already ran
 * and this is a no-op. Returns whether it changed anything.
 */
export function ensureAndroidShellViewport(
  win: ShellWindow = window as unknown as ShellWindow,
  doc: { querySelectorAll(selector: string): ArrayLike<ViewportMeta> } = document
): boolean {
  const shell = win.CapacitorSystemBarsAndroidInterface;
  if (!shell) return false;
  let stripped = false;
  const metas = doc.querySelectorAll('meta[name="viewport"]');
  for (let i = 0; i < metas.length; i++) {
    const content = metas[i].getAttribute("content") ?? "";
    if (/viewport-fit\s*=\s*cover/i.test(content)) {
      metas[i].setAttribute("content", content.replace(/\s*,?\s*viewport-fit\s*=\s*cover/gi, "").replace(/^\s*,\s*/, ""));
      stripped = true;
    }
  }
  if (stripped && typeof shell.onDOMReady === "function") {
    try {
      shell.onDOMReady();
    } catch {
      // the padded layout is a nicety on these pages; never break them over it
    }
  }
  return stripped;
}
