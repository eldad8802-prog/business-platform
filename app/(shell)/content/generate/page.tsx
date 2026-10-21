"use client";

import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import BackButton from "@/components/ui/back-button";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey, Translator } from "@/lib/i18n/translate";

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
  contentArchetypeId?: string;
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

type StepItem = {
  id: string;
  title: MessageKey;
  description: MessageKey;
};

const NEXT_ROUTE = "/content/result";

function getGoalLabel(t: Translator, goal?: ContentFlow["goal"]) {
  switch (goal) {
    case "leads":
      return t("content.studio.generate.goals.leads");
    case "trust":
      return t("content.studio.generate.goals.trust");
    case "exposure":
      return t("content.studio.generate.goals.exposure");
    case "sales":
      return t("content.studio.generate.goals.sales");
    default:
      return t("content.studio.generate.goals.content");
  }
}

function getFormatLabel(t: Translator, format?: ContentFlow["selectedFormat"]) {
  switch (format) {
    case "reel":
      return t("content.studio.generate.formats.reel");
    case "video":
      return t("content.studio.generate.formats.video");
    case "image":
      return t("content.studio.generate.formats.image");
    case "post":
      return t("content.studio.generate.formats.post");
    default:
      return t("content.studio.generate.formats.content");
  }
}

function getPlatformLabel(t: Translator, platform?: ContentFlow["selectedPlatform"]) {
  switch (platform) {
    case "instagram":
      return "Instagram";
    case "tiktok":
      return "TikTok";
    case "facebook":
      return "Facebook";
    default:
      return t("content.studio.generate.platformFallback");
  }
}

function getStepItems(flow: ContentFlow | null): StepItem[] {
  const mode = flow?.mode || "ai";

  if (mode === "ai") {
    return [
      {
        id: "direction",
        title: "content.studio.generate.steps.direction.title",
        description: "content.studio.generate.steps.direction.description",
      },
      {
        id: "structure",
        title: "content.studio.generate.steps.structure.title",
        description: "content.studio.generate.steps.structure.description",
      },
      {
        id: "script",
        title: "content.studio.generate.steps.aiScript.title",
        description: "content.studio.generate.steps.aiScript.description",
      },
      {
        id: "finish",
        title: "content.studio.generate.steps.aiFinish.title",
        description: "content.studio.generate.steps.aiFinish.description",
      },
    ];
  }

  return [
    {
      id: "direction",
      title: "content.studio.generate.steps.direction.title",
      description: "content.studio.generate.steps.direction.description",
    },
    {
      id: "plan",
      title: "content.studio.generate.steps.plan.title",
      description: "content.studio.generate.steps.plan.description",
    },
    {
      id: "script",
      title: "content.studio.generate.steps.shootScript.title",
      description: "content.studio.generate.steps.shootScript.description",
    },
    {
      id: "finish",
      title: "content.studio.generate.steps.shootFinish.title",
      description: "content.studio.generate.steps.shootFinish.description",
    },
  ];
}

export default function GeneratePage() {
  const router = useRouter();
  const { t } = useI18n();

  const [flow, setFlow] = useState<ContentFlow | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [isReady, setIsReady] = useState(false);

  const steps = useMemo(() => getStepItems(flow), [flow]);

 useEffect(() => {
  const raw = localStorage.getItem("content_flow");

  if (!raw) {
    router.replace("/content");
    return;
  }

  try {
    const parsed: ContentFlow = JSON.parse(raw);

    if (
      !parsed.mode ||
      !parsed.goal ||
      !parsed.contentAngle ||
      !parsed.selectedDirection ||
      !parsed.selectedFormat ||
      !parsed.selectedPlatform
    ) {
      router.replace("/content/format");
      return;
    }

    setFlow(parsed);
  } catch (error) {
    console.error(error);
    router.replace("/content");
  }
}, [router]);

useEffect(() => {
  if (!flow) return;

  setActiveStep(0);
  setIsReady(false);

  const stepTimers: number[] = [];
  const token = localStorage.getItem("token");

  steps.forEach((_, index) => {
    const timer = window.setTimeout(() => {
      setActiveStep(index);
    }, index * 1200);

    stepTimers.push(timer);
  });

  async function build() {
    try {
      if (!token) {
        throw new Error("no_token");
      }

      const res = await fetch("/api/video/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(flow),
      });

      const result = await res.json();

      if (!res.ok) {
        if (result?.error === "brief_required") {
          router.replace("/content/setup");
          return;
        }
        throw new Error("Failed to build content");
      }

      localStorage.setItem("content_result", JSON.stringify(result));

      const readyTimer = window.setTimeout(() => {
        setIsReady(true);
      }, steps.length * 1200 + 300);

      stepTimers.push(readyTimer);
    } catch (err) {
      console.error(err);
      const failTimer = window.setTimeout(() => {
        router.replace("/content");
      }, 800);

      stepTimers.push(failTimer);
    }
  }

  build();

  return () => {
    stepTimers.forEach((timer) => window.clearTimeout(timer));
  };
}, [flow, steps, router]);

  function handleContinue() {
    router.push(NEXT_ROUTE);
  }

  if (!flow) {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <div style={topBarStyle}>
            <BackButton />

            <div style={topBarTitleStyle}>{t("content.studio.generate.topBarTitle")}</div>

            <div style={topBarSpacerStyle} />
          </div>

          <ProgressBar progress={92} />

          <div style={loadingWrapStyle}>
            <h1 style={loadingTitleStyle}>{t("content.studio.generate.loadingTitle")}</h1>
            <p style={loadingTextStyle}>{t("content.studio.generate.loadingText")}</p>
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

          <div style={topBarTitleStyle}>{t("content.studio.generate.topBarTitle")}</div>

          <div style={topBarSpacerStyle} />
        </div>

        <ProgressBar progress={92} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>{t("content.studio.generate.eyebrow", { step: 7 })}</div>
            <h1 style={titleStyle}>{t("content.studio.generate.title")}</h1>
            <p style={subtitleStyle}>
              {t("content.studio.generate.subtitle")}
            </p>
          </div>

          <div style={summaryCardStyle}>
            <div style={summaryTitleStyle}>{t("content.studio.generate.summaryTitle")}</div>

            <div style={summaryGridStyle}>
              <div style={summaryItemStyle}>
                <div style={summaryLabelStyle}>{t("content.studio.generate.summaryGoal")}</div>
                <div style={summaryValueStyle}>{getGoalLabel(t, flow.goal)}</div>
              </div>

              <div style={summaryItemStyle}>
                <div style={summaryLabelStyle}>{t("content.studio.generate.summaryDirection")}</div>
                <div style={summaryValueStyle}>
                  {flow.selectedDirection?.title || t("content.studio.generate.notSelected")}
                </div>
              </div>

              <div style={summaryItemStyle}>
                <div style={summaryLabelStyle}>{t("content.studio.generate.summaryFormat")}</div>
                <div style={summaryValueStyle}>
                  {getFormatLabel(t, flow.selectedFormat)}
                </div>
              </div>

              <div style={summaryItemStyle}>
                <div style={summaryLabelStyle}>{t("content.studio.generate.summaryPlatform")}</div>
                <div style={summaryValueStyle}>
                  {getPlatformLabel(t, flow.selectedPlatform)}
                </div>
              </div>
            </div>
          </div>

          <div style={stepsCardStyle}>
            <div style={stepsTitleStyle}>{t("content.studio.generate.stepsTitle")}</div>

            <div style={stepsWrapStyle}>
              {steps.map((step, index) => {
                const isDone = index < activeStep;
                const isActive = index === activeStep;
                const isPending = index > activeStep;

                return (
                  <div key={step.id} style={stepRowStyle}>
                    <div style={stepMarkerWrapStyle}>
                      <div
                        style={stepMarkerStyle({
                          isDone,
                          isActive,
                          isPending,
                        })}
                      >
                        {isDone ? "✓" : index + 1}
                      </div>

                      {index < steps.length - 1 ? (
                        <div style={stepLineStyle(isDone)} />
                      ) : null}
                    </div>

                    <div style={stepContentStyle}>
                      <div style={stepTitleStyle(isActive || isDone)}>
                        {t(step.title)}
                      </div>
                      <div style={stepDescriptionStyle}>
                        {t(step.description)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={statusCardStyle(isReady)}>
            <div style={statusTitleStyle}>
              {isReady ? t("content.studio.generate.readyTitle") : t("content.studio.generate.almostTitle")}
            </div>
            <div style={statusTextStyle}>
              {isReady
                ? t("content.studio.generate.readyText")
                : t("content.studio.generate.almostText")}
            </div>
          </div>
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            style={nextButtonStyle(isReady)}
            onClick={handleContinue}
            disabled={!isReady}
          >
            {t("content.studio.generate.next")}
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
  maxWidth: 900,
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

const summaryCardStyle: React.CSSProperties = {
  background: "var(--dz-surface)",
  padding: 18,
  borderRadius: 20,
  border: "1px solid var(--dz-border)",
  boxShadow: "0 6px 18px rgba(52, 60, 50, 0.04)",
  marginBottom: 14,
};

const summaryTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
  marginBottom: 14,
};

const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 10,
};

const summaryItemStyle: React.CSSProperties = {
  background: "var(--dz-surface-muted)",
  border: "1px solid var(--dz-border)",
  borderRadius: 14,
  padding: 12,
};

const summaryLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "var(--dz-text-muted)",
  marginBottom: 6,
};

const summaryValueStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
  lineHeight: 1.4,
};

const stepsCardStyle: React.CSSProperties = {
  background: "var(--dz-surface)",
  padding: 18,
  borderRadius: 20,
  border: "1px solid var(--dz-border)",
  boxShadow: "0 6px 18px rgba(52, 60, 50, 0.04)",
  marginBottom: 14,
};

const stepsTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
  marginBottom: 16,
};

const stepsWrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 0,
};

const stepRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
};

const stepMarkerWrapStyle: React.CSSProperties = {
  width: 28,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  flexShrink: 0,
};

const stepMarkerStyle = ({
  isDone,
  isActive,
  isPending,
}: {
  isDone: boolean;
  isActive: boolean;
  isPending: boolean;
}): React.CSSProperties => ({
  width: 28,
  height: 28,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 800,
  border: isActive || isDone ? "2px solid var(--dz-text-primary)" : "1px solid var(--dz-border-strong)",
  background: isDone ? "var(--dz-text-primary)" : isActive ? "var(--dz-surface-muted)" : "var(--dz-surface)",
  color: isDone ? "var(--dz-text-on-brand)" : isPending ? "var(--dz-text-muted)" : "var(--dz-text-primary)",
});

const stepLineStyle = (isDone: boolean): React.CSSProperties => ({
  width: 2,
  minHeight: 40,
  background: isDone ? "var(--dz-text-primary)" : "var(--dz-surface-muted)",
  marginTop: 6,
});

const stepContentStyle: React.CSSProperties = {
  paddingBottom: 18,
  paddingTop: 3,
  flex: 1,
};

const stepTitleStyle = (activeOrDone: boolean): React.CSSProperties => ({
  fontSize: 15,
  fontWeight: 800,
  color: activeOrDone ? "var(--dz-text-primary)" : "var(--dz-text-muted)",
  marginBottom: 6,
});

const stepDescriptionStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "var(--dz-text-muted)",
};

const statusCardStyle = (ready: boolean): React.CSSProperties => ({
  background: ready ? "var(--dz-success-bg-soft)" : "var(--dz-surface-muted)",
  border: ready ? "1px solid var(--dz-success-border)" : "1px solid var(--dz-border)",
  padding: 16,
  borderRadius: 18,
  marginBottom: 8,
});

const statusTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
  marginBottom: 6,
};

const statusTextStyle: React.CSSProperties = {
  fontSize: 14,
  color: "var(--dz-text-secondary)",
  lineHeight: 1.7,
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
  height: "70vh",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  flexDirection: "column",
};

const loadingTitleStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 800,
  marginBottom: 8,
};

const loadingTextStyle: React.CSSProperties = {
  color: "var(--dz-text-muted)",
};

const errorWrapStyle: React.CSSProperties = {
  padding: 20,
  color: "var(--dz-danger)",
  lineHeight: 1.7,
};
