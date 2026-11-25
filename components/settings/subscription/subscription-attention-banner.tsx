"use client";

/**
 * The Home's subscription message (subscriptions stage C; owner decision 2026-11-25: messages only when attention or
 * action is needed). Renders NOTHING unless GET /api/business/subscription returns an attention item — the trial ends
 * within 7 days, the account is limited, or an ENFORCED quota is nearly / fully used. Testers, internal accounts and
 * businesses without a subscription never see it. No counters, no bars, no percentages. Any failure renders nothing.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";
import type { SubscriptionAttention, SubscriptionView } from "@/lib/services/subscriptions/subscription-view.service";

export function SubscriptionAttentionBanner() {
  const { t } = useI18n();
  const [item, setItem] = useState<SubscriptionAttention | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/business/subscription", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<SubscriptionView>) : null))
      .then((view) => {
        if (live && view?.visible) setItem(view.attention[0] ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!item) return null;
  const metricLabel = (metric: string) => t(`account.settings.subscriptionPage.metric.${metric}` as MessageKey);
  const text =
    item.kind === "trial_ending"
      ? item.daysLeft <= 1
        ? t("account.settings.subscriptionPage.attention.trialEndingToday")
        : t("account.settings.subscriptionPage.attention.trialEnding", { count: item.daysLeft })
      : item.kind === "limited"
        ? t("account.settings.subscriptionPage.attention.limited")
        : item.kind === "quota_reached"
          ? t("account.settings.subscriptionPage.attention.quotaReached", { label: metricLabel(item.metric) })
          : t("account.settings.subscriptionPage.attention.quotaNear", { label: metricLabel(item.metric) });

  return (
    <div className="px-4 pt-4">
      <Link
        href="/settings/subscription"
        className="flex min-h-12 items-center gap-3 rounded-2xl border border-[var(--dz-warning-border)] bg-[var(--dz-warning-bg)] px-4 py-3 text-sm leading-snug text-[var(--dz-text-primary)] no-underline"
      >
        <span className="flex-1">{text}</span>
        <span className="shrink-0 font-semibold text-[var(--dz-brand)]">{t("account.settings.subscriptionPage.attention.details")}</span>
      </Link>
    </div>
  );
}
