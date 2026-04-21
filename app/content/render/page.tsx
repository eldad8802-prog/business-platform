"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

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
    label: "בודקים את הוויזואלים",
    description: "מיישרים בין ה־assets לבין השוטים של התסריט.",
  },
  {
    label: "בונים טיימליין",
    description: "מרכיבים סדר, קצב ומבנה לפי סוג התוכן והפלטפורמה.",
  },
  {
    label: "מוסיפים טקסטים והוקים",
    description: "משלבים hook, כתוביות ומסרים לפי הכיוון שנבחר.",
  },
  {
    label: "מרנדרים תוצאה סופית",
    description: "Creatomate מייצרת עכשיו את הווידאו שלך.",
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
  const [renderId, setRenderId] = useState<string | null>(null);
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
        router.replace("/content/format");
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

    async function pollStatus(currentRenderId: string) {
      try {
        const res = await fetch(`/api/content/render/status/${currentRenderId}`, {
          method: "GET",
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error("status_failed");
        }

        console.log("RENDER STATUS:", data);

        if (cancelled) return;

        if (data.status === "failed") {
          setError(data.errorMessage || "הרנדר נכשל");
          return;
        }

        if (data.url) {
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
          setError("שגיאה בבדיקת סטטוס רנדר");
        }
      }
    }

    async function startRender() {
      try {
        setError("");
        setIsReady(false);
        setActiveStep(0);

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
          },
          body: JSON.stringify({
            flow,
            result,
            assets,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          if (data?.error === "limit_reached") {
            setError(data?.message || "נגמרה המכסה השבועית שלך");
            return;
          }

          throw new Error(data?.error || "failed_to_start_render");
        }

        if (cancelled) return;

        setRenderId(data.renderId || null);

        localStorage.setItem(
          "content_render_job",
          JSON.stringify({
            renderId: data.renderId,
            status: data.status || null,
          })
        );

        if (data.url) {
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
          setError("לא התקבל Render ID תקין");
          return;
        }

        void pollStatus(data.renderId);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError("לא הצלחנו להתחיל את תהליך היצירה");
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

  function handleBack() {
    router.back();
  }

  function handleContinue() {
    if (!isReady) return;
    router.push("/content/result");
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <button type="button" onClick={handleBack} style={backButtonStyle}>
            חזרה
          </button>

          <div style={topBarTitleStyle}>יוצרים עבורך תוכן</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="יוצרים עבורך תוכן" />
        <ProgressBar progress={95} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>שלב 8</div>
            <h1 style={titleStyle}>מרנדרים עכשיו את התוכן שלך</h1>
            <p style={subtitleStyle}>
              {isAiMode
                ? "המערכת מרכיבה את הווידאו לפי הכיוון, הפלטפורמה והוויזואלים שנוצרו אוטומטית."
                : "המערכת מרכיבה את הווידאו לפי הכיוון, הפלטפורמה והחומרים שהעלית."}
            </p>
          </div>

          {flow ? (
            <div style={summaryCardStyle}>
              <div style={summaryTitleStyle}>פלטפורמה נבחרת</div>
              <div style={summaryValueStyle}>
                {getPlatformLabel(flow.selectedPlatform)}
              </div>
            </div>
          ) : null}

          {error ? (
            <div style={errorBoxStyle}>
              <div style={errorTitleStyle}>לא ניתן להמשיך כרגע</div>
              <div style={errorTextStyle}>{error}</div>
            </div>
          ) : (
            <div style={stepsCardStyle}>
              <div style={stepsTitleStyle}>מה קורה עכשיו?</div>

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
                  {isReady ? "הווידאו מוכן" : "הרנדר בתהליך"}
                </div>
                <div style={statusTextStyle}>
                  {isReady
                    ? "הכול מוכן למעבר למסך התוצאה."
                    : renderId
                    ? `Render ID: ${renderId}`
                    : isAiMode
                    ? "מתחילים ליצור את הווידאו שלך על בסיס הוויזואלים שהמערכת הכינה."
                    : "מתחילים ליצור את הווידאו שלך."}
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
            הבא
          </button>
        </div>
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  ...baseStyles.page,
  background:
    "linear-gradient(180deg, #f8fafc 0%, #ffffff 35%, #f8fafc 100%)",
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
  color: "#111827",
};

const topBarSpacerStyle: React.CSSProperties = {
  width: 68,
};

const backButtonStyle: React.CSSProperties = {
  minWidth: 68,
  height: 38,
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  background: "#ffffff",
  color: "#111827",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
  boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
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
  color: "#065f46",
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
  borderRadius: 999,
  padding: "6px 10px",
  marginBottom: 12,
};

const titleStyle: React.CSSProperties = {
  fontSize: 30,
  fontWeight: 800,
  lineHeight: 1.15,
  color: "#111827",
  margin: 0,
  marginBottom: 10,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 15,
  color: "#6b7280",
  lineHeight: 1.7,
  margin: 0,
  maxWidth: 640,
};

const summaryCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 16,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  marginBottom: 14,
};

const summaryTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#6b7280",
  marginBottom: 4,
};

const summaryValueStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "#111827",
};

const stepsCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 16,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
};

const stepsTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "#111827",
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
  border: isDone || isCurrent ? "2px solid #111827" : "1px solid #d1d5db",
  background: isDone ? "#111827" : isCurrent ? "#f9fafb" : "#ffffff",
  color: isDone ? "#ffffff" : "#111827",
});

const stepLineStyle = (done: boolean): React.CSSProperties => ({
  width: 2,
  minHeight: 40,
  background: done ? "#111827" : "#e5e7eb",
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
  color: active ? "#111827" : "#6b7280",
  marginBottom: 4,
});

const stepDescriptionStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "#6b7280",
};

const statusBoxStyle = (ready: boolean): React.CSSProperties => ({
  marginTop: 8,
  background: ready ? "#ecfdf5" : "#f9fafb",
  border: ready ? "1px solid #a7f3d0" : "1px solid #eef2f7",
  borderRadius: 14,
  padding: 12,
});

const statusTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 4,
};

const statusTextStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "#4b5563",
  wordBreak: "break-word",
};

const errorBoxStyle: React.CSSProperties = {
  background: "#fee2e2",
  border: "1px solid #fecaca",
  color: "#991b1b",
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
  borderTop: "1px solid #e5e7eb",
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
  background: enabled ? "#111827" : "#9ca3af",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 800,
  cursor: enabled ? "pointer" : "not-allowed",
  boxShadow: enabled ? "0 10px 24px rgba(17,24,39,0.18)" : "none",
});