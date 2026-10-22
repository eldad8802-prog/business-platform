"use client";

/**
 * Client-side i18n context. Mounted once by the root layout with the request's locale and ONLY that
 * locale's dictionary (the other languages are never shipped to the browser).
 *
 * Outside a provider (isolated component tests, stories) `useI18n()` returns Hebrew — the same
 * output the component produced before i18n existed.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

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

function build(locale: Locale, messages: Messages): I18nValue {
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
const FALLBACK = build(DEFAULT_LOCALE, he);
const I18nContext = createContext<I18nValue>(FALLBACK);

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: ReactNode;
}) {
  const value = useMemo(() => build(locale, messages), [locale, messages]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
