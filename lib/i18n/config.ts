/**
 * i18n configuration — the languages Dubiz's interface speaks, and how each one is laid out.
 *
 * Four settings are deliberately SEPARATE and never derived from one another:
 *   - interface language (this file: "he" | "en")   — strings + text direction
 *   - region                                         — number / date conventions ("IL")
 *   - time zone                                      — civil-day boundaries ("Asia/Jerusalem")
 *   - base / display currency (lib/money)            — what money means
 * Switching the language never changes the region, the time zone, or any amount.
 *
 * Adding a language = add it to LOCALES + LOCALE_META and add a dictionary that satisfies the
 * `Messages` type (the compiler then lists every missing key).
 */

export const LOCALES = ["he", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export type TextDirection = "rtl" | "ltr";

/** Every existing business and user is Hebrew; this stays the default. */
export const DEFAULT_LOCALE: Locale = "he";
export const DEFAULT_REGION = "IL";
export const DEFAULT_TIME_ZONE = "Asia/Jerusalem";

/** The cookie that carries the interface language between requests (1 year, not httpOnly-bound). */
export const LOCALE_COOKIE = "dz_locale";
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const LOCALE_META: Readonly<Record<Locale, { dir: TextDirection; nativeName: string }>> = {
  he: { dir: "rtl", nativeName: "עברית" },
  en: { dir: "ltr", nativeName: "English" },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Unknown / missing → the default; never throws (a bad cookie must not break a page). */
export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function localeDirection(locale: Locale): TextDirection {
  return LOCALE_META[locale].dir;
}

export function localeNativeName(locale: Locale): string {
  return LOCALE_META[locale].nativeName;
}

/** BCP-47 tag for Intl: language from the interface, region from the business ("en" + "IL" → "en-IL"). */
export function intlTag(locale: Locale, region: string = DEFAULT_REGION): string {
  return `${locale}-${region}`;
}

/**
 * The language switch is released behind a server flag. While it is off, every request renders the
 * default locale WITHOUT reading the cookie — byte-identical to the pre-i18n app, and pages that
 * were statically rendered stay static.
 */
export function isI18nEnabled(): boolean {
  return process.env.DUBIZ_I18N_ENABLED === "true";
}
