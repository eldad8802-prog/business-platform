"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

type ContentMode = "ai" | "camera" | "voice";

type ContentFlow = {
  mode?: ContentMode;
  goal?: string;
  audienceTypes?: string[];
  contentAngle?: string;
  contentGoalPrompt?: string;
  selectedDirection?: unknown;
  selectedFormat?: "reel" | "video" | "image" | "post";
  selectedPlatform?: "instagram" | "tiktok" | "facebook";
};

type ModeCard = {
  id: ContentMode;
  title: string;
  description: string;
  badge: string;
};

const modeOptions: ModeCard[] = [
  {
    id: "ai",
    title: "יצירה עם AI",
    description:
      "המערכת יוצרת עבורך כיוון, תסריט והכוונה — בצורה מהירה וחכמה.",
    badge: "הכי מהיר",
  },
  {
    id: "camera",
    title: "אני מצלם",
    description:
      "המערכת בונה לך תוכן מדויק, ואתה מצלם לפי הנחיות ברורות ופשוטות.",
    badge: "שליטה מלאה",
  },
  {
    id: "voice",
    title: "אני מדבר",
    description:
      "המערכת מכוונת אותך לתוכן אישי וטבעי שאתה פשוט אומר למצלמה.",
    badge: "אותנטי ואישי",
  },
];

export default function ContentPage() {
  const router = useRouter();
  const [selectedMode, setSelectedMode] = useState<ContentMode | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem("content_flow");
    if (!raw) return;

    try {
      const parsed: ContentFlow = JSON.parse(raw);
      if (parsed.mode) {
        setSelectedMode(parsed.mode);
      }
    } catch (error) {
      console.error("Failed to parse content_flow", error);
    }
  }, []);

  const canContinue = useMemo(() => Boolean(selectedMode), [selectedMode]);

  function handleBack() {
    router.back();
  }

  function handleContinue() {
    if (!selectedMode) return;

    const raw = localStorage.getItem("content_flow");
    const existing: ContentFlow = raw ? JSON.parse(raw) : {};

    const updated: ContentFlow = {
      ...existing,
      mode: selectedMode,
    };

    localStorage.setItem("content_flow", JSON.stringify(updated));
    router.push("/content/setup");
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <button type="button" onClick={handleBack} style={backButtonStyle}>
            חזרה
          </button>

          <div style={topBarTitleStyle}>יצירת תוכן</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="יצירת תוכן" />
        <ProgressBar progress={10} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>שלב 1</div>
            <h1 style={titleStyle}>איך אתה רוצה ליצור את התוכן שלך?</h1>
            <p style={subtitleStyle}>
              בחר את הדרך שהכי מתאימה לך כרגע. המערכת תבנה את כל התהליך בהתאם
              למסלול שתבחר.
            </p>
          </div>

          <div style={cardsGridStyle}>
            {modeOptions.map((option) => {
              const isSelected = selectedMode === option.id;

              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setSelectedMode(option.id)}
                  style={modeCardStyle(isSelected)}
                >
                  <div style={cardTopRowStyle}>
                    <div style={cardTitleStyle}>{option.title}</div>
                    <div style={cardBadgeStyle(isSelected)}>{option.badge}</div>
                  </div>

                  <div style={cardDescriptionStyle}>{option.description}</div>

                  <div style={cardBottomRowStyle}>
                    <div style={selectionDotStyle(isSelected)} />
                    <div style={selectionTextStyle(isSelected)}>
                      {isSelected ? "נבחר" : "בחר מסלול"}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={handleContinue}
            disabled={!canContinue}
            style={nextButtonStyle(canContinue)}
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
  lineHeight: 1.7,
  color: "#6b7280",
  margin: 0,
  maxWidth: 620,
};

const cardsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 14,
};

const modeCardStyle = (selected: boolean): React.CSSProperties => ({
  width: "100%",
  minHeight: 190,
  textAlign: "right",
  borderRadius: 22,
  border: selected ? "2px solid #111827" : "1px solid #e5e7eb",
  background: selected
    ? "linear-gradient(180deg, #ffffff 0%, #f9fafb 100%)"
    : "#ffffff",
  padding: 18,
  cursor: "pointer",
  boxShadow: selected
    ? "0 12px 30px rgba(17,24,39,0.10)"
    : "0 6px 18px rgba(0,0,0,0.05)",
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  transition: "all 0.2s ease",
});

const cardTopRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 14,
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 800,
  color: "#111827",
  lineHeight: 1.2,
};

const cardBadgeStyle = (selected: boolean): React.CSSProperties => ({
  flexShrink: 0,
  fontSize: 11,
  fontWeight: 800,
  color: selected ? "#111827" : "#065f46",
  background: selected ? "#e5e7eb" : "#ecfdf5",
  border: selected ? "1px solid #d1d5db" : "1px solid #a7f3d0",
  borderRadius: 999,
  padding: "5px 8px",
});

const cardDescriptionStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.75,
  color: "#4b5563",
};

const cardBottomRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 18,
};

const selectionDotStyle = (selected: boolean): React.CSSProperties => ({
  width: 10,
  height: 10,
  borderRadius: "50%",
  background: selected ? "#111827" : "#d1d5db",
});

const selectionTextStyle = (selected: boolean): React.CSSProperties => ({
  fontSize: 13,
  fontWeight: 700,
  color: selected ? "#111827" : "#6b7280",
});

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