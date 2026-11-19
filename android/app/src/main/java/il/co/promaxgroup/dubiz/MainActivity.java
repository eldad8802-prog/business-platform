package il.co.promaxgroup.dubiz;

import android.os.Bundle;
import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Local plugins are registered before the bridge is created by super.onCreate.
        registerPlugin(AuthCookiesPlugin.class);
        registerPlugin(PushSupportPlugin.class);
        super.onCreate(savedInstanceState);
        // Push channels (dubiz_default / dubiz_urgent). Creates channels only — it
        // never asks for the notification permission (the web app asks on demand).
        NotificationChannels.ensure(this);
        // Replaces the BridgeWebChromeClient that Bridge.initWebView installed (its
        // only call site; nothing else holds it). The subclass is built the same
        // way — super(bridge) registers the same launchers, still before STARTED —
        // and inherits every callback except the Documents upload chooser.
        // bridge is null only when the device has no WebView (no_webview layout).
        if (bridge != null) {
            bridge.getWebView().setWebChromeClient(new DocumentUploadChromeClient(bridge));
        }
    }

    /**
     * Leaving the foreground is the moment before the system may kill the process
     * (a swipe from recents, a low-memory kill in the background). The WebView only
     * writes cookies to disk every ~30 s on its own, so whatever it received since
     * would be lost — the refresh cookie included. Persist it here, on the way out.
     * Blocking and brief; nothing is read or logged.
     */
    @Override
    public void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    public void onStop() {
        super.onStop();
        CookieManager.getInstance().flush();
    }
}
