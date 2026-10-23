"use client";

import { useI18n } from "@/components/i18n/I18nProvider";
import { WarmPill } from "@/components/ui/warm-surface/warm-surface";

/**
 * "בקרוב" — the one marker for a connection that is not open yet (Meta: WhatsApp Business,
 * Facebook / Instagram; the Tax Authority). The existing sand pill the settings hub already uses
 * for "בקרוב", so every such button reads the same way. The constant stays the Hebrew text; the pill
 * itself follows the interface language.
 */
export const COMING_SOON_LABEL = "בקרוב";

export function ComingSoonPill({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <WarmPill tone="sand" className={className}>
      {t("home.ui.comingSoon")}
    </WarmPill>
  );
}
