"use client";

/**
 * Client-side i18n context. Mounted once by the root layout with the request's locale; only that
 * locale's dictionary reaches the browser:
 *   - Hebrew (the default) is bundled here, so a Hebrew page carries no dictionary at all;
 *   - English lives in its own code-split chunk (./EnglishI18nProvider, loaded with next/dynamic only
 *     when the locale is English) — a static, content-hashed, immutable-cached JS file, never a prop
 *     serialized into the HTML / RSC payload of every page. It still renders on the server, so the
 *     HTML is English from the first byte and hydration matches.
 *
 * Outside a provider (isolated component tests, stories) `useI18n()` returns Hebrew — the same
 * output the component produced before i18n existed.
 */
import dynamic from "next/dynamic";
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

import { DEFAULT_LOCALE, localeDirection, type Locale, type TextDirection } from "@/lib/i18n/config";
import { formatAmount, formatDate, formatMoney, type FormatContext } from "@/lib/i18n/format";
import { he } from "@/lib/i18n/messages/he";
import type { Messages } from "@/lib/i18n/messages/types";
import { createTranslator, type Translator } from "@/lib/i18n/translate";

export type I18nValue = {
  readonly locale: Locale;
  readonly dir: TextDirection;
  readonly t: Translator;
  readonly fmt: FormatContext;
  readonly formatAmount: (
    amount: Parameters<typeof formatAmount>[0],
    currency: string,
    opts?: Parameters<typeof formatAmount>[3]
  ) => string;
  readonly formatMoney: (value: Parameters<typeof formatMoney>[0], opts?: Parameters<typeof formatMoney>[2]) => string;
  readonly formatDate: (value: Parameters<typeof formatDate>[0], style?: Parameters<typeof formatDate>[2]) => string;
};

export function buildI18nValue(locale: Locale, messages: Messages): I18nValue {
  const fmt: FormatContext = { locale };
  return {
    locale,
    dir: localeDirection(locale),
    t: createTranslator(messages),
    fmt,
    formatAmount: (amount, currency, opts) => formatAmount(amount, currency, fmt, opts),
    formatMoney: (value, opts) => formatMoney(value, fmt, opts),
    formatDate: (value, style) => formatDate(value, fmt, style),
  };
}

// Hebrew is imported directly (not via the registry) so the client bundle never pulls in other languages.
const FALLBACK = buildI18nValue(DEFAULT_LOCALE, he);
export const I18nContext = createContext<I18nValue>(FALLBACK);

// English: a separate client chunk, requested only when an English page renders it (SSR included).
const EnglishI18nProvider = dynamic(() => import("./EnglishI18nProvider"));
// Every non-default language must name its own chunk here (the type lists any that is missing).
const LAZY_PROVIDERS: Readonly<Record<Exclude<Locale, "he">, ComponentType<{ children: ReactNode }>>> = {
  en: EnglishI18nProvider,
};

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  if (locale === "he") return <I18nContext.Provider value={FALLBACK}>{children}</I18nContext.Provider>;
  const Provider = LAZY_PROVIDERS[locale];
  return <Provider>{children}</Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
