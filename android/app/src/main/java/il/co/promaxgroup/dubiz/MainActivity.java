package il.co.promaxgroup.dubiz;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Replaces the BridgeWebChromeClient that Bridge.initWebView installed (its
        // only call site; nothing else holds it). The subclass is built the same
        // way — super(bridge) registers the same launchers, still before STARTED —
        // and inherits every callback except the Documents upload chooser.
        // bridge is null only when the device has no WebView (no_webview layout).
        if (bridge != null) {
            bridge.getWebView().setWebChromeClient(new DocumentUploadChromeClient(bridge));
        }
    }
}
