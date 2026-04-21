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

type FormatOption = {
  id: "reel" | "video" | "image" | "post";
  title: string;
  description: string;
};

type PlatformOption = {
  id: "instagram" | "tiktok" | "facebook";
  title: string;
  description: string;
};

const formatOptions: FormatOption[] = [
  {
    id: "reel",
    title: "רילס",
    description: "קצר, חד, מהיר, בנוי לעצור גלילה ולמשוך תשומת לב.",
  },
  {
    id: "video",
    title: "וידאו",
    description: "עמוק יותר, מאפשר להסביר, לבנות אמון ולהציג תהליך.",
  },
  {
    id: "image",
    title: "תמונה",
    description: "מסר ויזואלי חד עם השפעה מהירה ופשוטה.",
  },
  {
    id: "post",
    title: "פוסט",
    description: "טקסט עם ערך, הסבר או מסר שיווקי ברור.",
  },
];

const platformOptions: PlatformOption[] = [
  {
    id: "instagram",
    title: "Instagram",
    description: "יותר אסתטי, יותר מיתוג, טוב לרילס, וידאו ותמונה.",
  },
  {
    id: "tiktok",
    title: "TikTok",
    description: "יותר מהיר, יותר hook חזק, פחות מלוטש ויותר תופס.",
  },
  {
    id: "facebook",
    title: "Facebook",
    description: "יותר הסבר, יותר ערך, טוב גם לפוסטים ולתוכן בונה אמון.",
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

  function handleBack() {
    router.back();
  }

  function handleContinue() {
    if (!flow || !selectedFormat || !selectedPlatform) {
      setError("צריך לבחור גם סוג תוכן וגם פלטפורמה");
      return;
    }

    const updatedFlow: ContentFlow = {
      ...flow,
      selectedFormat,
      selectedPlatform,
    };

    localStorage.setItem("content_flow", JSON.stringify(updatedFlow));

    if (flow.mode === "ai") {
      router.push("/content/ai-brief");
      return;
    }

    router.push("/content/creator-plan");
  }

  if (!flow) {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <div style={topBarStyle}>
            <button type="button" onClick={handleBack} style={backButtonStyle}>
              חזרה
            </button>

            <div style={topBarTitleStyle}>בחירת תוכן</div>

            <div style={topBarSpacerStyle} />
          </div>

          <Header title="בחירת סוג תוכן" />
          <ProgressBar progress={62} />

          <div style={loadingWrapStyle}>
            <h1 style={loadingTitleStyle}>טוען את המסלול שלך...</h1>
            <p style={loadingTextStyle}>
              רגע לפני שבוחרים איך ואיפה ליצור את התוכן
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
          <button type="button" onClick={handleBack} style={backButtonStyle}>
            חזרה
          </button>

          <div style={topBarTitleStyle}>סוג תוכן ופלטפורמה</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="בחירת סוג תוכן" />
        <ProgressBar progress={62} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>שלב 4</div>
            <h1 style={titleStyle}>איך ואיפה נכון ליצור את התוכן?</h1>
            <p style={subtitleStyle}>
              המערכת כבר בחרה עבורך כיוון אסטרטגי. עכשיו בוחרים איך התוכן ייראה
              ואיפה הוא יפורסם.
            </p>
          </div>

          <div style={sectionCardStyle}>
            <div style={sectionTitleStyle}>איך אתה רוצה שהתוכן ייראה?</div>
            <div style={sectionSubtitleStyle}>
              בחר את סוג התוכן שהכי מתאים למה שאתה רוצה להפיק עכשיו
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
                      <div style={optionTitleStyle}>{option.title}</div>
                      {isRecommended ? (
                        <div style={recommendedBadgeStyle}>מומלץ</div>
                      ) : null}
                    </div>

                    <div style={optionDescriptionStyle}>
                      {option.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={sectionCardStyle}>
            <div style={sectionTitleStyle}>איפה אתה רוצה לפרסם את זה?</div>
            <div style={sectionSubtitleStyle}>
              הפלטפורמה תשפיע בהמשך על סגנון היצירה, הקצב וההתאמה של התוכן
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
                        <div style={recommendedBadgeStyle}>מומלץ</div>
                      ) : null}
                    </div>

                    <div style={optionDescriptionStyle}>
                      {option.description}
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

const sectionCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 20,
  padding: 18,
  border: "1px solid #e5e7eb",
  boxShadow: "0 6px 18px rgba(0,0,0,0.04)",
  marginBottom: 14,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 6,
};

const sectionSubtitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#6b7280",
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
  textAlign: "right",
  background: selected
    ? "linear-gradient(180deg, #ffffff 0%, #f9fafb 100%)"
    : "#ffffff",
  border: selected ? "2px solid #111827" : "1px solid #e5e7eb",
  borderRadius: 18,
  padding: 18,
  cursor: "pointer",
  boxShadow: selected
    ? "0 10px 24px rgba(17,24,39,0.10)"
    : "0 4px 12px rgba(0,0,0,0.03)",
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
  color: "#111827",
};

const optionDescriptionStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#4b5563",
  lineHeight: 1.7,
};

const recommendedBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: "#065f46",
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
  borderRadius: 999,
  padding: "4px 8px",
  flexShrink: 0,
};

const errorBoxStyle: React.CSSProperties = {
  background: "#fee2e2",
  border: "1px solid #fecaca",
  color: "#991b1b",
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
  color: "#6b7280",
};