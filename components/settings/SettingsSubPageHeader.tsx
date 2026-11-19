"use client";

import { useI18n } from "@/components/i18n/I18nProvider";
import BackButton from "@/components/ui/back-button";

type Props = {
  title: string;
  subtitle?: string;
  backHref?: string;
};

export function SettingsSubPageHeader({
  title,
  subtitle,
  backHref = "/settings",
}: Props) {
  const { t } = useI18n();
  return (
    <header className="mb-5 rounded-3xl dz-mist px-4 py-4 shadow-sm">
      {/* A title that fits on one line beside the back control stays exactly where it was. Only a title that would
          have been cut moves to its own row below the back control, where it may take two lines (owner 2026-11-15).
          The flex basis is the title's own one-line width (the subtitle is kept out of it by contain:inline-size). */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <BackButton fallback={backHref} />

        <div className="min-w-0 flex-[1_1_auto] text-center">
          <h1 className="line-clamp-2 text-balance break-words text-base font-bold leading-snug text-[var(--dz-text-primary)]" data-testid="settings-subpage-title">{title}</h1>
          {subtitle ? (
            <p className="mt-1 text-xs text-[var(--dz-text-muted)] [contain:inline-size]">{subtitle}</p>
          ) : (
            <p className="mt-1 text-xs text-[var(--dz-text-muted)] [contain:inline-size]">{t("account.settings.subHeader.defaultSubtitle")}</p>
          )}
        </div>

        <div className="h-11 min-w-[44px]" aria-hidden />
      </div>
    </header>
  );
}
