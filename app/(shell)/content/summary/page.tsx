"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";

type ContentFlowData = {
  goal: string;
  goalDescription: string;
  intent: string;
  mode: string;
  audienceDescription: string;
  ageRange: string;
  selectedFormat?: string;
};

export default function Page() {
  const router = useRouter();
  const { t } = useI18n();
  const [flowData, setFlowData] = useState<ContentFlowData | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem("content_flow");

    if (!raw) {
      router.replace("/content");
      return;
    }

    try {
      const parsed = JSON.parse(raw) as ContentFlowData;

      if (
        !parsed.goal ||
        !parsed.goalDescription ||
        !parsed.intent ||
        !parsed.mode ||
        !parsed.audienceDescription ||
        !parsed.ageRange ||
        !parsed.selectedFormat
      ) {
        router.replace("/content");
        return;
      }

      setFlowData(parsed);
    } catch {
      router.replace("/content");
    }
  }, [router]);

  const isValid = useMemo(() => {
    return (
      !!flowData?.goal &&
      !!flowData?.goalDescription &&
      !!flowData?.intent &&
      !!flowData?.mode &&
      !!flowData?.audienceDescription &&
      !!flowData?.ageRange &&
      !!flowData?.selectedFormat
    );
  }, [flowData]);

  function handleContinue() {
    if (!isValid) return;
    router.push("/content/create");
  }

  if (!flowData) {
    return (
      <div style={baseStyles.page}>
        <Header title={t("content.studioFlow.summary.headerTitle")} />
        <ProgressBar progress={90} />

        <div style={baseStyles.container}>
          <div style={emptyCard}>{t("content.studioFlow.summary.loading")}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={baseStyles.page}>
      <Header title={t("content.studioFlow.summary.headerTitle")} />
      <ProgressBar progress={90} />

      <div style={baseStyles.container}>
        <h1 style={{ marginBottom: 8 }}>{t("content.studioFlow.summary.title")}</h1>

        <p style={{ marginBottom: 20, color: "var(--dz-text-secondary)" }}>
          {t("content.studioFlow.summary.subtitle")}
        </p>

        {card(t("content.studioFlow.summary.cards.goal"), mapGoal(t, flowData.goal))}
        {card(t("content.studioFlow.summary.cards.goalDescription"), flowData.goalDescription)}
        {card(t("content.studioFlow.summary.cards.intent"), mapIntent(t, flowData.intent))}
        {card(t("content.studioFlow.summary.cards.mode"), mapMode(t, flowData.mode))}
        {card(
          t("content.studioFlow.summary.cards.audience"),
          t("content.studioFlow.summary.audienceValue", {
            audience: flowData.audienceDescription,
            ages: flowData.ageRange,
          })
        )}
        {card(t("content.studioFlow.summary.cards.format"), mapFormat(t, flowData.selectedFormat || ""))}
      </div>

      <div style={baseStyles.footer}>
        <button
          style={{
            ...baseStyles.cta,
            opacity: isValid ? 1 : 0.5,
          }}
          onClick={handleContinue}
          disabled={!isValid}
        >
          {t("content.studioFlow.common.continue")}
        </button>
      </div>
    </div>
  );
}

function card(title: string, value: string) {
  return (
    <div style={cardStyle}>
      <div style={cardTitle}>{title}</div>
      <div style={cardValue}>{value}</div>
    </div>
  );
}

const cardStyle = {
  padding: 16,
  borderRadius: 12,
  border: "1px solid var(--dz-border)",
  marginBottom: 12,
  background: "var(--dz-surface)",
};

const cardTitle = {
  fontSize: 12,
  color: "var(--dz-text-muted)",
  marginBottom: 6,
};

const cardValue = {
  fontSize: 16,
  fontWeight: 600,
};

const emptyCard = {
  background: "var(--dz-surface-muted)",
  color: "var(--dz-text-secondary)",
  padding: 16,
  borderRadius: 12,
};

function mapGoal(t: Translator, value: string) {
  switch (value) {
    case "leads":
      return t("content.studioFlow.summary.goals.leads");
    case "trust":
      return t("content.studioFlow.summary.goals.trust");
    case "exposure":
      return t("content.studioFlow.summary.goals.exposure");
    case "sales":
      return t("content.studioFlow.summary.goals.sales");
    default:
      return value;
  }
}

function mapIntent(t: Translator, value: string) {
  switch (value) {
    case "message":
      return t("content.studioFlow.summary.intents.message");
    case "follow":
      return t("content.studioFlow.summary.intents.follow");
    case "watch":
      return t("content.studioFlow.summary.intents.watch");
    case "sale":
      return t("content.studioFlow.summary.intents.sale");
    default:
      return value;
  }
}

function mapMode(t: Translator, value: string) {
  switch (value) {
    case "camera":
      return t("content.studioFlow.summary.modes.camera");
    case "voice":
      return t("content.studioFlow.summary.modes.voice");
    case "ai":
      return t("content.studioFlow.summary.modes.ai");
    default:
      return value;
  }
}

function mapFormat(t: Translator, value: string) {
  switch (value) {
    case "reel":
      return t("content.studioFlow.options.format.reel");
    case "video":
      return t("content.studioFlow.options.format.video");
    case "image":
      return t("content.studioFlow.options.format.image");
    case "post":
      return t("content.studioFlow.options.format.post");
    default:
      return value;
  }
}