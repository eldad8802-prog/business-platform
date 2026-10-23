"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";

type ContentFlowData = {
  mode: string;
  selectedFormat: "reel" | "video" | "image" | "post";
  videoType?: {
    label: string;
  };
  assetsPlan?: {
    requiredAssets: string[];
    optionalAssets: string[];
    guidance: string;
  };
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

      if (!parsed.selectedFormat || !parsed.assetsPlan) {
        router.replace("/content");
        return;
      }

      setFlowData(parsed);
    } catch {
      router.replace("/content");
    }
  }, [router]);

  function handleContinue() {
    router.push("/content/generate");
  }

  if (!flowData) {
    return (
      <div style={baseStyles.page}>
        <Header title={t("content.studioFlow.assets.headerTitle")} />
        <ProgressBar progress={100} />

        <div style={baseStyles.container}>
          <div style={emptyCard}>{t("content.studioFlow.assets.loading")}</div>
        </div>
      </div>
    );
  }

  const isAI = flowData.mode === "ai";
  const assetsPlan = flowData.assetsPlan;
  const requiredAssets = assetsPlan?.requiredAssets ?? [];
  const optionalAssets = assetsPlan?.optionalAssets ?? [];
  const guidance = assetsPlan?.guidance ?? "";

  return (
    <div style={baseStyles.page}>
      <Header title={t("content.studioFlow.assets.headerTitle")} />
      <ProgressBar progress={100} />

      <div style={baseStyles.container}>
        <h1 style={{ marginBottom: 8 }}>{t("content.studioFlow.assets.title")}</h1>

        <div style={card}>
          <h2 style={h2}>{t("content.studioFlow.create.format")}</h2>
          <div style={value}>{mapFormat(t, flowData.selectedFormat)}</div>
        </div>

        {flowData.videoType ? (
          <div style={card}>
            <h2 style={h2}>{t("content.studioFlow.assets.leadDirection")}</h2>
            <div style={value}>{flowData.videoType.label}</div>
          </div>
        ) : null}

        {!isAI ? (
          <div style={card}>
            <h2 style={h2}>{t("content.studioFlow.create.assets")}</h2>

            {requiredAssets.map((item, idx) => (
              <div key={idx} style={instruction}>
                • {item}
              </div>
            ))}
          </div>
        ) : null}

        {!isAI && optionalAssets.length > 0 ? (
          <div style={card}>
            <h2 style={h2}>{t("content.studioFlow.create.optional")}</h2>

            {optionalAssets.map((item, idx) => (
              <div key={idx} style={instruction}>
                • {item}
              </div>
            ))}
          </div>
        ) : null}

        {isAI ? (
          <div style={card}>
            <h2 style={h2}>{t("content.studioFlow.assets.autoTitle")}</h2>
            <p style={{ color: "var(--dz-text-secondary)" }}>
              {t("content.studioFlow.assets.autoText")}
            </p>
          </div>
        ) : null}

        {guidance ? (
          <div style={card}>
            <h2 style={h2}>{t("content.studioFlow.assets.guidance")}</h2>
            <p style={{ color: "var(--dz-text-secondary)" }}>{guidance}</p>
          </div>
        ) : null}
      </div>

      <div style={baseStyles.footer}>
        <button style={baseStyles.cta} onClick={handleContinue}>
          {t("content.studioFlow.assets.cta")}
        </button>
      </div>
    </div>
  );
}

function mapFormat(t: Translator, value: string) {
  if (value === "reel") return t("content.studioFlow.options.format.reel");
  if (value === "video") return t("content.studioFlow.options.format.video");
  if (value === "image") return t("content.studioFlow.options.format.image");
  return t("content.studioFlow.options.format.post");
}

const card = {
  background: "var(--dz-surface)",
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
  border: "1px solid var(--dz-border-subtle)",
};

const h2 = {
  marginBottom: 8,
};

const value = {
  fontSize: 16,
  fontWeight: 600,
};

const instruction = {
  marginBottom: 6,
};

const emptyCard = {
  background: "var(--dz-surface-muted)",
  color: "var(--dz-text-secondary)",
  padding: 16,
  borderRadius: 12,
};
