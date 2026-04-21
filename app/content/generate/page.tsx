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

type StepItem = {
  id: string;
  title: string;
  description: string;
};

const NEXT_ROUTE = "/content/result";

function getGoalLabel(goal?: ContentFlow["goal"]) {
  switch (goal) {
    case "leads":
      return "לידים";
    case "trust":
      return "אמון";
    case "exposure":
      return "חשיפה";
    case "sales":
      return "מכירות";
    default:
      return "תוכן";
  }
}

function getFormatLabel(format?: ContentFlow["selectedFormat"]) {
  switch (format) {
    case "reel":
      return "רילס";
    case "video":
      return "וידאו";
    case "image":
      return "תמונה";
    case "post":
      return "פוסט";
    default:
      return "תוכן";
  }
}

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

function getStepItems(flow: ContentFlow | null): StepItem[] {
  const mode = flow?.mode || "ai";

  if (mode === "ai") {
    return [
      {
        id: "direction",
        title: "מנתחים את הכיוון שבחרת",
        description: "המנוע מיישר את המטרה, הקהל, הזווית והפלטפורמה.",
      },
      {
        id: "structure",
        title: "בונים מבנה מדויק לתוכן",
        description: "נבחרים הוק, קצב, מבנה וסוג תסריט שמתאימים למסלול שלך.",
      },
      {
        id: "script",
        title: "כותבים את התוכן",
        description: "נבנים התסריט, הניסוח והמסר המרכזי לפי מה שביקשת.",
      },
      {
        id: "finish",
        title: "מסיימים את התוצאה",
        description: "מארגנים את הכול להצגה ברורה ונוחה להמשך עבודה.",
      },
    ];
  }

  return [
    {
      id: "direction",
      title: "מנתחים את הכיוון שבחרת",
      description: "המנוע מיישר את המטרה, הקהל, הזווית והפלטפורמה.",
    },
    {
      id: "plan",
      title: "בונים תוכנית ביצוע",
      description: "נבחרים מבנה, סוג שוטים, קצב וסגנון שמתאימים למסלול שלך.",
    },
    {
      id: "script",
      title: "מכינים תסריט והנחיות",
      description: "נבנים מה להגיד, איך לצלם, ומה חשוב שיופיע בתוכן.",
    },
    {
      id: "finish",
      title: "מסיימים את ההכנה",
      description: "התוכן מוכן להצגה ולהמשך ביצוע במסך הבא.",
    },
  ];
}

export default function GeneratePage() {
  const router = useRouter();

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

  steps.forEach((_, index) => {
    const timer = window.setTimeout(() => {
      setActiveStep(index);
    }, index * 1200);

    stepTimers.push(timer);
  });

  async function build() {
    try {
      const res = await fetch("/api/video/plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(flow),
      });

      if (!res.ok) {
        throw new Error("Failed to build content");
      }

      const result = await res.json();

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

  function handleBack() {
    router.back();
  }

  function handleContinue() {
    router.push(NEXT_ROUTE);
  }

  if (!flow) {
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
          <ProgressBar progress={92} />

          <div style={loadingWrapStyle}>
            <h1 style={loadingTitleStyle}>טוען את היצירה שלך...</h1>
            <p style={loadingTextStyle}>רגע לפני שמתחילים לבנות את התוכן</p>
          </div>
        </div>
      </div>
    );
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
        <ProgressBar progress={92} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>שלב 7</div>
            <h1 style={titleStyle}>בונים לך עכשיו את התוכן</h1>
            <p style={subtitleStyle}>
              המערכת יוצרת את התוכן לפי הכיוון, סוג התוכן והפלטפורמה שבחרת.
            </p>
          </div>

          <div style={summaryCardStyle}>
            <div style={summaryTitleStyle}>הבחירות שלך</div>

            <div style={summaryGridStyle}>
              <div style={summaryItemStyle}>
                <div style={summaryLabelStyle}>מטרה</div>
                <div style={summaryValueStyle}>{getGoalLabel(flow.goal)}</div>
              </div>

              <div style={summaryItemStyle}>
                <div style={summaryLabelStyle}>כיוון</div>
                <div style={summaryValueStyle}>
                  {flow.selectedDirection?.title || "לא נבחר"}
                </div>
              </div>

              <div style={summaryItemStyle}>
                <div style={summaryLabelStyle}>סוג תוכן</div>
                <div style={summaryValueStyle}>
                  {getFormatLabel(flow.selectedFormat)}
                </div>
              </div>

              <div style={summaryItemStyle}>
                <div style={summaryLabelStyle}>פלטפורמה</div>
                <div style={summaryValueStyle}>
                  {getPlatformLabel(flow.selectedPlatform)}
                </div>
              </div>
            </div>
          </div>

          <div style={stepsCardStyle}>
            <div style={stepsTitleStyle}>מה קורה עכשיו?</div>

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
                        {step.title}
                      </div>
                      <div style={stepDescriptionStyle}>
                        {step.description}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={statusCardStyle(isReady)}>
            <div style={statusTitleStyle}>
              {isReady ? "הכול מוכן" : "כמעט שם..."}
            </div>
            <div style={statusTextStyle}>
              {isReady
                ? "התוכן שלך מוכן למעבר למסך הבא."
                : "אנחנו מסיימים ללטש את המבנה, הניסוח והכיוון שנבחר."}
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
  maxWidth: 620,
};

const summaryCardStyle: React.CSSProperties = {
  background: "#ffffff",
  padding: 18,
  borderRadius: 20,
  border: "1px solid #e5e7eb",
  boxShadow: "0 6px 18px rgba(0,0,0,0.04)",
  marginBottom: 14,
};

const summaryTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 14,
};

const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 10,
};

const summaryItemStyle: React.CSSProperties = {
  background: "#f9fafb",
  border: "1px solid #eef2f7",
  borderRadius: 14,
  padding: 12,
};

const summaryLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#6b7280",
  marginBottom: 6,
};

const summaryValueStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "#111827",
  lineHeight: 1.4,
};

const stepsCardStyle: React.CSSProperties = {
  background: "#ffffff",
  padding: 18,
  borderRadius: 20,
  border: "1px solid #e5e7eb",
  boxShadow: "0 6px 18px rgba(0,0,0,0.04)",
  marginBottom: 14,
};

const stepsTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "#111827",
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
  border: isActive || isDone ? "2px solid #111827" : "1px solid #d1d5db",
  background: isDone ? "#111827" : isActive ? "#f9fafb" : "#ffffff",
  color: isDone ? "#ffffff" : isPending ? "#9ca3af" : "#111827",
});

const stepLineStyle = (isDone: boolean): React.CSSProperties => ({
  width: 2,
  minHeight: 40,
  background: isDone ? "#111827" : "#e5e7eb",
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
  color: activeOrDone ? "#111827" : "#6b7280",
  marginBottom: 6,
});

const stepDescriptionStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "#6b7280",
};

const statusCardStyle = (ready: boolean): React.CSSProperties => ({
  background: ready ? "#ecfdf5" : "#f9fafb",
  border: ready ? "1px solid #a7f3d0" : "1px solid #eef2f7",
  padding: 16,
  borderRadius: 18,
  marginBottom: 8,
});

const statusTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 6,
};

const statusTextStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#4b5563",
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
  color: "#6b7280",
};

const errorWrapStyle: React.CSSProperties = {
  padding: 20,
  color: "#b91c1c",
  lineHeight: 1.7,
};