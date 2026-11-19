package il.co.promaxgroup.dubiz;

import android.webkit.CookieManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Persist the WebView's cookie jar NOW.
 *
 * Android's WebView writes cookies to disk on its own schedule — roughly every
 * 30 seconds. A Set-Cookie that has been received (it is already in the jar, so
 * the page sees it) is lost if the process dies before that write: QA measured
 * the refresh cookie missing after a kill 3 s after sign-in, and a stale one
 * (refused as replay_unproven) after a kill 3 s after a refresh. Capacitor never
 * flushes the jar itself.
 *
 * The web app calls this right after an auth response has been received — by
 * then the cookie has been processed into the jar — so the response's cookie is
 * on disk before anything can kill the process.
 *
 * Deliberately minimal: no argument, no return value, nothing read, nothing
 * logged. A cookie value never crosses into JavaScript or a log line; this only
 * asks the platform to persist what it already holds, with the attributes the
 * server set (HttpOnly, Secure, SameSite=Strict) untouched.
 */
@CapacitorPlugin(name = "AuthCookies")
public class AuthCookiesPlugin extends Plugin {

    @PluginMethod
    public void flush(PluginCall call) {
        // Plugin methods run off the UI thread; flush() blocks until written.
        CookieManager.getInstance().flush();
        call.resolve();
    }
}
