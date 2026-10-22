"use client";

import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import BackButton from "@/components/ui/back-button";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";

type ContentFlow = {
  mode?: "ai" | "camera" | "voice";
  goal?: "leads" | "trust" | "exposure" | "sales";
  audienceTypes?: string[];
  contentAngle?:
    | "show_result"
    | "explain"
    | "show_difference"
    | "attention"
    | "trust"
    | "cta";
  contentGoalPrompt?: string;
  selectedDirection?: {
    id?: string;
    title?: string;
    description?: string;
    whyItFits?: string;
    type?: string;
    strategy?: string;
    tone?: string;
    pace?: string;
    recommendedFormat?: "reel" | "video" | "image" | "post";
    score?: number;
  };
  selectedFormat?: "reel" | "video" | "image" | "post";
  selectedPlatform?: "instagram" | "tiktok" | "facebook";
};

type FormatOption = {
  id: "reel" | "video" | "image" | "post";
  title: MessageKey;
  description: MessageKey;
};

type PlatformOption = {
  id: "instagram" | "tiktok" | "facebook";
  /** Brand name — not translated. */
  title: string;
  description: MessageKey;
};

const formatOptions: FormatOption[] = [
  {
    id: "reel",
    title: "content.studioFlow.options.format.reel",
    description: "content.studioFlow.format.formats.reel",
  },
  {
    id: "video",
    title: "content.studioFlow.options.format.video",
    description: "content.studioFlow.format.formats.video",
  },
  {
    id: "image",
    title: "content.studioFlow.options.format.image",
    description: "content.studioFlow.format.formats.image",
  },
  {
    id: "post",
    title: "content.studioFlow.options.format.post",
    description: "content.studioFlow.format.formats.post",
  },
];

const platformOptions: PlatformOption[] = [
  {
    id: "instagram",
    title: "Instagram",
    description: "content.studioFlow.format.platforms.instagram",
  },
  {
    id: "tiktok",
    title: "TikTok",
    description: "content.studioFlow.format.platforms.tiktok",
  },
  {
    id: "facebook",
    title: "Facebook",
    description: "content.studioFlow.format.platforms.facebook",
  },
];

function getRecommendedPlatform(
  goal?: ContentFlow["goal"],
  contentAngle?: ContentFlow["contentAngle"]
): "instagram" | "tiktok" | "facebook" {
  if (goal === "exposure" && contentAngle === "attention") {
    return "tiktok";
  }

  if (
    goal === "trust" &&
    (contentAngle === "explain" || contentAngle === "trust")
  ) {
    return "facebook";
  }

  return "instagram";
}

export default function ContentFormatPage() {
  const router = useRouter();
  const { t } = useI18n();

  const [flow, setFlow] = useState<ContentFlow | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<
    "reel" | "video" | "image" | "post" | ""
  >("");
  const [selectedPlatform, setSelectedPlatform] = useState<
    "instagram" | "tiktok" | "facebook" | ""
  >("");
  const [error, setError] = useState("");

  useEffect(() => {
    const raw = localStorage.getItem("content_flow");

    if (!raw) {
      router.replace("/content");
      return;
    }

    try {
      const parsed: ContentFlow = JSON.parse(raw);

      if (
        !parsed.goal ||
        !parsed.mode ||
        !parsed.contentAngle ||
        !parsed.selectedDirection
      ) {
        router.replace("/content/direction");
        return;
      }

      const recommendedFormat =
        parsed.selectedFormat ||
        parsed.selectedDirection.recommendedFormat ||
        "reel";

      const recommendedPlatform =
        parsed.selectedPlatform ||
        getRecommendedPlatform(parsed.goal, parsed.contentAngle);

      setFlow(parsed);
      setSelectedFormat(recommendedFormat);
      setSelectedPlatform(recommendedPlatform);
    } catch (err) {
      console.error(err);
      router.replace("/content");
    }
  }, [router]);

  const canContinue = useMemo(() => {
    return Boolean(selectedFormat && selectedPlatform);
  }, [selectedFormat, selectedPlatform]);

  function handleContinue() {
    if (!flow || !selectedFormat || !selectedPlatform) {
      setError(t("content.studioFlow.format.missingChoice"));
      return;
    }

    const raw = localStorage.getItem("content_flow");
    let latest: ContentFlow = {};
    if (raw) {
      try {
        latest = JSON.parse(raw) as ContentFlow;
      } catch {
        latest = {};
      }
    }

    /** מיזוג על snapshot עדכני מ־localStorage כדי לא לדרוס `contentGoalPrompt` / תובנות בטעות בגלל state ישן */
    const updatedFlow: ContentFlow = {
      ...flow,
      ...latest,
      selectedFormat,
      selectedPlatform,
    };

    localStorage.setItem("content_flow", JSON.stringify(updatedFlow));

    router.push("/content/creator-plan");
  }

  if (!flow) {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <div style={topBarStyle}>
            <BackButton />

            <div style={topBarTitleStyle}>{t("content.studioFlow.format.topBar")}</div>

            <div style={topBarSpacerStyle} />
          </div>

          <ProgressBar progress={62} />

          <div style={loadingWrapStyle}>
            <h1 style={loadingTitleStyle}>{t("content.studioFlow.common.oneMoment")}</h1>
            <p style={loadingTextStyle}>
              {t("content.studioFlow.format.loadingText")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <BackButton />

          <div style={topBarTitleStyle}>{t("content.studioFlow.format.topBar")}</div>

          <div style={topBarSpacerStyle} />
        </div>

        <ProgressBar progress={62} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>{t("content.studioFlow.common.now")}</div>
            <h1 style={titleStyle}>{t("content.studioFlow.format.title")}</h1>
            <p style={subtitleStyle}>
              {t("content.studioFlow.format.subtitle")}
            </p>
          </div>

          <div style={sectionCardStyle}>
            <div style={sectionTitleStyle}>{t("content.studioFlow.format.formatTitle")}</div>
            <div style={sectionSubtitleStyle}>
              {t("content.studioFlow.format.formatSubtitle")}
            </div>

            <div style={cardsWrapStyle}>
              {formatOptions.map((option) => {
                const isSelected = selectedFormat === option.id;
                const isRecommended =
                  flow.selectedDirection?.recommendedFormat === option.id;

                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setSelectedFormat(option.id);
                      if (error) setError("");
                    }}
                    style={optionCardStyle(isSelected)}
                  >
                    <div style={optionTopRowStyle}>
                      <div style={optionTitleStyle}>{t(option.title)}</div>
                      {isRecommended ? (
                        <div style={recommendedBadgeStyle}>{t("content.studioFlow.format.recommended")}</div>
                      ) : null}
                    </div>

                    <div style={optionDescriptionStyle}>
                      {t(option.description)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={sectionCardStyle}>
            <div style={sectionTitleStyle}>{t("content.studioFlow.format.platformTitle")}</div>
            <div style={sectionSubtitleStyle}>
              {t("content.studioFlow.format.platformSubtitle")}
            </div>

            <div style={cardsWrapStyle}>
              {platformOptions.map((option) => {
                const isSelected = selectedPlatform === option.id;
                const isRecommended =
                  getRecommendedPlatform(flow.goal, flow.contentAngle) ===
                  option.id;

                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setSelectedPlatform(option.id);
                      if (error) setError("");
                    }}
                    style={optionCardStyle(isSelected)}
                  >
                    <div style={optionTopRowStyle}>
                      <div style={optionTitleStyle}>{option.title}</div>
                      {isRecommended ? (
                        <div style={recommendedBadgeStyle}>{t("content.studioFlow.format.recommended")}</div>
                      ) : null}
                    </div>

                    <div style={optionDescriptionStyle}>
                      {t(option.description)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {error ? <div style={errorBoxStyle}>{error}</div> : null}
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            style={nextButtonStyle(canContinue)}
            onClick={handleContinue}
            disabled={!canContinue}
          >
            {t("content.studioFlow.format.cta")}
          </button>
        </div>
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  ...baseStyles.page,
  background:
    "linear-gradient(180deg, var(--dz-surface-muted) 0%, var(--dz-surface-flat) 35%, var(--dz-surface-muted) 100%)",
};

const shellStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 880,
  margin: "0 auto",
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
};

const topBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 16px 8px 16px",
};

const topBarTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
};

const topBarSpacerStyle: React.CSSProperties = {
  width: 68,
};

const contentAreaStyle: React.CSSProperties = {
  ...baseStyles.container,
  flex: 1,
  width: "100%",
};

const introWrapStyle: React.CSSProperties = {
  marginBottom: 24,
};

const eyebrowStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 800,
  color: "var(--dz-success)",
  background: "var(--dz-success-bg-soft)",
  border: "1px solid var(--dz-success-border)",
  borderRadius: 999,
  padding: "6px 10px",
  marginBottom: 12,
};

const titleStyle: React.CSSProperties = {
  fontSize: 30,
  fontWeight: 800,
  lineHeight: 1.15,
  color: "var(--dz-text-primary)",
  margin: 0,
  marginBottom: 10,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 15,
  color: "var(--dz-text-muted)",
  lineHeight: 1.7,
  margin: 0,
  maxWidth: 620,
};

const sectionCardStyle: React.CSSProperties = {
  background: "var(--dz-surface)",
  borderRadius: 20,
  padding: 18,
  border: "1px solid var(--dz-border)",
  boxShadow: "0 6px 18px rgba(52, 60, 50, 0.04)",
  marginBottom: 14,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
  marginBottom: 6,
};

const sectionSubtitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--dz-text-muted)",
  lineHeight: 1.6,
  marginBottom: 14,
};

const cardsWrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const optionCardStyle = (selected: boolean): React.CSSProperties => ({
  width: "100%",
  textAlign: "start",
  background: selected
    ? "linear-gradient(180deg, var(--dz-surface-flat) 0%, var(--dz-surface-muted) 100%)"
    : "var(--dz-surface)",
  border: selected ? "2px solid var(--dz-text-primary)" : "1px solid var(--dz-border)",
  borderRadius: 18,
  padding: 18,
  cursor: "pointer",
  boxShadow: selected
    ? "0 10px 24px rgba(52, 60, 50, 0.1)"
    : "0 4px 12px rgba(52, 60, 50, 0.03)",
});

const optionTopRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 8,
};

const optionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
};

const optionDescriptionStyle: React.CSSProperties = {
  fontSize: 14,
  color: "var(--dz-text-secondary)",
  lineHeight: 1.7,
};

const recommendedBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: "var(--dz-success)",
  background: "var(--dz-success-bg-soft)",
  border: "1px solid var(--dz-success-border)",
  borderRadius: 999,
  padding: "4px 8px",
  flexShrink: 0,
};

const errorBoxStyle: React.CSSProperties = {
  background: "var(--dz-danger-bg)",
  border: "1px solid var(--dz-danger-border)",
  color: "var(--dz-danger)",
  borderRadius: 14,
  padding: 12,
  fontSize: 13,
  lineHeight: 1.6,
  marginTop: 6,
};

const footerStyle: React.CSSProperties = {
  position: "sticky",
  bottom: 0,
  zIndex: 20,
  background: "rgba(255,255,255,0.92)",
  backdropFilter: "blur(10px)",
  borderTop: "1px solid var(--dz-border)",
  padding: "12px 16px calc(12px + env(safe-area-inset-bottom)) 16px",
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
};

const nextButtonStyle = (enabled: boolean): React.CSSProperties => ({
  minWidth: 132,
  height: 48,
  borderRadius: 14,
  border: "none",
  background: enabled ? TOKEN.action.primary.background : "var(--dz-action-disabled-bg)",
  color: "var(--dz-text-on-brand)",
  fontSize: 15,
  fontWeight: 800,
  cursor: enabled ? "pointer" : "not-allowed",
  boxShadow: enabled ? TOKEN.action.primary.shadow : "none",
});

const loadingWrapStyle: React.CSSProperties = {
  minHeight: "70vh",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "center",
};

const loadingTitleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 800,
  marginBottom: 8,
};

const loadingTextStyle: React.CSSProperties = {
  color: "var(--dz-text-muted)",
};
