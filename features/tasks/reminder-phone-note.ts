/**
 * What the "My day" reminders card says INSIDE THE ANDROID APP (the app's WebView has no web push at all, so the
 * browser check — lib/push/push-client.ts pushState — always answered "no phone notifications here", even on a phone
 * that is registered for the notification engine's Android push).
 *
 * Inside the app the card reads the app's own state instead: the build is configured for push (Firebase), the
 * Android permission, the device-local opt-in, and the SERVER's answer for THIS login session
 * (GET /api/push/devices → { registered }; 404 = the notification engine is off for the business).
 *
 * Truthful about task reminders: until they are sent through the notification engine
 * (TASK_REMINDERS_REACH_ANDROID), a connected phone is told that reminders still appear inside Dubiz and in the
 * bell — never that they will arrive on the phone.
 */

/**
 * Task reminders reach the Android app: since #1218 a business with the notification engine ON sends every task
 * reminder through the engine to the user's live devices (lib/services/tasks/task-reminders.service.ts). The card
 * says so only on the SERVER's yes for this session (registered) — engine OFF answers 404 (engine_off) first.
 */
export const TASK_REMINDERS_REACH_ANDROID = true;

export type AppPermission = "granted" | "denied" | "prompt" | "unavailable";
export type ServerDevice = "registered" | "not_registered" | "engine_off" | "unknown";

export type AppPushInputs = {
  /** The build carries a Firebase configuration and the push plugin. */
  configured: boolean;
  permission: AppPermission;
  /** The person turned phone notifications on from this device. */
  optedIn: boolean;
  server: ServerDevice;
};

export type AppReminderNote =
  | "app_without_push"
  | "blocked"
  | "engine_off"
  | "not_connected"
  | "check_failed"
  | "connected_reminders_in_app"
  | "connected_reminders_on_phone";

export function appReminderNote(i: AppPushInputs, remindersReachAndroid: boolean = TASK_REMINDERS_REACH_ANDROID): AppReminderNote {
  if (!i.configured || i.permission === "unavailable") return "app_without_push";
  if (i.permission === "denied") return "blocked";
  if (i.server === "engine_off") return "engine_off";
  if (i.permission === "prompt" || !i.optedIn || i.server === "not_registered") return "not_connected";
  if (i.server === "unknown") return "check_failed";
  return remindersReachAndroid ? "connected_reminders_on_phone" : "connected_reminders_in_app";
}

/** GET /api/push/devices → the server's answer. `status` null = no answer. */
export function serverDeviceFrom(status: number | null, body: unknown): ServerDevice {
  if (status === 404) return "engine_off";
  if (status === null || status < 200 || status >= 300) return "unknown";
  const r = (body as { registered?: unknown } | null)?.registered;
  if (r === true) return "registered";
  if (r === false) return "not_registered";
  return "unknown";
}

/** The card's text (Hebrew only, like the rest of the card). `settingsLink` marks where the settings link goes. */
export const APP_REMINDER_COPY: Record<AppReminderNote, { text: string; settingsLink: boolean }> = {
  app_without_push: { text: "בגרסה הזו של האפליקציה אין התראות לטלפון. התזכורות יופיעו בתוך דוביז ובפעמון.", settingsLink: false },
  blocked: {
    text: "ההתראות של דוביז כבויות בהגדרות הטלפון (הגדרות ← אפליקציות ← דוביז ← התראות). עד שיופעלו, התזכורות יופיעו בתוך דוביז ובפעמון.",
    settingsLink: false,
  },
  engine_off: { text: "התראות לטלפון עדיין לא פעילות בעסק הזה. התזכורות יופיעו בתוך דוביז ובפעמון.", settingsLink: false },
  not_connected: { text: "הטלפון עדיין לא מחובר להתראות. עד שיחובר, התזכורות יופיעו בתוך דוביז ובפעמון.", settingsLink: true },
  check_failed: { text: "לא הצלחנו לבדוק את חיבור הטלפון להתראות. התזכורות יופיעו בתוך דוביז ובפעמון.", settingsLink: true },
  connected_reminders_in_app: {
    text: "הטלפון מחובר להתראות של דוביז. תזכורות משימה עדיין מופיעות רק בתוך דוביז ובפעמון.",
    settingsLink: false,
  },
  connected_reminders_on_phone: { text: "הטלפון מחובר להתראות. התזכורות יגיעו גם כהתראה בטלפון, בשעה שבחרת.", settingsLink: true },
};

export const APP_REMINDER_SETTINGS_LABEL = "הגדרות התראות";
export const APP_REMINDER_SETTINGS_HREF = "/settings/notifications";
