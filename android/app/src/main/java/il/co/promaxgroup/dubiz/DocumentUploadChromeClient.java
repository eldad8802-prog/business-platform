package il.co.promaxgroup.dubiz;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.Arrays;
import java.util.List;

/**
 * "העלאת מסמך" opens the system document picker (ACTION_OPEN_DOCUMENT).
 *
 * Capacitor's default chooser sends ACTION_GET_CONTENT, which some Android
 * builds hand to a gallery app. ACTION_OPEN_DOCUMENT is answered only by the
 * system DocumentsUI (Recent, Downloads, Drive, Images...).
 *
 * Scope is exactly one input: the Documents upload input, recognised by its
 * accept signature (lib/documents/document-file-input.ts → DOCUMENT_UPLOAD_ACCEPT)
 * with no `capture`. Every other <input type=file> — including "צילום מסמך"
 * (capture) and other modules — goes to Capacitor unchanged.
 */
public class DocumentUploadChromeClient extends BridgeWebChromeClient {

    /** Must equal DOCUMENT_UPLOAD_ACCEPT split on "," (WebView does not trim). */
    static final List<String> DOCUMENT_UPLOAD_ACCEPT = Arrays.asList(
        "application/pdf", "image/jpeg", "image/png", ".pdf", ".jpg", ".jpeg", ".png"
    );

    private static final String[] DOCUMENT_MIME_TYPES = { "application/pdf", "image/jpeg", "image/png" };

    private final ActivityResultLauncher<Intent> documentPicker;
    private ValueCallback<Uri[]> pendingCallback;

    public DocumentUploadChromeClient(Bridge bridge) {
        super(bridge);
        documentPicker = bridge.registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), (result) -> {
            ValueCallback<Uri[]> callback = pendingCallback;
            pendingCallback = null;
            if (callback != null) {
                // Cancel → null, which the WebView reports to the page as a cancel.
                callback.onReceiveValue(FileChooserParams.parseResult(result.getResultCode(), result.getData()));
            }
        });
    }

    static boolean isDocumentUpload(FileChooserParams params) {
        return (
            !params.isCaptureEnabled() &&
            params.getMode() == FileChooserParams.MODE_OPEN &&
            Arrays.asList(params.getAcceptTypes()).equals(DOCUMENT_UPLOAD_ACCEPT)
        );
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
        if (!isDocumentUpload(fileChooserParams)) {
            return super.onShowFileChooser(webView, filePathCallback, fileChooserParams);
        }
        if (pendingCallback != null) {
            pendingCallback.onReceiveValue(null);
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, DOCUMENT_MIME_TYPES);
        pendingCallback = filePathCallback;
        try {
            documentPicker.launch(intent);
        } catch (ActivityNotFoundException e) {
            // No system document picker (unusual builds): Capacitor's default chooser.
            pendingCallback = null;
            return super.onShowFileChooser(webView, filePathCallback, fileChooserParams);
        }
        return true;
    }
}
