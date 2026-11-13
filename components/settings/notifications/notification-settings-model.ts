/**
 * Notification settings screen — the PURE view model (owner-approved design, Gate B 2026-11-13).
 *
 * Everything the screens show or send is decided here, from the backend's own pure modules, so what the screen
 * says can never drift from what the engine does:
 *
 *   - which types are listed: catalog categories (lib/notifications/catalog.ts), minus the ones in
 *     HIDDEN_CATEGORIES (each with the reason it is not a user choice today);
 *   - each type's three choices, from the preference resolver (lib/notifications/preferences.ts):
 *       "בתוך דוביז"     = inApp
 *       "בטלפון"         = push, sent at once           (push && delivery === "instant")
 *       "בסיכום היומי"   = delivery "digest"            (the worker suppresses the instant push "to_digest" and the
 *                                                         digest counts it only while inApp is on — so the screen
 *                                                         shows it only together with "בתוך דוביז")
 *   - the body sent for a choice (PUT /api/notifications/settings/preferences/category:<key>) always carries every
 *     aspect the category lets the user change, and null for the others (the backend refuses a value for an aspect
 *     that is not changeable, and a PUT replaces the whole row);
 *   - the device card's state, from what the native / browser clients report;
 *   - the test button's answer, from the test route's status and counts.
 *
 * No React, no fetch, no clock.
 */
import { NOTIFICATION_CATEGORIES, getCategory, type CategoryDefinition } from "@/lib/notifications/catalog";
import {
  APPOINTMENT_REMINDER_CHOICES,
  categoryPreferenceKey,
  resolveCategory,
  type AppointmentReminderMinutes,
  type EffectiveSettings,
  type PreferenceBody,
  type StoredPreference,
} from "@/lib/notifications/preferences";
import type { NotificationKey } from "./copy/notification-copy-core";

/* ─────────────────────────────────────────────────────────── the wire ── */

/** GET / PATCH /api/notifications/settings — the fields this screen reads. */
export type SettingsView = {
  settings: EffectiveSettings;
  timeZone?: string;
  categories: { key: string; available: boolean }[];
  overrides: StoredPreference[];
};

/* ───────────────────────────────────────────────── which types are listed ── */

/** Catalog categories that are deliberately NOT a choice on the types screen, and why. */
export const HIDDEN_CATEGORIES: Readonly<Record<string, string>> = {
  "security.new_device": "no producer exists today (nothing writes it) and there is no security email — not promised",
  "digest.daily": "the daily summary itself — controlled by the daily-summary switch, not a type",
  "system.test": "the test notification — the test button, not a type",
};

/** The order the types screen groups domains in (the approved design's order, then the remaining domains). */
export const DOMAIN_ORDER = [
  "tasks",
  "appointments",
  "inbox",
  "leads",
  "inventory",
  "suppliers",
  "billing",
  "payments",
  "obligations",
  "documents",
  "accountant",
  "connections",
] as const;

export const DOMAIN_LABEL_KEYS: Readonly<Record<(typeof DOMAIN_ORDER)[number], NotificationKey>> = {
  tasks: "notifications.types.domains.tasks",
  appointments: "notifications.types.domains.appointments",
  inbox: "notifications.types.domains.inbox",
  leads: "notifications.types.domains.leads",
  inventory: "notifications.types.domains.inventory",
  suppliers: "notifications.types.domains.suppliers",
  billing: "notifications.types.domains.billing",
  payments: "notifications.types.domains.payments",
  obligations: "notifications.types.domains.obligations",
  documents: "notifications.types.domains.documents",
  accountant: "notifications.types.domains.accountant",
  connections: "notifications.types.domains.connections",
};

export const CATEGORY_LABEL_KEYS: Readonly<Record<string, NotificationKey>> = {
  "tasks.reminder": "notifications.types.categories.tasksReminder",
  "booking.request_waiting": "notifications.types.categories.bookingRequestWaiting",
  "inbox.customer_waiting": "notifications.types.categories.inboxCustomerWaiting",
  "leads.follow_up": "notifications.types.categories.leadsFollowUp",
  "inventory.critical_stock": "notifications.types.categories.inventoryCriticalStock",
  "inventory.attention": "notifications.types.categories.inventoryAttention",
  "suppliers.purchase_pending": "notifications.types.categories.suppliersPurchasePending",
  "billing.failure": "notifications.types.categories.billingFailure",
  "billing.review": "notifications.types.categories.billingReview",
  "documents.review": "notifications.types.categories.documentsReview",
  "accountant.send_failed": "notifications.types.categories.accountantSendFailed",
  "accountant.month_close": "notifications.types.categories.accountantMonthClose",
  "connections.disconnected": "notifications.types.categories.connectionsDisconnected",
  "connections.account_disconnected": "notifications.types.categories.accountDisconnected",
  "obligations.due": "notifications.types.categories.obligationsDue",
  "payments.request_failed": "notifications.types.categories.paymentsRequestFailed",
  "billing.allocation_failed": "notifications.types.categories.billingAllocationFailed",
  "documents.processing_failed": "notifications.types.categories.documentsProcessingFailed",
  "appointments.upcoming": "notifications.types.categories.appointmentsUpcoming",
};

/** Every catalog category the types screen lists (catalog order). */
export function visibleCategories(): CategoryDefinition[] {
  return NOTIFICATION_CATEGORIES.filter((c) => !(c.key in HIDDEN_CATEGORIES));
}

/* ───────────────────────────────────────────────────── a type's choices ── */

export type Choice = "inApp" | "phone" | "digest";
export const CHOICES: readonly Choice[] = ["inApp", "phone", "digest"];

export type ChoiceView = {
  /** Shown at all (the category lets the user change this aspect). */
  shown: boolean;
  pressed: boolean;
  /** Shown but not usable right now (master switch off, summary off, type unavailable…). */
  disabled: boolean;
};

export type CategoryRow = {
  key: string;
  domain: string;
  labelKey: NotificationKey;
  available: boolean;
  quietBypass: boolean;
  choices: Record<Choice, ChoiceView>;
};

/** The user's own choice for a category, independent of the master switch (resolved with push on). */
function ownChoice(cat: CategoryDefinition, settings: EffectiveSettings, overrides: readonly StoredPreference[]) {
  return resolveCategory(cat, { ...settings, pushEnabled: true }, overrides, true);
}

export function categoryRow(
  cat: CategoryDefinition,
  settings: EffectiveSettings,
  overrides: readonly StoredPreference[],
  available: boolean,
): CategoryRow {
  const own = ownChoice(cat, settings, overrides);
  const m = cat.userMutable;
  const off = !available;
  return {
    key: cat.key,
    domain: cat.domain,
    labelKey: CATEGORY_LABEL_KEYS[cat.key],
    available,
    quietBypass: cat.quietBypass,
    choices: {
      inApp: { shown: true, pressed: own.inApp, disabled: off || !m.inApp },
      phone: {
        shown: m.push,
        pressed: own.push && own.delivery === "instant",
        disabled: off || !m.push || !settings.pushEnabled,
      },
      digest: {
        shown: m.delivery,
        pressed: own.delivery === "digest" && own.inApp,
        disabled: off || !m.delivery || !settings.digestEnabled || !own.inApp,
      },
    },
  };
}

export type DomainGroup = { domain: string; labelKey: NotificationKey; rows: CategoryRow[] };

export function buildTypeGroups(view: SettingsView): DomainGroup[] {
  const availability = new Map(view.categories.map((c) => [c.key, c.available]));
  const cats = visibleCategories();
  const domains = [...DOMAIN_ORDER, ...[...new Set(cats.map((c) => c.domain))].filter((d) => !(DOMAIN_ORDER as readonly string[]).includes(d))];
  return domains
    .map((domain) => ({
      domain,
      labelKey: DOMAIN_LABEL_KEYS[domain as keyof typeof DOMAIN_LABEL_KEYS],
      rows: cats
        .filter((c) => c.domain === domain)
        .map((c) => categoryRow(c, view.settings, view.overrides, availability.get(c.key) === true)),
    }))
    .filter((g) => g.rows.length > 0);
}

/**
 * The full override body for one tap. Every changeable aspect gets an explicit value (the row is replaced), every
 * other aspect null. Rules (see the header): phone on ⇒ instant; summary on ⇒ no instant phone; "בתוך דוביז" off ⇒
 * no summary (the summary only counts what is shown inside Dubiz).
 */
export function preferenceBodyFor(
  cat: CategoryDefinition,
  settings: EffectiveSettings,
  overrides: readonly StoredPreference[],
  choice: Choice,
  value: boolean,
): PreferenceBody {
  const own = ownChoice(cat, settings, overrides);
  let inApp = own.inApp;
  let push = own.push;
  let delivery = own.delivery;
  if (choice === "inApp") {
    inApp = value;
    if (!value && delivery === "digest") delivery = "instant";
  } else if (choice === "phone") {
    push = value;
    if (value) delivery = "instant";
  } else {
    delivery = value ? "digest" : "instant";
    if (value) {
      push = false;
      inApp = true;
    }
  }
  const m = cat.userMutable;
  return {
    inApp: m.inApp ? inApp : null,
    push: m.push ? push : null,
    delivery: m.delivery ? delivery : null,
  };
}

/** The overrides list after a successful (or optimistic) PUT of `body` for `cat`. */
export function withCategoryOverride(
  overrides: readonly StoredPreference[],
  cat: CategoryDefinition,
  body: PreferenceBody,
): StoredPreference[] {
  const key = categoryPreferenceKey(cat.key);
  const rest = overrides.filter((p) => p.key !== key);
  if (body.inApp === null && body.push === null && body.delivery === null) return rest;
  return [...rest, { key, inApp: body.inApp, push: body.push, delivery: body.delivery }];
}

export function preferenceUrl(catKey: string): string {
  const cat = getCategory(catKey);
  if (!cat) throw new Error("unknown category");
  return `/api/notifications/settings/preferences/${encodeURIComponent(categoryPreferenceKey(cat.key))}`;
}

/* ─────────────────────────────────────────────────── the settings fields ── */

/** Every settings field a control on these screens writes (PATCH /api/notifications/settings). */
export const SETTINGS_CONTROLS = {
  phoneSwitch: "pushEnabled",
  digestSwitch: "digestEnabled",
  digestTime: "digestMinute",
  quietSwitch: "quietHoursEnabled",
  quietFrom: "quietStartMinute",
  quietTo: "quietEndMinute",
  lockScreenDetails: "lockScreenDetails",
  appointmentLead: "appointmentReminderMinutes",
} as const satisfies Record<string, keyof EffectiveSettings>;

/* ───────────────────────────────────────────── the appointment reminder lead ── */

/** The four lead-time choices (the backend's APPOINTMENT_REMINDER_CHOICES, in that order) and their labels. */
export const APPOINTMENT_LEAD_LABEL_KEYS: Readonly<Record<AppointmentReminderMinutes, MessageKey>> = {
  30: "notifications.types.appointmentLead.m30",
  60: "notifications.types.appointmentLead.h1",
  120: "notifications.types.appointmentLead.h2",
  1440: "notifications.types.appointmentLead.day",
};

export type AppointmentLeadView = {
  /** Shown only when the appointment reminder is available to the business (the appointments feature is on). */
  shown: boolean;
  options: { minutes: AppointmentReminderMinutes; labelKey: MessageKey; pressed: boolean }[];
};

/** The lead-time choice in the appointments area: the user's effective value (default 60) pressed. */
export function appointmentLeadView(view: SettingsView): AppointmentLeadView {
  const shown = view.categories.some((c) => c.key === "appointments.upcoming" && c.available);
  const current = view.settings.appointmentReminderMinutes;
  return {
    shown,
    options: APPOINTMENT_REMINDER_CHOICES.map((minutes) => ({ minutes, labelKey: APPOINTMENT_LEAD_LABEL_KEYS[minutes], pressed: minutes === current })),
  };
}

export function minuteToTime(m: number): string {
  const v = Math.max(0, Math.min(1439, Math.floor(m)));
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

/** "HH:MM" (an <input type="time"> value) → minute of the day, or null when not a complete valid time. */
export function timeToMinute(t: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/* ──────────────────────────────────────────────────────── the device card ── */

export type NativePermission = "granted" | "denied" | "prompt" | "unavailable";

export type DeviceInputs =
  | { kind: "native"; configured: boolean; permission: NativePermission; optedIn: boolean; askedThisVisit: boolean; registration: "idle" | "connecting" | "connected" | "failed" }
  /** Inside the Dubiz Android app, but a build without the push plugin. */
  | { kind: "app-without-push" }
  | { kind: "browser"; browserPush: "on" | "off" | "denied" | "unavailable" };

export type DeviceState =
  | "native-not-configured"
  | "native-ask"
  | "native-ask-again"
  | "native-denied"
  | "native-connecting"
  | "native-connected"
  | "native-connect-failed"
  | "app-not-configured"
  | "browser-app-only"
  | "browser-on"
  | "browser-off"
  | "browser-blocked";

/**
 * The device card. Native: no Firebase in the build ⇒ never offer enabling; "prompt" before any tap ⇒ ask (the
 * system dialog only after the tap); "prompt" after a refusal in this visit (Android's prompt-with-rationale) ⇒ a
 * one-line reason and ask again; "denied" (Android shows no dialog any more) ⇒ phone settings instructions;
 * granted but never turned on here (Android 12 and older grant silently) ⇒ ask (no dialog will appear, the tap
 * just connects). Browser: phone notifications are the Android app's; the browser option only when it works.
 */
export function deviceState(i: DeviceInputs): DeviceState {
  if (i.kind === "app-without-push") return "app-not-configured";
  if (i.kind === "browser") {
    if (i.browserPush === "on") return "browser-on";
    if (i.browserPush === "off") return "browser-off";
    if (i.browserPush === "denied") return "browser-blocked";
    return "browser-app-only";
  }
  if (!i.configured || i.permission === "unavailable") return "native-not-configured";
  if (i.permission === "denied") return "native-denied";
  if (i.permission === "prompt") return i.askedThisVisit ? "native-ask-again" : "native-ask";
  if (!i.optedIn) return "native-ask";
  if (i.registration === "connecting") return "native-connecting";
  if (i.registration === "failed") return "native-connect-failed";
  return "native-connected";
}

/* ─────────────────────────────────────────────────────────── the test button ── */

export type TestOutcome = "sent" | "no_device" | "rate_limited" | "failed" | "offline";

export const TEST_MESSAGE_KEYS: Readonly<Record<TestOutcome, NotificationKey>> = {
  sent: "notifications.phone.testSent",
  no_device: "notifications.phone.testNoDevice",
  rate_limited: "notifications.phone.testRateLimited",
  failed: "notifications.phone.testFailed",
  offline: "notifications.phone.testOffline",
};

/** POST /api/notifications/test → what to tell the person. `status` null = the request never got an answer. */
export function testOutcome(status: number | null, body: unknown): TestOutcome {
  if (status === null) return "offline";
  if (status === 429) return "rate_limited";
  if (status < 200 || status >= 300) return "failed";
  const b = (body ?? {}) as { sent?: unknown; failed?: unknown; retrying?: unknown };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (n(b.sent) > 0) return "sent";
  if (n(b.failed) > 0 || n(b.retrying) > 0) return "failed";
  return "no_device";
}

/* ─────────────────────────────────────────────────────────── the page state ── */

export type LoadOutcome = "ready" | "unavailable" | "error";

/** GET answer → page state. 404 = the notifications engine is not on for this business: a calm "not yet". */
export function loadOutcome(status: number | null): LoadOutcome {
  if (status === 404) return "unavailable";
  if (status !== null && status >= 200 && status < 300) return "ready";
  return "error";
}
