"use client";

import { useI18n } from "@/components/i18n/I18nProvider";

type Props = {
  appVersion: string;
};

export function SettingsSystemFooter({ appVersion }: Props) {
  const { t } = useI18n();
  return (
    <footer className="mt-8 border-t border-[var(--dz-border-subtle)] pt-5">
      <p className="text-center text-xs text-[var(--dz-text-muted)]">
        {t("account.settings.footer.version")}{" "}
        <span className="font-mono font-medium text-[var(--dz-text-secondary)]">{appVersion}</span>
      </p>
    </footer>
  );
}
