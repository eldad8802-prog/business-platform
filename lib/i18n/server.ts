/**
 * Server-side locale resolution (Server Components, Route Handlers, Server Actions).
 *
 * Order: the `dz_locale` cookie → the default. (The persisted per-user preference joins this chain
 * once the schema column exists — see docs/i18n-multicurrency/ARCHITECTURE.md §B.3; the login flow
 * will then re-issue the cookie from the stored preference.)
 *
 * While the release flag is off this never touches `cookies()`, so no route becomes dynamic.
 */
import { cookies } from "next/headers";

import { isI18nEnabled, LOCALE_COOKIE, localeDirection, resolveLocale, DEFAULT_LOCALE, type Locale } from "./config";
import { getMessages } from "./messages";
import { createTranslator, type Translator } from "./translate";

export async function getRequestLocale(): Promise<Locale> {
  if (!isI18nEnabled()) return DEFAULT_LOCALE;
  const store = await cookies();
  return resolveLocale(store.get(LOCALE_COOKIE)?.value);
}

export async function getServerI18n(): Promise<{ locale: Locale; dir: "rtl" | "ltr"; t: Translator }> {
  const locale = await getRequestLocale();
  return { locale, dir: localeDirection(locale), t: createTranslator(getMessages(locale)) };
}
