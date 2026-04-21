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
    script?: {
      scriptText?: string;
      caption?: string;
      shots?: { visual: string; voice: string }[];
    };
  };
};

type Step = {
  label: string;
  description: string;
};

const steps: Step[] = [
  {
    label: "מנתחים את התסריט",
    description: "קוראים את מבנה השוטים ומתאימים לכל שוט ויזואל מתאים.",
  },
  {
    label: "בוחרים נכסי מדיה",
    description: "מייצרים סט assets אוטומטי שמתאים לפורמט ולפלטפורמה.",
  },
  {
    label: "מכינים את הרנדר",
    description: "שומרים את הוויזואלים בפורמט אחיד כדי שהרנדר יוכל לעבוד.",
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

export default function AiAssetsPage() {
  const router = useRouter();

  const [flow, setFlow] = useState<ContentFlow | null>(null);
  const [result, setResult] = useState<ContentResult | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [generatedCount, setGeneratedCount] = useState(0);
  const [error, setError] = useState("");

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
        router.replace("/content");
        return;
      }

      if (
        !parsedFlow.goal ||
        !parsedFlow.contentAngle ||
        !parsedFlow.selectedDirection ||
        !parsedFlow.selectedFormat ||
        !parsedFlow.selectedPlatform
      ) {
        router.replace("/content/direction");
        return;
      }

      if (!parsedResult.selectedVariant?.script?.scriptText) {
        router.replace("/content");
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

        steps.forEach((_, index) => {
          const timer = window.setTimeout(() => {
            if (!cancelled) {
              setActiveStep(Math.min(index, steps.length - 1));
            }
          }, index * 900);

          stepTimers.push(timer);
        });

        const res = await fetch("/api/content/ai-assets", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            flow,
            result,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data?.error || "failed_to_generate_ai_assets");
        }

        if (cancelled) return;

        const assets = (data?.assets || {}) as Record<string, string>;
        const count = Object.keys(assets).length;

        if (!count) {
          setError("לא הצלחנו לייצר ויזואלים למסלול AI");
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
          setError("לא הצלחנו להכין assets אוטומטיים לרנדר");
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

  function handleBack() {
    router.back();
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <button type="button" onClick={handleBack} style={backButtonStyle}>
            חזרה
          </button>

          <div style={topBarTitleStyle}>מכינים ויזואלים</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="מכינים ויזואלים" />
        <ProgressBar progress={82} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>שלב 7</div>
            <h1 style={titleStyle}>מכינים assets למסלול AI</h1>
            <p style={subtitleStyle}>
              המערכת מייצרת עכשיו ויזואלים אוטומטיים לפי התסריט, הפורמט והפלטפורמה.
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
                  {isReady ? "הוויזואלים מוכנים" : "ההכנה בתהליך"}
                </div>
                <div style={statusTextStyle}>
                  {isReady
                    ? `נוצרו ${generatedCount} assets אוטומטיים. מעבירים אותך לרנדר.`
                    : "אנחנו בונים עכשיו שכבת ויזואל אחידה שתאפשר לרנדר לעבוד בלי העלאה ידנית."}
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