/**
 * Unit test — a push received while the Android app is OPEN reaches the notification shade.
 * Firebase posts the system notification only while the app is in the background; in the foreground
 * @capacitor/push-notifications posts one only when presentationOptions has "alert" / "banner" / "list".
 * Run: npx tsx lib/native/android-foreground-push.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import config from "../../capacitor.config";

const opts = (config.plugins as Record<string, { presentationOptions?: string[] }> | undefined)?.PushNotifications?.presentationOptions ?? [];
assert.ok(opts.includes("alert"), "PushNotifications.presentationOptions includes alert (foreground → system notification)");
assert.ok(opts.includes("sound"), "…and sound");
console.log("[PASS] capacitor.config: PushNotifications.presentationOptions =", JSON.stringify(opts));

// The installed plugin still posts a foreground notification only for these options, on the message's channel.
const plugin = readFileSync("node_modules/@capacitor/push-notifications/android/src/main/java/com/capacitorjs/plugins/pushnotifications/PushNotificationsPlugin.java", "utf8");
assert.match(plugin, /getConfig\(\)\.getArray\("presentationOptions"\)/, "plugin reads presentationOptions");
assert.match(plugin, /presentationList\.contains\("alert"\) \|\| presentationList\.contains\("banner"\) \|\| presentationList\.contains\("list"\)/, "plugin posts only for alert / banner / list");
assert.match(plugin, /params\.getNotificationChannelId\(\)/, "plugin uses the message's channel id");
assert.match(plugin, /showForegroundNotification\(/, "plugin posts the notification itself");
console.log("[PASS] @capacitor/push-notifications posts the foreground notification for alert, on the message's channel");

// The app's channels still exist for it (created at start-up) and the server still names them.
const channels = readFileSync("android/app/src/main/java/il/co/promaxgroup/dubiz/NotificationChannels.java", "utf8");
assert.ok(channels.includes('"dubiz_default"') && channels.includes('"dubiz_urgent"'), "both channels created by the app");
const catalog = readFileSync("lib/notifications/catalog.ts", "utf8");
assert.match(catalog, /"dubiz_urgent" : "dubiz_default"/, "the server names the same channels");
console.log("[PASS] channels: the app creates dubiz_default / dubiz_urgent, the server sends to them");
console.log("\nandroid-foreground-push: ALL PASS");
