"use client";

import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import BackButton from "@/components/ui/back-button";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey, Translator } from "@/lib/i18n/translate";

function isTerminalRenderSuccess(status: unknown, url: unknown): boolean {
  const s = typeof status === "string" ? status.toLowerCase() : "";
  if (s !== "succeeded" && s !== "completed") return false;
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

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
  selectedVariant?: {
    id?: string;
    title?: string;
    description?: string;
    whyItFits?: string;
    score?: number;
    tone?: string;
    pace?: string;
    videoType?: "SHORT" | "MID" | "FULL";
    durationSeconds?: number;
    structure?: string[];
    script?: {
      title?: string;
      hook?: string;
      scriptText?: string;
      caption?: string;
      shots?: { visual: string; voice: string }[];
    };
    shotRequests?: {
      index: number;
      purpose: string;
      visualPrompt: string;
      shootingGuidance: string;
    }[];
    assetsPlan?: {
      requiredAssets: string[];
      optionalAssets: string[];
    };
  };
};

type Step = {
  label: MessageKey;
  description: MessageKey;
};

// Errors raised here are stored as dictionary keys (resolved at render, so the
// render effect never depends on the translator); errors from the server are
// stored as the text it sent.
const LOCAL_ERROR_PREFIX = "content.studioFlow.render.errors.";

function errorText(t: Translator, error: string): string {
  return error.startsWith(LOCAL_ERROR_PREFIX) ? t(error as MessageKey) : error;
}

const steps: Step[] = [
  {
    label: "content.studioFlow.render.steps.story.label",
    description: "content.studioFlow.render.steps.story.description",
  },
  {
    label: "content.studioFlow.render.steps.pace.label",
    description: "content.studioFlow.render.steps.pace.description",
  },
  {
    label: "content.studioFlow.render.steps.text.label",
    description: "content.studioFlow.render.steps.text.description",
  },
  {
    label: "content.studioFlow.render.steps.finish.label",
    description: "content.studioFlow.render.steps.finish.description",
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

export default function RenderPage() {
  const router = useRouter();
  const { t } = useI18n();

  const [flow, setFlow] = useState<ContentFlow | null>(null);
  const [result, setResult] = useState<ContentResult | null>(null);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const [activeStep, setActiveStep] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState("");

  const isAiMode = flow?.mode === "ai";

  const hasValidPayload = useMemo(() => {
    return Boolean(
      flow &&
        result &&
        Object.keys(assets).length > 0 &&
        flow.selectedFormat &&
        flow.selectedPlatform &&
        result.selectedVariant?.script?.scriptText
    );
  }, [flow, result, assets]);

  useEffect(() => {
    const flowRaw = localStorage.getItem("content_flow");
    const resultRaw = localStorage.getItem("content_result");
    const creatorAssetsRaw = localStorage.getItem("content_assets");
    const aiAssetsRaw = localStorage.getItem("content_ai_assets");

    if (!flowRaw || !resultRaw) {
      router.replace("/content");
      return;
    }

    try {
      const parsedFlow = JSON.parse(flowRaw) as ContentFlow;
      const parsedResult = JSON.parse(resultRaw) as ContentResult;
      const parsedCreatorAssets = creatorAssetsRaw
        ? (JSON.parse(creatorAssetsRaw) as Record<string, string>)
        : {};
      const parsedAiAssets = aiAssetsRaw
        ? (JSON.parse(aiAssetsRaw) as Record<string, string>)
        : {};

      if (
        !parsedFlow.mode ||
        !parsedFlow.goal ||
        !parsedFlow.contentAngle ||
        !parsedFlow.selectedDirection ||
        !parsedFlow.selectedFormat ||
        !parsedFlow.selectedPlatform
      ) {
        router.replace("/content/creator-plan");
        return;
      }

      const resolvedAssets =
        parsedFlow.mode === "ai" ? parsedAiAssets : parsedCreatorAssets;

      if (!resolvedAssets || Object.keys(resolvedAssets).length === 0) {
        if (parsedFlow.mode === "ai") {
          router.replace("/content/ai-assets");
        } else {
          router.replace("/content/assets-upload");
        }
        return;
      }

      setFlow(parsedFlow);
      setResult(parsedResult);
      setAssets(resolvedAssets);
    } catch (err) {
      console.error(err);
      router.replace("/content");
    }
  }, [router]);

  useEffect(() => {
    if (!hasValidPayload || !flow || !result) return;

    let cancelled = false;
    const stepTimers: number[] = [];
    let pollTimeout: number | null = null;
    const token = localStorage.getItem("token");

    async function pollStatus(currentRenderId: string) {
      try {
        const res = await fetch(`/api/content/render/status/${currentRenderId}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token ?? ""}` },
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error("status_failed");
        }

        console.log("RENDER STATUS:", data);

        if (cancelled) return;

        if ((data.status || "").toLowerCase() === "failed") {
          setError(data.errorMessage || "content.studioFlow.render.errors.finishFailed");
          return;
        }

        if (isTerminalRenderSuccess(data.status, data.url)) {
          localStorage.setItem(
            "content_render_output",
            JSON.stringify({
              renderId: data.id,
              status: data.status,
              url: data.url,
              snapshotUrl: data.snapshotUrl || null,
            })
          );

          setIsReady(true);
          return;
        }

        pollTimeout = window.setTimeout(() => {
          void pollStatus(currentRenderId);
        }, 2000);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError("content.studioFlow.render.errors.statusFailed");
        }
      }
    }

    async function startRender() {
      try {
        setError("");
        setIsReady(false);
        setActiveStep(0);

        if (!token) {
          setError("content.studioFlow.render.errors.signInAgain");
          return;
        }

        steps.forEach((_, index) => {
          const timer = window.setTimeout(() => {
            if (!cancelled) {
              setActiveStep(Math.min(index, steps.length - 1));
            }
          }, index * 1000);

          stepTimers.push(timer);
        });

        const res = await fetch("/api/content/render", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            flow,
            result,
            assets,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          if (data?.error === "brief_required") {
            router.replace("/content/setup");
            return;
          }
          if (data?.error === "limit_reached") {
            setError(data?.message || "content.studioFlow.render.errors.limitReached");
            return;
          }

          throw new Error(data?.error || "failed_to_start_render");
        }

        if (cancelled) return;

        localStorage.setItem(
          "content_render_job",
          JSON.stringify({
            renderId: data.renderId,
            status: data.status || null,
          })
        );

        if (isTerminalRenderSuccess(data.status, data.url)) {
          localStorage.setItem(
            "content_render_output",
            JSON.stringify({
              renderId: data.renderId,
              status: data.status,
              url: data.url,
              snapshotUrl: data.snapshotUrl || null,
            })
          );

          setIsReady(true);
          return;
        }

        if (!data.renderId) {
          setError("content.studioFlow.render.errors.startBroken");
          return;
        }

        void pollStatus(data.renderId);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError("content.studioFlow.render.errors.startFailed");
        }
      }
    }

    void startRender();

    return () => {
      cancelled = true;
      stepTimers.forEach((timer) => window.clearTimeout(timer));
      if (pollTimeout) {
        window.clearTimeout(pollTimeout);
      }
    };
  }, [hasValidPayload, flow, result, assets]);

  function handleContinue() {
    if (!isReady) return;
    // The render step starts a new, quota-consuming render on every visit, so
    // the result REPLACES it: neither the back control nor the browser's Back
    // can return into it — back from the result goes to the step before.
    router.replace("/content/result");
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <BackButton />

          <div style={topBarTitleStyle}>{t("content.studioFlow.render.topBar")}</div>

          <div style={topBarSpacerStyle} />
        </div>

        <ProgressBar progress={95} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>{t("content.studioFlow.common.now")}</div>
            <h1 style={titleStyle}>{t("content.studioFlow.render.title")}</h1>
            <p style={subtitleStyle}>
              {isAiMode
                ? t("content.studioFlow.render.subtitleAi")
                : t("content.studioFlow.render.subtitleCamera")}
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
              <div style={errorTextStyle}>{errorText(t, error)}</div>
            </div>
          ) : (
            <div style={stepsCardStyle}>
              <div style={stepsTitleStyle}>{t("content.studioFlow.render.stepsTitle")}</div>

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
                  {isReady ? t("content.studioFlow.render.readyTitle") : t("content.studioFlow.render.workingTitle")}
                </div>
                <div style={statusTextStyle}>
                  {isReady
                    ? t("content.studioFlow.render.readyText")
                    : t("content.studioFlow.render.workingText")}
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            style={nextButtonStyle(isReady && !error)}
            onClick={handleContinue}
            disabled={!isReady || Boolean(error)}
          >
            {t("content.studioFlow.render.cta")}
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
