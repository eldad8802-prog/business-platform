"use client";

import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import BackButton from "@/components/ui/back-button";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

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
  label: string;
  description: string;
};

const steps: Step[] = [
  {
    label: "מחברים את החומרים לסיפור",
    description: "מסדרים את הרגעים בסדר שמתאים לכיוון ולפורמט שבחרת.",
  },
  {
    label: "מסדרים קצב ומעברים",
    description: "מתאימים את הקצב, המעברים והתחושה לפלטפורמה.",
  },
  {
    label: "משלבים פתיחה וטקסט על המסך",
    description: "מוסיפים את הפתיחה, הטקסט והמסר לפי הכיוון שנבחר.",
  },
  {
    label: "מגמרים את הסרטון",
    description: "מחברים את כל החלקים לסרטון אחד גמור שאפשר לפרסם.",
  },
];

function getPlatformLabel(platform?: ContentFlow["selectedPlatform"]) {
  switch (platform) {
    case "instagram":
      return "Instagram";
    case "tiktok":
      return "TikTok";
    case "facebook":
      return "Facebook";
    default:
      return "פלטפורמה";
  }
}

export default function RenderPage() {
  const router = useRouter();

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
          setError(data.errorMessage || "לא הצלחנו לסיים את הסרטון");
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
          setError("לא הצלחנו לבדוק איפה זה עומד. נסו שוב בעוד רגע.");
        }
      }
    }

    async function startRender() {
      try {
        setError("");
        setIsReady(false);
        setActiveStep(0);

        if (!token) {
          setError("כדי להמשיך צריך להתחבר מחדש.");
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
            setError(data?.message || "נגמרה המכסה השבועית שלך");
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
          setError("משהו השתבש בהתחלה — נסו לרענן את העמוד.");
          return;
        }

        void pollStatus(data.renderId);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError("לא הצלחנו להתחיל את ההרכבה. אפשר לנסות שוב.");
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
    router.push("/content/result");
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <BackButton />

          <div style={topBarTitleStyle}>מרכיבים את הסרטון</div>

          <div style={topBarSpacerStyle} />
        </div>

        <ProgressBar progress={95} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>עכשיו</div>
            <h1 style={titleStyle}>מרכיבים עכשיו את הסרטון שלך</h1>
            <p style={subtitleStyle}>
              {isAiMode
                ? "לפי הכיוון שבחרת, אנחנו מחברים לסרטון אחד את כל מה שהכנו עבורך בדרך."
                : "לפי הכיוון שבחרת, אנחנו מחברים את מה שצילמת והעלית לסרטון אחד."}
            </p>
          </div>

          {flow ? (
            <div style={summaryCardStyle}>
              <div style={summaryValueStyle}>
                {flow.selectedDirection?.title ?? "הכיוון שנבחר"}
              </div>
              <div style={summaryPlatformStyle}>
                {getPlatformLabel(flow.selectedPlatform)}
              </div>
            </div>
          ) : null}

          {error ? (
            <div style={errorBoxStyle}>
              <div style={errorTitleStyle}>רגע, משהו נתקע</div>
              <div style={errorTextStyle}>{error}</div>
            </div>
          ) : (
            <div style={stepsCardStyle}>
              <div style={stepsTitleStyle}>מה קורה כאן?</div>

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
                          {step.label}
                        </div>
                        <div style={stepDescriptionStyle}>
                          {step.description}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={statusBoxStyle(isReady)}>
                <div style={statusTitleStyle}>
                  {isReady ? "הסרטון מוכן" : "עדיין מרכיבים"}
                </div>
                <div style={statusTextStyle}>
                  {isReady
                    ? "אפשר לעבור לראות את התוצאה."
                    : "זה עדיין בעבודה ברקע — לפעמים לוקח עוד דקה־שתיים. אפשר להשאיר את העמוד פתוח."}
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
            לראות את הסרטון
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
