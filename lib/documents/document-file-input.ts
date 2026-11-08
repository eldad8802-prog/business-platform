/**
 * `<input type="file">` attributes for the Documents upload and camera actions.
 * One source for every screen that offers them (hub + /documents/upload).
 *
 * Upload: exactly the types /api/documents/upload accepts (PDF, JPEG, PNG —
 * HEIC is refused server-side). No `capture`, so the OS offers its file picker.
 * PDF is listed first on purpose: Android WebView's createIntent() uses the
 * first type as the ACTION_GET_CONTENT intent type.
 *
 * Camera: `accept` MUST be the literal "image/*". The Capacitor Android shell
 * (BridgeWebChromeClient.onShowFileChooser) only opens the camera when the
 * accept list contains the exact token "image/*"; with "image/jpeg,image/png"
 * it ignored `capture` and opened ACTION_GET_CONTENT image/jpeg — the gallery.
 * Necessary but not sufficient: on Android 11+ the shell also needs a manifest
 * <queries> entry for IMAGE_CAPTURE, or resolveActivity() returns null and it
 * falls back to the photo picker (emulator probe, runs 42527941980/42529183894).
 * Camera apps return JPEG, and the server still validates type and bytes.
 *
 * No spaces after commas: WebView splits `accept` on "," without trimming.
 */
export const DOCUMENT_UPLOAD_ACCEPT = "application/pdf,image/jpeg,image/png";

export const DOCUMENT_CAMERA_ACCEPT = "image/*";

export const DOCUMENT_CAMERA_CAPTURE = "environment";
