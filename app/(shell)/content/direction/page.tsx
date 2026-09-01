"use client";

import { useEffect, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import BackButton from "@/components/ui/back-button";
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
          <BackButton />

          <div style={topBarTitleStyle}>איך לספר את זה</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="איך לספר את זה" />
        <ProgressBar progress={40} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>עכשיו</div>
            <h1 style={titleStyle}>איך נספר את זה בפועל?</h1>
            <p style={subtitleStyle}>
              הנה כמה דרכים שאפשר ללכת עליהן לפי מה שסימנת. בחר מה שנשמע לך
              הכי טבעי עכשיו.
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
                      <div style={recommendedBadgeStyle}>מתאים במיוחד</div>
                    ) : null}
                  </div>

                  <div style={cardDescriptionStyle}>{dir.description}</div>

                  <div style={whyBoxStyle}>
                    <div style={whyLabelStyle}>למה זה יכול להתאים</div>
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
            המשך — פורמט ופלטפורמה
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
  lineHeight: 1.7,
  color: "var(--dz-text-muted)",
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
  border: selected ? "2px solid var(--dz-text-primary)" : "1px solid var(--dz-border)",
  background: selected
    ? "linear-gradient(180deg, var(--dz-surface-flat) 0%, var(--dz-surface-muted) 100%)"
    : "var(--dz-surface)",
  boxShadow: selected
    ? "0 10px 24px rgba(52, 60, 50, 0.1)"
    : "0 6px 18px rgba(52, 60, 50, 0.04)",
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
  color: "var(--dz-text-primary)",
};

const recommendedBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: "var(--dz-success)",
  background: "var(--dz-success-bg-soft)",
  border: "1px solid var(--dz-success-border)",
  borderRadius: 999,
  padding: "4px 8px",
  flexShrink: 0,
};

const cardDescriptionStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: "var(--dz-text-secondary)",
  marginBottom: 12,
};

const whyBoxStyle: React.CSSProperties = {
  background: "var(--dz-surface-muted)",
  border: "1px solid var(--dz-border)",
  borderRadius: 14,
  padding: 12,
};

const whyLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
  marginBottom: 4,
};

const whyTextStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "var(--dz-text-muted)",
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
