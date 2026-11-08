package il.co.promaxgroup.dubiz;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // null only when the device has no WebView (BridgeActivity shows no_webview).
        if (bridge != null) {
            bridge.getWebView().setWebChromeClient(new DocumentUploadChromeClient(bridge));
        }
    }
}
