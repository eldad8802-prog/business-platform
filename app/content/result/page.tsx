"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

type RenderOutput = {
  renderId?: string;
  status?: string;
  url?: string;
  snapshotUrl?: string | null;
};

type SelectedVariant = {
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

type ContentResult = {
  selectedVariant?: SelectedVariant;
};

function getVideoTypeLabel(videoType?: SelectedVariant["videoType"]) {
  switch (videoType) {
    case "SHORT":
      return "קצר";
    case "MID":
      return "בינוני";
    case "FULL":
      return "מלא";
    default:
      return "לא ידוע";
  }
}

function getStructureLabel(part: string) {
  switch (part) {
    case "hook":
      return "Hook";
    case "pain":
      return "כאב";
    case "explanation":
      return "הסבר";
    case "solution":
      return "פתרון";
    case "proof":
      return "הוכחה";
    case "cta":
      return "קריאה לפעולה";
    case "value":
      return "ערך";
    case "context":
      return "הקשר";
    default:
      return part;
  }
}

export default function ResultPage() {
  const router = useRouter();

  const [renderOutput, setRenderOutput] = useState<RenderOutput | null>(null);
  const [contentResult, setContentResult] = useState<ContentResult | null>(null);
  const [error, setError] = useState("");

  const selectedVariant = useMemo(() => {
    return contentResult?.selectedVariant ?? null;
  }, [contentResult]);

  useEffect(() => {
    const renderRaw = localStorage.getItem("content_render_output");
    const resultRaw = localStorage.getItem("content_result");

    if (!renderRaw) {
      router.replace("/content/render");
      return;
    }

    try {
      const parsedRender = JSON.parse(renderRaw) as RenderOutput;

      if (!parsedRender?.url) {
        router.replace("/content/render");
        return;
      }

      setRenderOutput(parsedRender);

      if (resultRaw) {
        const parsedResult = JSON.parse(resultRaw) as ContentResult;
        setContentResult(parsedResult);
      }
    } catch (err) {
      console.error(err);
      setError("לא הצלחנו לטעון את התוצאה");
    }
  }, [router]);

  function handleBackHome() {
    router.push("/");
  }

  function handleCreateAgain() {
    router.push("/content");
  }

  function handleBackToRender() {
    router.push("/content/render");
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <button
            type="button"
            onClick={handleBackToRender}
            style={backButtonStyle}
          >
            חזרה
          </button>

          <div style={topBarTitleStyle}>התוצאה שלך</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="התוצאה שלך" />
        <ProgressBar progress={100} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>שלב 9</div>
            <h1 style={titleStyle}>הווידאו שלך מוכן</h1>
            <p style={subtitleStyle}>
              זה התוכן שהמערכת יצרה עבורך לפי הכיוון, המבנה והחומרים שנבחרו.
            </p>
          </div>

          {error ? (
            <div style={errorBoxStyle}>
              <div style={errorTitleStyle}>לא ניתן להציג את התוצאה</div>
              <div style={errorTextStyle}>{error}</div>
            </div>
          ) : null}

          {renderOutput?.url ? (
            <div style={videoCardStyle}>
              <div style={videoWrapStyle}>
                <video
                  controls
                  playsInline
                  style={videoStyle}
                  src={renderOutput.url}
                  poster={renderOutput.snapshotUrl || undefined}
                />
              </div>

              <div style={videoMetaStyle}>
                <div style={videoMetaTitleStyle}>הווידאו מוכן לצפייה</div>
                <div style={videoMetaTextStyle}>
                  אפשר לצפות, לבדוק את הזרימה, ואז להחליט אם להמשיך לשיפור או
                  ליצור תוכן חדש.
                </div>
              </div>
            </div>
          ) : null}

          {selectedVariant ? (
            <div style={detailsCardStyle}>
              <div style={detailsTitleStyle}>מה נבחר עבורך</div>

              <div style={summaryGridStyle}>
                <div style={summaryCardStyle}>
                  <div style={summaryLabelStyle}>שם הגרסה</div>
                  <div style={summaryValueStyle}>
                    {selectedVariant.title || "ללא שם"}
                  </div>
                </div>

                <div style={summaryCardStyle}>
                  <div style={summaryLabelStyle}>סוג הסרטון</div>
                  <div style={summaryValueStyle}>
                    {getVideoTypeLabel(selectedVariant.videoType)}
                  </div>
                </div>

                <div style={summaryCardStyle}>
                  <div style={summaryLabelStyle}>אורך</div>
                  <div style={summaryValueStyle}>
                    {selectedVariant.durationSeconds
                      ? `${selectedVariant.durationSeconds} שניות`
                      : "לא ידוע"}
                  </div>
                </div>

                <div style={summaryCardStyle}>
                  <div style={summaryLabelStyle}>ציון</div>
                  <div style={summaryValueStyle}>
                    {typeof selectedVariant.score === "number"
                      ? selectedVariant.score
                      : "—"}
                  </div>
                </div>
              </div>

              {selectedVariant.whyItFits ? (
                <div style={sectionStyle}>
                  <div style={sectionTitleStyle}>למה זה מתאים</div>
                  <div style={infoBoxStyle}>{selectedVariant.whyItFits}</div>
                </div>
              ) : null}

              {selectedVariant.structure?.length ? (
                <div style={sectionStyle}>
                  <div style={sectionTitleStyle}>מבנה הסרטון</div>
                  <div style={structureWrapStyle}>
                    {selectedVariant.structure.map((part, index) => (
                      <div key={`${part}-${index}`} style={structureStepStyle}>
                        <div style={structureIndexStyle}>{index + 1}</div>
                        <div style={structureTextStyle}>
                          {getStructureLabel(part)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedVariant.script?.hook ? (
                <div style={sectionStyle}>
                  <div style={sectionTitleStyle}>Hook</div>
                  <div style={hookBoxStyle}>{selectedVariant.script.hook}</div>
                </div>
              ) : null}

              {selectedVariant.script?.caption ? (
                <div style={sectionStyle}>
                  <div style={sectionTitleStyle}>Caption</div>
                  <div style={captionBoxStyle}>
                    {selectedVariant.script.caption}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={handleCreateAgain}
            style={secondaryButtonStyle}
          >
            יצירת תוכן חדש
          </button>

          <button
            type="button"
            onClick={handleBackHome}
            style={primaryButtonStyle}
          >
            חזרה לבית
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
  maxWidth: 980,
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
  maxWidth: 700,
};

const errorBoxStyle: React.CSSProperties = {
  background: "#fee2e2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  borderRadius: 14,
  padding: 12,
  marginBottom: 16,
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

const videoCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 16,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  marginBottom: 18,
};

const videoWrapStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: 18,
  overflow: "hidden",
  background: "#000000",
  marginBottom: 14,
};

const videoStyle: React.CSSProperties = {
  width: "100%",
  display: "block",
  maxHeight: 720,
  background: "#000000",
};

const videoMetaStyle: React.CSSProperties = {
  display: "grid",
  gap: 6,
};

const videoMetaTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  color: "#111827",
};

const videoMetaTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.8,
  color: "#6b7280",
};

const detailsCardStyle: React.CSSProperties = {
  background: "#ffffff",
  borderRadius: 18,
  padding: 18,
  border: "1px solid #e5e7eb",
  boxShadow: "0 4px 14px rgba(0,0,0,0.04)",
  marginBottom: 20,
};

const detailsTitleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 18,
};

const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
  marginBottom: 18,
};

const summaryCardStyle: React.CSSProperties = {
  background: "#f9fafb",
  borderRadius: 16,
  padding: 14,
  border: "1px solid #e5e7eb",
};

const summaryLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#6b7280",
  marginBottom: 4,
};

const summaryValueStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 800,
  color: "#111827",
};

const sectionStyle: React.CSSProperties = {
  marginBottom: 18,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  color: "#111827",
  marginBottom: 10,
};

const infoBoxStyle: React.CSSProperties = {
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  borderRadius: 14,
  padding: 14,
  fontSize: 14,
  lineHeight: 1.8,
  color: "#374151",
};

const structureWrapStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
};

const structureStepStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
  borderRadius: 999,
  padding: "8px 12px",
};

const structureIndexStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "50%",
  background: "#111827",
  color: "#ffffff",
  fontSize: 12,
  fontWeight: 800,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const structureTextStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#111827",
};

const hookBoxStyle: React.CSSProperties = {
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  color: "#1e3a8a",
  borderRadius: 14,
  padding: 14,
  fontSize: 15,
  lineHeight: 1.7,
  fontWeight: 700,
};

const captionBoxStyle: React.CSSProperties = {
  background: "#f3f4f6",
  border: "1px solid #e5e7eb",
  color: "#374151",
  borderRadius: 14,
  padding: 14,
  fontSize: 14,
  lineHeight: 1.8,
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
  justifyContent: "space-between",
  gap: 12,
};

const primaryButtonStyle: React.CSSProperties = {
  minWidth: 132,
  height: 48,
  borderRadius: 14,
  border: "none",
  background: "#111827",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 800,
  cursor: "pointer",
  boxShadow: "0 10px 24px rgba(17,24,39,0.18)",
};

const secondaryButtonStyle: React.CSSProperties = {
  minWidth: 150,
  height: 48,
  borderRadius: 14,
  border: "1px solid #e5e7eb",
  background: "#ffffff",
  color: "#111827",
  fontSize: 15,
  fontWeight: 800,
  cursor: "pointer",
  boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
};