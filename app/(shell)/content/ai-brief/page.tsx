"use client";

import { useEffect, useMemo, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import BackButton from "@/components/ui/back-button";
import { baseStyles } from "@/lib/styles/baseStyles";

type StoredAsset = {
  name: string;
  type: string;
  size: number;
  preview: string;
};

type ContentFlow = {
  mode?: "ai" | "camera" | "voice";
  goal?: string;
  audienceTypes?: string[];
  contentAngle?:
    | "show_result"
    | "explain"
    | "show_difference"
    | "attention"
    | "trust"
    | "cta";
  contentGoalPrompt?: string;
  selectedFormat?: "reel" | "video" | "image" | "post";
  selectedPlatform?: "instagram" | "tiktok" | "facebook";
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
  hasSourceAssets?: boolean;
  aiSourceAssets?: StoredAsset[];
};

export default function AIBriefPage() {
  const router = useRouter();

  const [goalText, setGoalText] = useState("");
  const [hasAssets, setHasAssets] = useState(false);
  const [assets, setAssets] = useState<StoredAsset[]>([]);
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
        parsed.mode !== "ai" ||
        !parsed.goal ||
        !parsed.contentAngle ||
        !parsed.selectedDirection ||
        !parsed.selectedFormat ||
        !parsed.selectedPlatform
      ) {
        router.replace("/content/format");
        return;
      }

      if (parsed.contentGoalPrompt) {
        setGoalText(parsed.contentGoalPrompt);
      }

      if (parsed.hasSourceAssets) {
        setHasAssets(true);
      }

      if (
        Array.isArray(parsed.aiSourceAssets) &&
        parsed.aiSourceAssets.length > 0
      ) {
        setAssets(parsed.aiSourceAssets);
      }
    } catch (err) {
      console.error(err);
      router.replace("/content");
    }
  }, [router]);

  const canContinue = useMemo(() => {
    return goalText.trim().length >= 10;
  }, [goalText]);

  function handleFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);

    const mapped: StoredAsset[] = files.map((file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      preview: URL.createObjectURL(file),
    }));

    setAssets(mapped);
  }

  function handleContinue() {
    const cleanGoal = goalText.trim();

    if (cleanGoal.length < 10) {
      setError("צריך לכתוב בצורה ברורה מה אתה רוצה שהמערכת תיצור");
      return;
    }

    const raw = localStorage.getItem("content_flow");
    const flow: ContentFlow = raw ? JSON.parse(raw) : {};

    localStorage.setItem(
      "content_flow",
      JSON.stringify({
        ...flow,
        contentGoalPrompt: cleanGoal,
        hasSourceAssets: hasAssets,
        aiSourceAssets: hasAssets ? assets : [],
      })
    );

  router.push("/content/creator-plan");
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <BackButton />

          <div style={topBarTitleStyle}>הנחיה למערכת</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="הנחיה למערכת" />
        <ProgressBar progress={78} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>שלב 5</div>
            <h1 style={titleStyle}>מה בדיוק אתה רוצה שהמערכת תיצור?</h1>

            <p style={subtitleStyle}>
              כתוב בצורה פשוטה מה אתה רוצה להדגיש, איזה תוכן אתה רוצה לקבל,
              ומה אתה רוצה שיקרה אחרי שהלקוח יראה אותו.
            </p>
          </div>

          <div style={sectionCardStyle}>
            <div style={sectionTitleStyle}>מה המטרה של התוכן הזה?</div>
            <div style={sectionSubtitleStyle}>
              נסח את זה במילים שלך. ככל שתהיה ברור יותר, המערכת תדע לבנות
              עבורך תוצאה מדויקת יותר.
            </div>

            <textarea
              value={goalText}
              onChange={(e) => {
                setGoalText(e.target.value);
                if (error) setError("");
              }}
              placeholder="לדוגמה: אני רוצה סרטון קצר ומושך שמראה את רמת העבודה שלי וגורם לאנשים לשלוח הודעה"
              style={textareaStyle}
            />

            <div style={helperTextStyle}>
              מומלץ לכתוב מה אתה רוצה להבליט, מה חשוב לך שירגישו, ומה הצעד הבא
              שאתה רוצה שהצופה יעשה.
            </div>
          </div>

          <div style={sectionCardStyle}>
            <div style={sectionTitleStyle}>
              יש לך תמונות או סרטונים שתרצה שנשתמש בהם?
            </div>
            <div style={sectionSubtitleStyle}>
              זה לא חובה, אבל זה יכול לשפר משמעותית את התוצאה
            </div>

            <div style={toggleRowStyle}>
              <button
                type="button"
                onClick={() => setHasAssets(true)}
                style={toggleOptionStyle(hasAssets)}
              >
                כן
              </button>

              <button
                type="button"
                onClick={() => {
                  setHasAssets(false);
                  setAssets([]);
                }}
                style={toggleOptionStyle(!hasAssets)}
              >
                לא
              </button>
            </div>

            {hasAssets ? (
              <div style={uploadWrapStyle}>
                <input
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  onChange={handleFilesChange}
                  style={fileInputStyle}
                />

                {assets.length > 0 ? (
                  <div style={filesCountStyle}>
                    נוספו {assets.length} קבצים למסלול היצירה
                  </div>
                ) : (
                  <div style={helperTextStyle}>
                    אפשר להמשיך גם בלי להעלות כרגע
                  </div>
                )}
              </div>
            ) : null}
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
  color: "var(--dz-text-muted)",
  lineHeight: 1.7,
  margin: 0,
  maxWidth: 620,
};

const sectionCardStyle: React.CSSProperties = {
  background: "var(--dz-surface)",
  borderRadius: 20,
  padding: 18,
  border: "1px solid var(--dz-border)",
  boxShadow: "0 6px 18px rgba(52, 60, 50, 0.04)",
  marginBottom: 14,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 800,
  color: "var(--dz-text-primary)",
  marginBottom: 6,
};

const sectionSubtitleStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--dz-text-muted)",
  lineHeight: 1.6,
  marginBottom: 14,
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 140,
  borderRadius: 16,
  border: "1px solid var(--dz-border)",
  padding: 14,
  fontSize: 15,
  lineHeight: 1.7,
  resize: "vertical",
  outline: "none",
};

const helperTextStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 13,
  color: "var(--dz-text-muted)",
  lineHeight: 1.6,
};

const toggleRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
};

const toggleOptionStyle = (selected: boolean): React.CSSProperties => ({
  minWidth: 88,
  height: 42,
  borderRadius: 12,
  border: selected ? "2px solid var(--dz-text-primary)" : "1px solid var(--dz-border-strong)",
  background: selected ? "var(--dz-text-primary)" : "var(--dz-surface)",
  color: selected ? "var(--dz-text-on-brand)" : "var(--dz-text-primary)",
  fontWeight: 800,
  fontSize: 14,
  cursor: "pointer",
});

const uploadWrapStyle: React.CSSProperties = {
  marginTop: 16,
};

const fileInputStyle: React.CSSProperties = {
  width: "100%",
};

const filesCountStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 13,
  color: "var(--dz-success)",
  lineHeight: 1.6,
};

const errorBoxStyle: React.CSSProperties = {
  background: "var(--dz-danger-bg)",
  border: "1px solid var(--dz-danger-border)",
  color: "var(--dz-danger)",
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
  background: enabled ? TOKEN.action.primary.background : "var(--dz-text-muted)",
  color: "var(--dz-text-on-brand)",
  fontSize: 15,
  fontWeight: 800,
  cursor: enabled ? "pointer" : "not-allowed",
  boxShadow: enabled ? TOKEN.action.primary.shadow : "none",
});
