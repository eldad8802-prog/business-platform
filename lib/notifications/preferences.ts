/**
 * Notification preferences — the PURE resolver and the request validation (notifications track spec, 2026-11-12).
 *
 *   effective(user, category) = catalog defaults ← domain override ← category override ← settings
 *
 * Only overrides are stored (NotificationSettings: every column NULL = the default here; NotificationPreference:
 * one row per `domain:<d>` / `category:<c>`, NULL = no override for that aspect). Aspects a category does not let
 * the user change (security: in-app) always take the catalog value, whatever is stored. A category whose platform
 * feature is not available to the business is INACTIVE (not sent, reported unavailable) — its stored overrides are
 * kept untouched. Unknown categories: in-app only, never push.
 *
 * Pure: no database, no clock.
 */
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DOMAINS,
  getCategory,
  type CategoryDefinition,
  type DeliveryMode,
} from "./catalog";

export type StoredSettings = {
  pushEnabled: boolean | null;
  quietHoursEnabled: boolean | null;
  quietStartMinute: number | null;
  quietEndMinute: number | null;
  digestEnabled: boolean | null;
  digestMinute: number | null;
  lockScreenDetails: boolean | null;
  /** Minutes before an appointment for its reminder: one of APPOINTMENT_REMINDER_CHOICES; NULL = the default. */
  appointmentReminderMinutes: number | null;
};

export type StoredPreference = { key: string; inApp: boolean | null; push: boolean | null; delivery: string | null };

export type EffectiveSettings = {
  pushEnabled: boolean;
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  digestEnabled: boolean;
  digestMinute: number;
  lockScreenDetails: boolean;
  appointmentReminderMinutes: number;
};

/**
 * The appointment reminder lead times a user may choose (migration 20261213090000 CHECKs the same four): 30 minutes,
 * an hour, two hours, or 1440 = the same local time the day before (business time zone, DST-safe).
 */
export const APPOINTMENT_REMINDER_CHOICES = [30, 60, 120, 1440] as const;
export type AppointmentReminderMinutes = (typeof APPOINTMENT_REMINDER_CHOICES)[number];
export const DEFAULT_APPOINTMENT_REMINDER_MINUTES: AppointmentReminderMinutes = 60;

export function isAppointmentReminderMinutes(v: unknown): v is AppointmentReminderMinutes {
  return typeof v === "number" && (APPOINTMENT_REMINDER_CHOICES as readonly number[]).includes(v);
}

/** The product defaults (every NULL column means this). Quiet hours match the policy's 22:00–07:00. */
export const DEFAULT_SETTINGS: EffectiveSettings = {
  pushEnabled: true,
  quietHoursEnabled: true,
  quietStartMinute: 22 * 60,
  quietEndMinute: 7 * 60,
  digestEnabled: true,
  digestMinute: 8 * 60,
  lockScreenDetails: false,
  appointmentReminderMinutes: DEFAULT_APPOINTMENT_REMINDER_MINUTES,
};

export const SETTINGS_FIELDS = [
  "pushEnabled",
  "quietHoursEnabled",
  "quietStartMinute",
  "quietEndMinute",
  "digestEnabled",
  "digestMinute",
  "lockScreenDetails",
  "appointmentReminderMinutes",
] as const satisfies readonly (keyof EffectiveSettings)[];

const MINUTE_FIELDS = new Set<string>(["quietStartMinute", "quietEndMinute", "digestMinute"]);

export const EMPTY_SETTINGS: StoredSettings = {
  pushEnabled: null,
  quietHoursEnabled: null,
  quietStartMinute: null,
  quietEndMinute: null,
  digestEnabled: null,
  digestMinute: null,
  lockScreenDetails: null,
  appointmentReminderMinutes: null,
};

export function effectiveSettings(stored: StoredSettings | null): EffectiveSettings {
  const s = stored ?? EMPTY_SETTINGS;
  return {
    pushEnabled: s.pushEnabled ?? DEFAULT_SETTINGS.pushEnabled,
    quietHoursEnabled: s.quietHoursEnabled ?? DEFAULT_SETTINGS.quietHoursEnabled,
    quietStartMinute: s.quietStartMinute ?? DEFAULT_SETTINGS.quietStartMinute,
    quietEndMinute: s.quietEndMinute ?? DEFAULT_SETTINGS.quietEndMinute,
    digestEnabled: s.digestEnabled ?? DEFAULT_SETTINGS.digestEnabled,
    digestMinute: s.digestMinute ?? DEFAULT_SETTINGS.digestMinute,
    lockScreenDetails: s.lockScreenDetails ?? DEFAULT_SETTINGS.lockScreenDetails,
    // A stored value outside the choices (impossible under the CHECK) reads as the default, never as a wrong lead.
    appointmentReminderMinutes: isAppointmentReminderMinutes(s.appointmentReminderMinutes)
      ? s.appointmentReminderMinutes
      : DEFAULT_SETTINGS.appointmentReminderMinutes,
  };
}

export type EffectiveCategory = {
  key: string;
  domain: string;
  /** The platform feature is available to the business (or the category needs none). */
  available: boolean;
  inApp: boolean;
  /** Push for this category, after the master switch (settings.pushEnabled). */
  push: boolean;
  delivery: DeliveryMode;
  quietBypass: boolean;
  rateExempt: boolean;
  mutable: CategoryDefinition["userMutable"];
};

export const domainPreferenceKey = (domain: string) => `domain:${domain}`;
export const categoryPreferenceKey = (key: string) => `category:${key}`;

function deliveryOf(v: string | null | undefined): DeliveryMode | null {
  return v === "instant" || v === "digest" ? v : null;
}

/**
 * The effective value of one category for one user. `cat` null = UNKNOWN category: in-app only, never push.
 * `featureAvailable` false = inactive (in-app and push false, `available` false) — overrides untouched.
 */
export function resolveCategory(
  cat: CategoryDefinition | null,
  settings: EffectiveSettings,
  prefs: readonly StoredPreference[],
  featureAvailable: boolean,
): EffectiveCategory {
  if (!cat) {
    return {
      key: "unknown",
      domain: "unknown",
      available: true,
      inApp: true,
      push: false,
      delivery: "instant",
      quietBypass: false,
      rateExempt: false,
      mutable: { inApp: false, push: false, delivery: false },
    };
  }
  let inApp = cat.defaults.inApp;
  let push = cat.defaults.push;
  let delivery: DeliveryMode = cat.defaults.delivery;
  for (const key of [domainPreferenceKey(cat.domain), categoryPreferenceKey(cat.key)]) {
    const p = prefs.find((x) => x.key === key);
    if (!p) continue;
    if (cat.userMutable.inApp && p.inApp !== null) inApp = p.inApp;
    if (cat.userMutable.push && p.push !== null) push = p.push;
    const d = deliveryOf(p.delivery);
    if (cat.userMutable.delivery && d !== null) delivery = d;
  }
  if (!settings.pushEnabled) push = false;
  return {
    key: cat.key,
    domain: cat.domain,
    available: featureAvailable,
    inApp: featureAvailable && inApp,
    push: featureAvailable && push,
    delivery,
    quietBypass: cat.quietBypass,
    rateExempt: cat.rateExempt,
    mutable: cat.userMutable,
  };
}

/** Every catalog category, resolved for one user (the GET settings answer). */
export function resolveAll(
  settings: EffectiveSettings,
  prefs: readonly StoredPreference[],
  isAvailable: (cat: CategoryDefinition) => boolean,
): EffectiveCategory[] {
  return NOTIFICATION_CATEGORIES.map((cat) => resolveCategory(cat, settings, prefs, isAvailable(cat)));
}

/**
 * Categories the user turned OFF in-app (by a stored override) — the read side hides them. Feature availability
 * deliberately plays no part here: the bell keeps showing what it showed before the engine existed.
 */
export function hiddenInAppCategories(settings: EffectiveSettings, prefs: readonly StoredPreference[]): string[] {
  if (prefs.length === 0) return [];
  return NOTIFICATION_CATEGORIES.filter((cat) => !resolveCategory(cat, settings, prefs, true).inApp).map((c) => c.key);
}

/* ──────────────────────────────────────────────────────── request validation ── */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * PATCH settings body: a subset of the eight fields, each a value or null (= back to the default). Unknown keys,
 * wrong types, out-of-range minutes and a lead time outside APPOINTMENT_REMINDER_CHOICES are refused; an empty patch
 * is refused.
 */
export function validateSettingsPatch(body: unknown): ValidationResult<Partial<StoredSettings>> {
  if (!isPlainObject(body)) return { ok: false, error: "INVALID_BODY" };
  const keys = Object.keys(body);
  if (keys.length === 0) return { ok: false, error: "EMPTY_PATCH" };
  const out: Partial<StoredSettings> = {};
  for (const k of keys) {
    if (!(SETTINGS_FIELDS as readonly string[]).includes(k)) return { ok: false, error: "UNKNOWN_FIELD" };
    const v = body[k];
    if (v === null) {
      (out as Record<string, unknown>)[k] = null;
      continue;
    }
    if (k === "appointmentReminderMinutes") {
      if (!isAppointmentReminderMinutes(v)) return { ok: false, error: "INVALID_LEAD_TIME" };
    } else if (MINUTE_FIELDS.has(k)) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1439) return { ok: false, error: "INVALID_MINUTE" };
    } else if (typeof v !== "boolean") {
      return { ok: false, error: "INVALID_VALUE" };
    }
    (out as Record<string, unknown>)[k] = v;
  }
  return { ok: true, value: out };
}

/** `domain:<known domain>` or `category:<known category>` — nothing else is a preference key. */
export function validatePreferenceKey(raw: unknown): ValidationResult<{ key: string; categories: CategoryDefinition[] }> {
  if (typeof raw !== "string" || raw.length > 80) return { ok: false, error: "UNKNOWN_KEY" };
  const m = /^(domain|category):([a-z0-9_.]{1,64})$/.exec(raw);
  if (!m) return { ok: false, error: "UNKNOWN_KEY" };
  if (m[1] === "domain") {
    if (!NOTIFICATION_DOMAINS.includes(m[2])) return { ok: false, error: "UNKNOWN_KEY" };
    return { ok: true, value: { key: raw, categories: NOTIFICATION_CATEGORIES.filter((c) => c.domain === m[2]) } };
  }
  const cat = getCategory(m[2]);
  if (!cat) return { ok: false, error: "UNKNOWN_KEY" };
  return { ok: true, value: { key: raw, categories: [cat] } };
}

export type PreferenceBody = { inApp: boolean | null; push: boolean | null; delivery: DeliveryMode | null };

/**
 * PUT override body: { inApp?, push?, delivery? } — each a value or null; at least one present; unknown fields
 * refused. An aspect NO category under the key lets the user change is refused (NOT_MUTABLE); for a domain key the
 * aspect is stored and applies to the categories that allow it (the resolver enforces mutability per category).
 */
export function validatePreferenceBody(
  body: unknown,
  categories: readonly CategoryDefinition[],
): ValidationResult<PreferenceBody> {
  if (!isPlainObject(body)) return { ok: false, error: "INVALID_BODY" };
  const keys = Object.keys(body);
  if (keys.length === 0) return { ok: false, error: "EMPTY_PATCH" };
  const out: PreferenceBody = { inApp: null, push: null, delivery: null };
  for (const k of keys) {
    const v = body[k];
    if (k === "inApp" || k === "push") {
      if (v !== null && typeof v !== "boolean") return { ok: false, error: "INVALID_VALUE" };
      if (v !== null && !categories.some((c) => c.userMutable[k])) return { ok: false, error: "NOT_MUTABLE" };
      out[k] = v as boolean | null;
    } else if (k === "delivery") {
      if (v !== null && v !== "instant" && v !== "digest") return { ok: false, error: "INVALID_VALUE" };
      if (v !== null && !categories.some((c) => c.userMutable.delivery)) return { ok: false, error: "NOT_MUTABLE" };
      out.delivery = v as DeliveryMode | null;
    } else {
      return { ok: false, error: "UNKNOWN_FIELD" };
    }
  }
  return { ok: true, value: out };
}
