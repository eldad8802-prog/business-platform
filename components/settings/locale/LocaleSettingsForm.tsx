"use client";

/**
 * "שפה, אזור ומטבע" — the language / region / currency settings body.
 *
 * What is live:
 *  - Interface language: switches the cookie through POST /api/preferences/locale and reloads, so the
 *    server re-renders every screen (and <html dir>) in the chosen language. No data changes.
 * What is shown but not yet changeable (each says why, nothing is a dead control):
 *  - Region / time zone — read-only; a language switch never touches them.
 *  - Base currency — ILS for every business until the per-business setting exists; changing it for
 *    a business with financial history is a separate, controlled process (never a silent switch).
 *  - Display currency — follows the base currency until rates + the persisted setting exist.
 */
import { useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { DEFAULT_TIME_ZONE, LOCALES, localeNativeName, type Locale } from "@/lib/i18n/config";
import { currencySymbol, DEFAULT_BASE_CURRENCY, SUPPORTED_CURRENCIES } from "@/lib/money/currency";

export function LocaleSettingsForm({ languageSwitchEnabled }: { languageSwitchEnabled: boolean }) {
  const { t, locale } = useI18n();
  const [pending, setPending] = useState<Locale | null>(null);
  const [failed, setFailed] = useState(false);

  async function choose(next: Locale) {
    if (next === locale || pending) return;
    setPending(next);
    setFailed(false);
    try {
      const res = await fetch("/api/preferences/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // A full reload: server components, <html lang/dir> and every client island re-render together.
      window.location.reload();
    } catch {
      setPending(null);
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection title={t("settingsLocale.languageSection")} description={t("settingsLocale.languageHelp")}>
        <div role="radiogroup" aria-label={t("settingsLocale.languageSection")} className="flex flex-wrap gap-2">
          {LOCALES.map((l) => {
            const selected = l === locale;
            return (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={selected}
                lang={l}
                disabled={!languageSwitchEnabled || pending !== null}
                onClick={() => choose(l)}
                className="min-h-11 rounded-full border px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed"
                style={{
                  borderColor: selected ? "var(--dz-brand, #246966)" : "var(--dz-border-subtle)",
                  background: selected ? "var(--dz-brand-soft, #E3F2F0)" : "transparent",
                  color: "var(--dz-text-primary)",
                  opacity: !languageSwitchEnabled && !selected ? 0.55 : 1,
                }}
              >
                {pending === l ? t("common.saving") : localeNativeName(l)}
              </button>
            );
          })}
        </div>
        {!languageSwitchEnabled ? (
          <p className="mt-2 text-xs text-[var(--dz-text-muted)]">{t("settingsLocale.comingSoon")}</p>
        ) : null}
        {failed ? (
          <p role="alert" className="mt-2 text-xs text-[var(--dz-danger, #C24A33)]">
            {t("common.errorGeneric")}
          </p>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t("settingsLocale.regionSection")} description={t("settingsLocale.regionHelp")}>
        <ReadOnlyRow label={t("settingsLocale.regionLabel")} value={t("settingsLocale.regionValueIL")} />
        <ReadOnlyRow label={t("settingsLocale.timeZoneLabel")} value={DEFAULT_TIME_ZONE} ltr />
      </SettingsSection>

      <SettingsSection
        title={t("settingsLocale.baseCurrencySection")}
        description={t("settingsLocale.baseCurrencyHelp")}
      >
        <CurrencyChoices selected={DEFAULT_BASE_CURRENCY} />
        <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">{t("settingsLocale.baseCurrencyLocked")}</p>
      </SettingsSection>

      <SettingsSection
        title={t("settingsLocale.displayCurrencySection")}
        description={t("settingsLocale.displayCurrencyHelp")}
      >
        <ReadOnlyRow
          label={t("settingsLocale.displayCurrencySection")}
          value={t("settingsLocale.displayFollowsBase")}
        />
        <p className="mt-2 text-xs text-[var(--dz-text-muted)]">{t("settingsLocale.comingSoon")}</p>
      </SettingsSection>
    </div>
  );
}

function CurrencyChoices({ selected }: { selected: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col divide-y divide-[var(--dz-border-subtle)]">
      {SUPPORTED_CURRENCIES.map((code) => (
        <div key={code} className="flex items-center justify-between gap-3 py-2" aria-current={code === selected}>
          <span className="text-sm text-[var(--dz-text-primary)]">
            <span aria-hidden className="inline-block w-6 text-center">
              {currencySymbol(code)}
            </span>{" "}
            {t(`currency.${code}`)} — <span dir="ltr">{code}</span>
          </span>
          {code === selected ? (
            <span className="text-xs font-semibold text-[var(--dz-brand, #246966)]">✓</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ReadOnlyRow({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-xs font-semibold text-[var(--dz-text-muted)]">{label}</span>
      <span dir={ltr ? "ltr" : undefined} className="text-sm font-medium text-[var(--dz-text-primary)]">
        {value}
      </span>
    </div>
  );
}
