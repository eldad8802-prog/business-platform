/**
 * The "My day" reminders card inside the Android app (features/tasks/reminder-phone-note.ts + push-card.tsx).
 * Pure: the decision table, the server answer mapping, the copy rules, and source guards on the wiring.
 * Run: npx tsx features/tasks/reminder-phone-note.test.ts
 */
import { readFileSync } from "node:fs";

import {
  APP_REMINDER_COPY,
  TASK_REMINDERS_REACH_ANDROID,
  appReminderNote,
  serverDeviceFrom,
  type AppPushInputs,
  type AppReminderNote,
} from "./reminder-phone-note";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "[PASS]" : "[FAIL]"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const base: AppPushInputs = { configured: true, permission: "granted", optedIn: true, server: "registered" };
const note = (over: Partial<AppPushInputs>, reach?: boolean) => appReminderNote({ ...base, ...over }, reach);

// ── the decision table ──
check("registered phone, reminders not yet on the engine → connected, reminders in the app", note({}, false) === "connected_reminders_in_app");
check("registered phone, reminders on the engine → reminders reach the phone", note({}, true) === "connected_reminders_on_phone");
check("default: reminders do NOT reach the phone yet (no claim before the engine path exists)", TASK_REMINDERS_REACH_ANDROID === false && note({}) === "connected_reminders_in_app");
check("a build without Firebase → app without push", note({ configured: false }) === "app_without_push");
check("permission unavailable → app without push", note({ permission: "unavailable" }) === "app_without_push");
check("Android permission denied → blocked (wins over everything but the build)", note({ permission: "denied", server: "registered" }) === "blocked");
check("engine off for the business → engine_off", note({ server: "engine_off" }) === "engine_off");
check("permission never asked → not connected", note({ permission: "prompt" }) === "not_connected");
check("not opted in on this device → not connected", note({ optedIn: false }) === "not_connected");
check("server: this session has no live device → not connected, even with the opt-in", note({ server: "not_registered" }) === "not_connected");
check("server unreachable → check failed (never a 'connected' guess)", note({ server: "unknown" }) === "check_failed");
check("connected only with the SERVER's yes", (["not_registered", "engine_off", "unknown"] as const).every((sv) => !note({ server: sv }).startsWith("connected")));

// ── the server answer ──
check("200 {registered:true} → registered", serverDeviceFrom(200, { registered: true }) === "registered");
check("200 {registered:false} → not_registered", serverDeviceFrom(200, { registered: false }) === "not_registered");
check("404 → engine_off", serverDeviceFrom(404, null) === "engine_off");
check("401 / 500 / no answer / malformed → unknown", [serverDeviceFrom(401, null), serverDeviceFrom(500, null), serverDeviceFrom(null, null), serverDeviceFrom(200, { registered: "yes" })].every((x) => x === "unknown"));

// ── the copy ──
const notes = Object.keys(APP_REMINDER_COPY) as AppReminderNote[];
check("every note has a text", notes.length === 7 && notes.every((k) => APP_REMINDER_COPY[k].text.length > 10));
check("no Latin letters in the card's text", notes.every((k) => !/[A-Za-z]/.test(APP_REMINDER_COPY[k].text)), notes.filter((k) => /[A-Za-z]/.test(APP_REMINDER_COPY[k].text)));
check("only the 'reminders on the phone' note promises a phone notification", notes.filter((k) => /יגיעו גם כהתראה בטלפון/.test(APP_REMINDER_COPY[k].text)).join() === "connected_reminders_on_phone");
check("the old browser sentence is never shown inside the app", notes.every((k) => !APP_REMINDER_COPY[k].text.includes("במכשיר או בדפדפן הזה אין התראות לטלפון")));
check("every note that is not 'reminders on the phone' says where reminders DO appear", notes.filter((k) => k !== "connected_reminders_on_phone").every((k) => /בתוך דוביז ובפעמון/.test(APP_REMINDER_COPY[k].text)));

// ── wiring (source guards) ──
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const card = strip(readFileSync("features/tasks/push-card.tsx", "utf8"));
check("PushCard: inside the app → AppReminderCard, else the browser card", /insideApp\(\) \? <AppReminderCard \/> : <BrowserPushCard \/>/.test(card));
check("AppReminderCard reads the server's answer for this session (GET /api/push/devices)", card.includes('fetch("/api/push/devices"') && card.includes("serverDeviceFrom("));
check("AppReminderCard never calls the browser push check", (() => {
  const app = card.slice(card.indexOf("function AppReminderCard"), card.indexOf("export function PushCard"));
  return app.length > 0 && !/pushState\(|enablePush\(|pushSupport\(/.test(app);
})());
check("the app card never registers or asks for permission (read-only)", !/registerDevice\(|requestPushPermission\(/.test(card));
const route = strip(readFileSync("app/api/push/devices/route.ts", "utf8"));
check("GET /api/push/devices: engine gate, this session only, a yes / no", /export async function GET/.test(route) && route.includes("engineActor(req)") && route.includes("sessionFcmDeviceLive(") && /json\(\{ registered \}\)/.test(route));
const devices = strip(readFileSync("lib/notifications/engine/devices.ts", "utf8"));
const fn = devices.slice(devices.indexOf("export async function sessionFcmDeviceLive"), devices.indexOf("export async function sessionFcmDeviceLive") + 600);
check("sessionFcmDeviceLive: business + user + FCM + this session + not revoked, count only", /businessId, userId: actor\.userId, provider: "FCM", authSessionId: actor\.sessionId, revokedAt: null/.test(fn) && fn.includes(".count(") && !/endpoint/.test(fn));

console.log(`\n[reminder-phone-note] PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
