/**
 * Service Desk UI 1.3 — the first activation (decision 1, owner-approved 2026-11-19): the activity types the business
 * works with, PRE-SELECTED from its category and changeable by hand. Pure. The profile is a template only: the list
 * decides what the opening form offers first; every activity type stays open to every business (decision 2026-11-11).
 */
// The catalog itself stays in lib/services/service-desk (stage-3 rule): the server sends each profile's tracks.
export const SERVICE_TRACKS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7"] as const;
export type ServiceTrack = (typeof SERVICE_TRACKS)[number];
export const SERVICE_PROFILE_KEYS = ["general", "device_lab", "garage", "home_technician", "installer", "remote_it", "professional", "jewelry"] as const;
export type ServiceProfileKey = (typeof SERVICE_PROFILE_KEYS)[number];
export type ProfileCatalog = Record<string, readonly string[]>;

export const PROFILE_TEXT: Readonly<Record<ServiceProfileKey, { label: string; hint: string }>> = {
  general: { label: "כללי", hint: "כל סוגי השירות, בלי התאמה לתחום" },
  device_lab: { label: "מעבדת תיקונים", hint: "טלפונים, מחשבים ומכשירים שמגיעים לעסק" },
  garage: { label: "מוסך", hint: "תיקון רכב, הצעת מחיר מאושרת לפני עבודה" },
  home_technician: { label: "טכנאי בית", hint: "תיקונים אצל הלקוח: מזגנים, מוצרי חשמל, אינסטלציה" },
  installer: { label: "התקנות", hint: "התקנת מערכות וציוד אצל הלקוח" },
  remote_it: { label: "תמיכת מחשוב", hint: "תמיכה מרחוק וטיפול במחשבים" },
  professional: { label: "שירותים מקצועיים", hint: "עבודה לפי הזמנה: ניקיון, הובלות, שירות כללי" },
  jewelry: { label: "תכשיטים ושעונים", hint: "תיקון תכשיטים ושעונים שנשארים בעסק" },
};

export const TRACK_TEXT: Readonly<Record<ServiceTrack, { label: string; hint: string }>> = {
  T1: { label: "תיקון במעבדה", hint: "הפריט נשאר בעסק עד המסירה" },
  T2: { label: "תיקון רכב", hint: "הצעת מחיר מאושרת לפני כל עבודה (חובה בחוק)" },
  T3: { label: "תיקון אצל הלקוח", hint: "ביקור בכתובת של הלקוח" },
  T4: { label: "התקנה", hint: "התקנת מערכת או ציוד בכתובת" },
  T5: { label: "שירות", hint: "עבודה לפי הזמנה, בלי פריט" },
  T6: { label: "תמיכה מרחוק", hint: "טלפון או חיבור מרחוק" },
  T7: { label: "החזרה או החלפה", hint: "מוצר שנמכר וחוזר לבדיקה" },
};

export const PROFILE_ORDER: readonly ServiceProfileKey[] = SERVICE_PROFILE_KEYS;

/** The profile's own tracks (suggested first), as the server's catalog lists them. */
export function tracksOfProfile(catalog: ProfileCatalog, key: ServiceProfileKey): ServiceTrack[] {
  return (catalog[key] ?? []).filter((t): t is ServiceTrack => (SERVICE_TRACKS as readonly string[]).includes(t));
}

export type SetupDraft = { key: ServiceProfileKey; tracks: ServiceTrack[]; edited: boolean };

/** What the screen starts with: the stored choice, else the category's suggestion and that profile's tracks. */
export function initialSetup(choice: { key: string; offeredTracks: string[] | null; catalog: ProfileCatalog }): SetupDraft {
  const key = (SERVICE_PROFILE_KEYS as readonly string[]).includes(choice.key) ? (choice.key as ServiceProfileKey) : "general";
  const stored = (choice.offeredTracks ?? []).filter((t): t is ServiceTrack => (SERVICE_TRACKS as readonly string[]).includes(t));
  return { key, tracks: stored.length ? stored : tracksOfProfile(choice.catalog, key), edited: false };
}

/** Choosing another profile replaces the selection with its tracks — unless the owner already edited the list. */
export function chooseProfile(catalog: ProfileCatalog, d: SetupDraft, key: ServiceProfileKey): SetupDraft {
  return { key, tracks: d.edited ? d.tracks : tracksOfProfile(catalog, key), edited: d.edited };
}

/** Toggle one activity type; the list keeps the catalog order (T1…T7). */
export function toggleTrack(d: SetupDraft, t: ServiceTrack): SetupDraft {
  const on = d.tracks.includes(t);
  const next = on ? d.tracks.filter((x) => x !== t) : [...d.tracks, t];
  return { ...d, tracks: SERVICE_TRACKS.filter((x) => next.includes(x)), edited: true };
}

export const canSave = (d: SetupDraft) => d.tracks.length > 0;
