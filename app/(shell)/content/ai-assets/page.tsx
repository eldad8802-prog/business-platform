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

type ContentResult = {
  contentRunId?: number | null;
  selectedVariant?: {
    script?: {
      scriptText?: string;
      caption?: string;
      shots?: { visual: string; voice: string }[];
    };
  };
};

type Step = {
  label: MessageKey;
  description: MessageKey;
};

const steps: Step[] = [
  {
    label: "content.studioFlow.aiAssets.steps.visuals.label",
    description: "content.studioFlow.aiAssets.steps.visuals.description",
  },
  {
    label: "content.studioFlow.aiAssets.steps.layers.label",
    description: "content.studioFlow.aiAssets.steps.layers.description",
  },
  {
    label: "content.studioFlow.aiAssets.steps.assemble.label",
    description: "content.studioFlow.aiAssets.steps.assemble.description",
  },
];

function getPlatformLabel(t: Translator, platform?: ContentFlow["selectedPlatform"]) {
  switch (platform) {
    case "instagram":
      return "Instagram";
    case "tiktok":
      return "TikTok";
    case "facebook":
      return "Facebook";
    default:
      return t("content.studioFlow.common.platform");
  }
}

/**
 * Content APIs use `getCurrentUser`: Authorization must be `Bearer <numeric user id>`
 * (same string as returned from `/api/auth/login`).
 */
function readAuthBearerUserId(): string | null {
  if (typeof window === "undefined") return null;
  let raw = localStorage.getItem("token");
  if (raw == null) return null;
  raw = raw.trim();
  if (!raw) return null;
  if (/^bearer\s+/i.test(raw)) {
    raw = raw.replace(/^bearer\s+/i, "").trim();
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  return raw;
}

export default function AiAssetsPage() {
  const router = useRouter();
  const { t } = useI18n();

  const [flow, setFlow] = useState<ContentFlow | null>(null);
  const [result, setResult] = useState<ContentResult | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [generatedCount, setGeneratedCount] = useState(0);
  // A dictionary key (resolved at render, so the effects never depend on the translator).
  const [error, setError] = useState<MessageKey | "">("");

  const hasValidPayload = useMemo(() => {
    return Boolean(
      flow &&
        result &&
        flow.mode === "ai" &&
        flow.selectedFormat &&
        flow.selectedPlatform &&
        result.selectedVariant?.script?.scriptText &&
        (result.selectedVariant?.script?.shots?.length ?? 0) > 0
    );
  }, [flow, result]);

  useEffect(() => {
    const flowRaw = localStorage.getItem("content_flow");
    const resultRaw = localStorage.getItem("content_result");

    if (!flowRaw || !resultRaw) {
      router.replace("/content");
      return;
    }

    try {
      const parsedFlow = JSON.parse(flowRaw) as ContentFlow;
      const parsedResult = JSON.parse(resultRaw) as ContentResult;

      if (parsedFlow.mode !== "ai") {
        router.replace("/content/creator-plan");
        return;
      }

      if (
        !parsedFlow.goal ||
        !parsedFlow.contentAngle ||
        !parsedFlow.selectedDirection ||
        !parsedFlow.selectedFormat ||
        !parsedFlow.selectedPlatform
      ) {
        router.replace("/content/creator-plan");
        return;
      }

      setFlow(parsedFlow);
      setResult(parsedResult);
    } catch (err) {
      console.error(err);
      router.replace("/content");
    }
  }, [router]);

  useEffect(() => {
    if (!hasValidPayload || !flow || !result) return;

    let cancelled = false;
    const stepTimers: number[] = [];
    let redirectTimer: number | null = null;

    async function startGeneration() {
      try {
        setError("");
        setIsReady(false);
        setActiveStep(0);
        setGeneratedCount(0);

        const sessionUserId = readAuthBearerUserId();
        if (!sessionUserId) {
          setError("content.studioFlow.aiAssets.errors.signIn");
          router.replace("/login");
          return;
        }

        steps.forEach((_, index) => {
          const timer = window.setTimeout(() => {
            if (!cancelled) {
              setActiveStep(Math.min(index, steps.length - 1));
            }
          }, index * 900);

          stepTimers.push(timer);
        });

        const contentRunId = result?.contentRunId;
        const res = await fetch("/api/content/ai-assets", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionUserId}`,
          },
          body: JSON.stringify({
            flow,
            result,
            ...(typeof contentRunId === "number" && contentRunId > 0
              ? { contentRunId }
              : {}),
          }),
        });

        const data = await res.json();

        if (res.status === 401) {
          if (!cancelled) {
            setError("content.studioFlow.aiAssets.errors.sessionExpired");
            try {
              localStorage.removeItem("token");
              localStorage.removeItem("user");
            } catch {
              /* ignore */
            }
            router.replace("/login");
          }
          return;
        }

        if (!res.ok) {
          throw new Error(data?.error || "failed_to_generate_ai_assets");
        }

        if (cancelled) return;

        const assets = (data?.assets || {}) as Record<string, string>;
        const count = Object.keys(assets).length;

        if (!count) {
          setError("content.studioFlow.aiAssets.errors.noAssets");
          return;
        }

        localStorage.setItem("content_ai_assets", JSON.stringify(assets));
        setGeneratedCount(count);
        setIsReady(true);

        redirectTimer = window.setTimeout(() => {
          if (!cancelled) {
            router.push("/content/render");
          }
        }, 900);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError("content.studioFlow.aiAssets.errors.failed");
        }
      }
    }

    void startGeneration();

    return () => {
      cancelled = true;
      stepTimers.forEach((timer) => window.clearTimeout(timer));
      if (redirectTimer) {
        window.clearTimeout(redirectTimer);
      }
    };
  }, [flow, result, hasValidPayload, router]);

  // Show error when gate passed but payload is missing (e.g. no scriptText)
  useEffect(() => {
    if (!flow || !result) return;
    if (hasValidPayload) return;
    setError("content.studioFlow.aiAssets.errors.missingPayload");
  }, [flow, result, hasValidPayload]);

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <BackButton />

          <div style={topBarTitleStyle}>{t("content.studioFlow.aiAssets.topBar")}</div>

          <div style={topBarSpacerStyle} />
        </div>

        <ProgressBar progress={82} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>{t("content.studioFlow.common.now")}</div>
            <h1 style={titleStyle}>{t("content.studioFlow.aiAssets.title")}</h1>
            <p style={subtitleStyle}>
              {t("content.studioFlow.aiAssets.subtitle")}
            </p>
          </div>

          {flow ? (
            <div style={summaryCardStyle}>
              <div style={summaryValueStyle}>
                {flow.selectedDirection?.title ?? t("content.studioFlow.common.chosenDirection")}
              </div>
              <div style={summaryPlatformStyle}>
                {getPlatformLabel(t, flow.selectedPlatform)}
              </div>
            </div>
          ) : null}

          {error ? (
            <div style={errorBoxStyle}>
              <div style={errorTitleStyle}>{t("content.studioFlow.common.stuckTitle")}</div>
              <div style={errorTextStyle}>{t(error)}</div>
              <button
                type="button"
                onClick={() => router.replace("/content/creator-plan")}
                style={errorBackButtonStyle}
              >
                {t("content.studioFlow.aiAssets.backToDirection")}
              </button>
            </div>
          ) : (
            <div style={stepsCardStyle}>
              <div style={stepsTitleStyle}>{t("content.studioFlow.aiAssets.stepsTitle")}</div>

              <div style={stepsWrapStyle}>
                {steps.map((step, index) => {
                  const isDone = isReady ? index < steps.length : index < activeStep;
                  const isCurrent = !isReady && index === activeStep;

                  return (
                    <div key={step.label} style={stepRowStyle}>
                      <div style={stepMarkerWrapStyle}>
                        <div
                          style={stepMarkerStyle({
                            isDone,
                            isCurrent,
                          })}
                        >
                          {isDone ? "✓" : index + 1}
                        </div>

                        {index < steps.length - 1 ? (
                          <div style={stepLineStyle(isDone)} />
                        ) : null}
                      </div>

                      <div style={stepContentStyle}>
                        <div style={stepTitleStyle(isDone || isCurrent)}>
                          {t(step.label)}
                        </div>
                        <div style={stepDescriptionStyle}>
                          {t(step.description)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={statusBoxStyle(isReady)}>
                <div style={statusTitleStyle}>
                  {isReady ? t("content.studioFlow.aiAssets.readyTitle") : t("content.studioFlow.common.oneMoment")}
                </div>
                <div style={statusTextStyle}>
                  {isReady
                    ? t(
                        generatedCount === 1
                          ? "content.studioFlow.aiAssets.readyTextOne"
                          : "content.studioFlow.aiAssets.readyText",
                        { count: generatedCount }
                      )
                    : t("content.studioFlow.aiAssets.workingText")}
                </div>
              </div>
            </div>
          )}
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
  maxWidth: 640,
};

const summaryCardStyle: React.CSSProperties = {
  background: "var(--dz-surface)",
  borderRadius: 18,
  padding: 16,
  border: "1px solid var(--dz-border)",
  boxShadow: "0 4px 14px rgba(52, 60, 50, 0.04)",
  marginBottom: 14,
};

const summaryValueStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
  marginBottom: 4,
};

const summaryPlatformStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--dz-text-muted)",
};

const stepsCardStyle: React.CSSProperties = {
  background: "var(--dz-surface)",
  borderRadius: 18,
  padding: 16,
  border: "1px solid var(--dz-border)",
  boxShadow: "0 4px 14px rgba(52, 60, 50, 0.04)",
};

const stepsTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
  marginBottom: 14,
};

const stepsWrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
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
  isCurrent,
}: {
  isDone: boolean;
  isCurrent: boolean;
}): React.CSSProperties => ({
  width: 28,
  height: 28,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 800,
  border: isDone || isCurrent ? "2px solid var(--dz-text-primary)" : "1px solid var(--dz-border-strong)",
  background: isDone ? "var(--dz-text-primary)" : isCurrent ? "var(--dz-surface-muted)" : "var(--dz-surface)",
  color: isDone ? "var(--dz-text-on-brand)" : "var(--dz-text-primary)",
});

const stepLineStyle = (done: boolean): React.CSSProperties => ({
  width: 2,
  minHeight: 40,
  background: done ? "var(--dz-text-primary)" : "var(--dz-surface-muted)",
  marginTop: 6,
});

const stepContentStyle: React.CSSProperties = {
  paddingTop: 2,
  paddingBottom: 18,
  flex: 1,
};

const stepTitleStyle = (active: boolean): React.CSSProperties => ({
  fontSize: 15,
  fontWeight: 800,
  color: active ? "var(--dz-text-primary)" : "var(--dz-text-muted)",
  marginBottom: 4,
});

const stepDescriptionStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "var(--dz-text-muted)",
};

const statusBoxStyle = (ready: boolean): React.CSSProperties => ({
  marginTop: 8,
  background: ready ? "var(--dz-success-bg-soft)" : "var(--dz-surface-muted)",
  border: ready ? "1px solid var(--dz-success-border)" : "1px solid var(--dz-border)",
  borderRadius: 14,
  padding: 12,
});

const statusTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
  marginBottom: 4,
};

const statusTextStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "var(--dz-text-secondary)",
  wordBreak: "break-word",
};

const errorBoxStyle: React.CSSProperties = {
  background: "var(--dz-danger-bg)",
  border: "1px solid var(--dz-danger-border)",
  color: "var(--dz-danger)",
  borderRadius: 14,
  padding: 12,
};

const errorTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  marginBottom: 4,
};

const errorTextStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
};

const errorBackButtonStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 12,
  height: 40,
  paddingInline: 20,
  borderRadius: 12,
  border: "none",
  background: TOKEN.action.primary.background,
  color: "var(--dz-text-on-brand)",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};
