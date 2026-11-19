package il.co.promaxgroup.dubiz;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Is this build configured for push (FCM)?
 *
 * The push plugin's register() calls FirebaseMessaging.getInstance(), which
 * throws when Firebase was never initialised — a build made without
 * google-services.json — and Capacitor rethrows an exception from a plugin
 * method as a RuntimeException: the app would CRASH. The web app asks here
 * first and never calls register() when the answer is no.
 *
 * The google-services Gradle plugin turns google-services.json into the
 * string resource google_app_id, which is what Firebase's own start-up
 * (FirebaseInitProvider / FirebaseOptions.fromResource) requires. Its absence
 * means Firebase is not initialised. Nothing secret is read or returned.
 */
@CapacitorPlugin(name = "PushSupport")
public class PushSupportPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        boolean configured = false;
        try {
            int id = getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName());
            configured = id != 0 && !getContext().getString(id).isEmpty();
        } catch (RuntimeException ignored) {
            configured = false;
        }
        JSObject result = new JSObject();
        result.put("configured", configured);
        call.resolve(result);
    }
}
