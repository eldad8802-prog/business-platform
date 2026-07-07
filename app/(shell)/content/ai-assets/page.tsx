"use client";

import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import BackButton from "@/components/ui/back-button";
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
    label: "בוחרים ויזואלים לכל רגע",
    description: "לפי הכיוון שבחרת, מוצאים לכל רגע בסרטון את מה שנכון שיופיע שם.",
  },
  {
    label: "מכינים את השכבות",
    description: "מסדרים את כל החלקים כך שהסרטון ייראה שלם בפורמט ובפלטפורמה שבחרת.",
  },
  {
    label: "מרכיבים לסרטון אחד",
    description: "מחברים את הכל — מוכנים להרכבה הסופית.",
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
          setError(
            "כדי להמשיך צריך להתחבר. מעבירים אותך למסך ההתחברות…"
          );
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

        const res = await fetch("/api/content/ai-assets", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionUserId}`,
          },
          body: JSON.stringify({
            flow,
            result,
          }),
        });

        const data = await res.json();

        if (res.status === 401) {
          if (!cancelled) {
            setError(
              "פג תוקף ההתחברות או שהחשבון לא זוהה. מעבירים אותך להתחברות מחדש…"
            );
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
          setError("לא הצלחנו להכין את החומרים לסרטון. אפשר לנסות שוב בעוד רגע.");
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
          setError("לא הצלחנו להשלים את ההכנה. אפשר לנסות שוב.");
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
    setError("לא הצלחנו לאתר את נתוני הסרטון. חזרו לבחור כיוון מחדש.");
  }, [flow, result, hasValidPayload]);

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <BackButton />

          <div style={topBarTitleStyle}>מכינים את הסרטון</div>

          <div style={topBarSpacerStyle} />
        </div>

        <ProgressBar progress={82} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>עכשיו</div>
            <h1 style={titleStyle}>מרכיבים לך את מה שיופיע על המסך</h1>
            <p style={subtitleStyle}>
              לפי הכיוון שבחרת, אנחנו מכינים עכשיו את כל החלקים לסרטון — בלי
              שתצטרכו להעלות כלום בשלב הזה.
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
              <button
                type="button"
                onClick={() => router.replace("/content/creator-plan")}
                style={errorBackButtonStyle}
              >
                חזרה לבחירת כיוון
              </button>
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
                  {isReady ? "החומרים מוכנים" : "רגע אחד…"}
                </div>
                <div style={statusTextStyle}>
                  {isReady
                    ? `הכנו ${generatedCount} חלקים לסרטון. ממשיכים להרכבה הסופית.`
                    : "אנחנו מרכיבים עכשיו את כל מה שיופיע על המסך — זה לוקח רגע."}
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

const summaryValueStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 4,
};

const summaryPlatformStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#6b7280",
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

const errorBackButtonStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 12,
  height: 40,
  paddingInline: 20,
  borderRadius: 12,
  border: "none",
  background: TOKEN.action.primary.background,
  color: "#ffffff",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};
