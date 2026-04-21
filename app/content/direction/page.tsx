"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";
import {
  getDirectionOptions,
  DirectionOption,
  Goal,
  ContentAngle,
  AudienceType,
  Mode,
} from "@/lib/services/content-direction.service";

type ContentFlow = {
  mode?: Mode;
  goal?: Goal;
  audienceTypes?: AudienceType[];
  contentAngle?: ContentAngle;
  contentGoalPrompt?: string;
  selectedDirection?: DirectionOption;
  selectedFormat?: "reel" | "video" | "image" | "post";
  selectedPlatform?: "instagram" | "tiktok" | "facebook";
};

export default function DirectionPage() {
  const router = useRouter();

  const [directions, setDirections] = useState<DirectionOption[]>([]);
  const [selected, setSelected] = useState<DirectionOption | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem("content_flow");

    if (!raw) {
      router.replace("/content");
      return;
    }

    try {
      const flow: ContentFlow = JSON.parse(raw);

      if (!flow.goal || !flow.contentAngle || !flow.mode) {
        router.replace("/content/setup");
        return;
      }

      const result = getDirectionOptions({
        goal: flow.goal,
        contentAngle: flow.contentAngle,
        audienceTypes: flow.audienceTypes,
        mode: flow.mode,
      });

      setDirections(result);
      setSelected(flow.selectedDirection || result[0] || null);
    } catch (error) {
      console.error(error);
      router.replace("/content/setup");
    }
  }, [router]);

  function handleBack() {
    router.back();
  }

  function handleContinue() {
    if (!selected) return;

    const raw = localStorage.getItem("content_flow");
    const flow: ContentFlow = raw ? JSON.parse(raw) : {};

    localStorage.setItem(
      "content_flow",
      JSON.stringify({
        ...flow,
        selectedDirection: selected,
        selectedFormat: selected.recommendedFormat,
      })
    );

    router.push("/content/format");
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <button type="button" onClick={handleBack} style={backButtonStyle}>
            חזרה
          </button>

          <div style={topBarTitleStyle}>בחירת כיוון</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="בחירת כיוון" />
        <ProgressBar progress={40} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>שלב 3</div>
            <h1 style={titleStyle}>איך נכון לבצע את התוכן שלך?</h1>
            <p style={subtitleStyle}>
              המערכת בנתה לך כמה כיוונים לפי מה שהגדרת. בחר את הכיוון שהכי
              מרגיש נכון לך עכשיו.
            </p>
          </div>

          <div style={cardsWrapStyle}>
            {directions.map((dir, index) => {
              const isSelected = selected?.id === dir.id;

              return (
                <button
                  key={dir.id}
                  type="button"
                  onClick={() => setSelected(dir)}
                  style={directionCardStyle(isSelected)}
                >
                  <div style={cardTopRowStyle}>
                    <div style={cardTitleStyle}>{dir.title}</div>
                    {index === 0 ? (
                      <div style={recommendedBadgeStyle}>מומלץ</div>
                    ) : null}
                  </div>

                  <div style={cardDescriptionStyle}>{dir.description}</div>

                  <div style={whyBoxStyle}>
                    <div style={whyLabelStyle}>למה זה מתאים?</div>
                    <div style={whyTextStyle}>{dir.whyItFits}</div>
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
            disabled={!selected}
            style={nextButtonStyle(Boolean(selected))}
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

const cardsWrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const directionCardStyle = (selected: boolean): React.CSSProperties => ({
  width: "100%",
  textAlign: "right",
  padding: 18,
  borderRadius: 20,
  border: selected ? "2px solid #111827" : "1px solid #e5e7eb",
  background: selected
    ? "linear-gradient(180deg, #ffffff 0%, #f9fafb 100%)"
    : "#ffffff",
  boxShadow: selected
    ? "0 10px 24px rgba(17,24,39,0.10)"
    : "0 6px 18px rgba(0,0,0,0.04)",
  cursor: "pointer",
});

const cardTopRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 10,
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: "#111827",
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

const cardDescriptionStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: "#4b5563",
  marginBottom: 12,
};

const whyBoxStyle: React.CSSProperties = {
  background: "#f9fafb",
  border: "1px solid #eef2f7",
  borderRadius: 14,
  padding: 12,
};

const whyLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 4,
};

const whyTextStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "#6b7280",
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