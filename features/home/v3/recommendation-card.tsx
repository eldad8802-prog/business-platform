"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { IconChevronLeft, IconFileLines, IconSparkle, IconWallet } from "@/components/navigation/nav-icons";
import dirStyles from "@/components/ui/directional.module.css";

import type { Load } from "./home-v3-model";
import type { RecommendationHomeView } from "./use-home-data";

const INK = "#1E2B2A";

/**
 * "Dubiz ממליץ" — the one recommendation waiting for the owner's answer, beside what else is waiting.
 * Drawn only when the feature is on for the business and something waits; the words come from the server's
 * deterministic owner view. Same shape as the insight card, warm instead of teal: it asks for a decision.
 */
export function RecommendationCard({ recommendation, wide, style }: { recommendation: Load<RecommendationHomeView | null>; wide?: boolean; style?: CSSProperties }) {
  const { t } = useI18n();
  if (recommendation.state !== "ready" || recommendation.value === null) return null;
  const v = recommendation.value;
  const payables = v.type === "SETTLE_OVERDUE_INSTALLMENT";
  const Icon = payables ? IconWallet : IconFileLines;
  const rest = v.waiting - 1;
  const more =
    rest > 0
      ? ` · ${rest === 1 ? t("home.recommendationCard.moreOne", { count: rest }) : t("home.recommendationCard.moreMany", { count: rest })}`
      : "";
  return (
    <Link
      href={v.href}
      prefetch={false}
      className="dzh-insight"
      aria-label={`${t("home.recommendationCard.aria", { what: v.what })}${more}`}
      style={{
        textDecoration: "none",
        color: INK,
        borderRadius: wide ? 22 : 20,
        padding: wide ? "20px 24px" : 16,
        background: "#FBF4EA",
        border: "1px solid #F0E3D3",
        display: "flex",
        alignItems: "center",
        gap: wide ? 20 : 14,
        minWidth: 0,
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          width: wide ? 60 : 52,
          height: wide ? 60 : 52,
          flexShrink: 0,
          borderRadius: wide ? 18 : 16,
          background: payables ? "#C2664F" : "#2B5A85",
          color: "#FFFFFF",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={wide ? 26 : 24} strokeWidth={2} />
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#815A32" }}>
          <IconSparkle size={14} strokeWidth={2} />
          {t("home.recommendationCard.eyebrow")}
        </span>
        <span style={{ fontSize: wide ? 18 : 15, fontWeight: 600, overflowWrap: "anywhere" }}>{v.what}</span>
        <span style={{ fontSize: wide ? 14 : 12, color: "#4F5C5A" }}>{v.summary}{more}</span>
      </span>
      <span aria-hidden style={{ color: "#246966", display: "flex" }}>
        <IconChevronLeft size={18} strokeWidth={2} className={dirStyles.forward} />
      </span>
    </Link>
  );
}
