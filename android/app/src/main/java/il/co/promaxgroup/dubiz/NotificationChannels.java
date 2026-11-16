package il.co.promaxgroup.dubiz;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/**
 * The app's notification channels, created once at start-up.
 *
 * Creating a channel asks the person for nothing and shows nothing: the
 * POST_NOTIFICATIONS permission is requested only from an explicit action in
 * the web app (lib/native/push-notifications.ts requestPushPermission). Calling
 * this again is a no-op for an existing channel — Android keeps the person's own
 * choices (sound, importance) and ignores ours once the channel exists.
 *
 * Lock screen: we ASK for PRIVATE here, but Android keeps an app-created channel at
 * VISIBILITY_NO_OVERRIDE (verified on API 36: lockscreenVisibility = -1000) — only the
 * person can change a channel's lock-screen setting. Privacy is therefore enforced PER
 * MESSAGE: the server sends android.notification.visibility = PRIVATE and a generic,
 * lock-screen-safe text (lib/notifications/push/fcm-client.ts, push-content.ts).
 * Ids are part of the server contract (FCM android.notification.channel_id) and
 * must never be renamed: a renamed channel is a new channel, and the person's
 * settings on the old one are lost.
 */
final class NotificationChannels {

    static final String DEFAULT_ID = "dubiz_default";
    static final String URGENT_ID = "dubiz_urgent";

    private NotificationChannels() {}

    static void ensure(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager == null) return;

            NotificationChannel standard = new NotificationChannel(
                DEFAULT_ID,
                context.getString(R.string.notification_channel_default_name),
                NotificationManager.IMPORTANCE_DEFAULT);
            standard.setDescription(context.getString(R.string.notification_channel_default_description));
            standard.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);

            NotificationChannel urgent = new NotificationChannel(
                URGENT_ID,
                context.getString(R.string.notification_channel_urgent_name),
                NotificationManager.IMPORTANCE_HIGH);
            urgent.setDescription(context.getString(R.string.notification_channel_urgent_description));
            urgent.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);

            manager.createNotificationChannel(standard);
            manager.createNotificationChannel(urgent);
        } catch (RuntimeException ignored) {
            // Never let channel setup stop the app from starting; FCM falls back to its own channel.
        }
    }
}
