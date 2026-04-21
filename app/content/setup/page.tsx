"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

type Goal = "leads" | "trust" | "exposure" | "sales";

type AudienceType =
  | "new"
  | "interested"
  | "ready"
  | "existing"
  | "all";

type ContentAngle =
  | "show_result"
  | "explain"
  | "show_difference"
  | "attention"
  | "trust"
  | "cta";

type ContentFlow = {
  mode?: "ai" | "camera" | "voice";
  goal?: Goal;
  audienceTypes?: AudienceType[];
  contentAngle?: ContentAngle;
  contentGoalPrompt?: string;
};

export default function SetupPage() {
  const router = useRouter();

  const [goal, setGoal] = useState<Goal | null>(null);
  const [audienceTypes, setAudienceTypes] = useState<AudienceType[]>([]);
  const [contentAngle, setContentAngle] = useState<ContentAngle | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const raw = localStorage.getItem("content_flow");
    if (!raw) {
      router.replace("/content");
      return;
    }

    try {
      const parsed: ContentFlow = JSON.parse(raw);

      if (!parsed.mode) {
        router.replace("/content");
        return;
      }

      if (parsed.goal) setGoal(parsed.goal);
      if (parsed.audienceTypes) setAudienceTypes(parsed.audienceTypes);
      if (parsed.contentAngle) setContentAngle(parsed.contentAngle);
      if (parsed.contentGoalPrompt) setPrompt(parsed.contentGoalPrompt);
    } catch (e) {
      console.error(e);
    }
  }, [router]);

  const canContinue = useMemo(() => {
    return Boolean(
      goal &&
        contentAngle &&
        audienceTypes.length > 0 &&
        prompt.trim().length >= 10
    );
  }, [goal, audienceTypes, contentAngle, prompt]);

  function toggleAudience(type: AudienceType) {
    setAudienceTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  }

  function handleBack() {
    router.back();
  }

  function handleContinue() {
    if (!canContinue || !goal || !contentAngle) {
      setError("צריך למלא את כל השלבים כדי להמשיך");
      return;
    }

    const raw = localStorage.getItem("content_flow");
    const existing = raw ? JSON.parse(raw) : {};

    localStorage.setItem(
      "content_flow",
      JSON.stringify({
        ...existing,
        goal,
        audienceTypes,
        contentAngle,
        contentGoalPrompt: prompt.trim(),
      })
    );

    router.push("/content/direction");
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={topBarStyle}>
          <button type="button" onClick={handleBack} style={backButtonStyle}>
            חזרה
          </button>

          <div style={topBarTitleStyle}>הגדרת תוכן</div>

          <div style={topBarSpacerStyle} />
        </div>

        <Header title="הגדרת תוכן" />
        <ProgressBar progress={25} />

        <div style={contentAreaStyle}>
          <div style={introWrapStyle}>
            <div style={eyebrowStyle}>שלב 2</div>
            <h1 style={titleStyle}>בוא נגדיר את הכיוון של התוכן שלך</h1>
            <p style={subtitleStyle}>
              המערכת תבנה את התוכן לפי המטרה שלך, סוג הקהל, הזווית שתבחר, ומה
              שאתה באמת רוצה שיקרה בפועל.
            </p>
          </div>

          <Section
            title="מה המטרה שלך?"
            subtitle="בחר מה אתה רוצה שהתוכן הזה ישיג עבורך"
          >
            <CardsGrid>
              <Card
                selected={goal === "leads"}
                onClick={() => {
                  setGoal("leads");
                  setError("");
                }}
                title="לידים"
                desc="לקבל יותר פניות והודעות"
              />
              <Card
                selected={goal === "sales"}
                onClick={() => {
                  setGoal("sales");
                  setError("");
                }}
                title="מכירות"
                desc="להוביל לקנייה או סגירה"
              />
              <Card
                selected={goal === "trust"}
                onClick={() => {
                  setGoal("trust");
                  setError("");
                }}
                title="אמון"
                desc="לבנות מקצועיות וביטחון"
              />
              <Card
                selected={goal === "exposure"}
                onClick={() => {
                  setGoal("exposure");
                  setError("");
                }}
                title="חשיפה"
                desc="להגיע ליותר אנשים"
              />
            </CardsGrid>
          </Section>

          <Section
            title="למי התוכן מיועד?"
            subtitle="אפשר לבחור יותר מסוג קהל אחד"
          >
            <CardsGrid>
              <CardMulti
                selected={audienceTypes.includes("new")}
                onClick={() => {
                  toggleAudience("new");
                  setError("");
                }}
                title="לקוחות חדשים"
              />
              <CardMulti
                selected={audienceTypes.includes("interested")}
                onClick={() => {
                  toggleAudience("interested");
                  setError("");
                }}
                title="מתעניינים"
              />
              <CardMulti
                selected={audienceTypes.includes("ready")}
                onClick={() => {
                  toggleAudience("ready");
                  setError("");
                }}
                title="מוכנים לקנייה"
              />
              <CardMulti
                selected={audienceTypes.includes("existing")}
                onClick={() => {
                  toggleAudience("existing");
                  setError("");
                }}
                title="לקוחות קיימים"
              />
            </CardsGrid>
          </Section>

          <Section
            title="איך להציג את התוכן?"
            subtitle="בחר את הזווית המרכזית שהכי מתאימה למה שאתה רוצה להשיג"
          >
            <CardsGrid>
              <Card
                selected={contentAngle === "show_result"}
                onClick={() => {
                  setContentAngle("show_result");
                  setError("");
                }}
                title="להראות תוצאה"
              />
              <Card
                selected={contentAngle === "explain"}
                onClick={() => {
                  setContentAngle("explain");
                  setError("");
                }}
                title="להסביר"
              />
              <Card
                selected={contentAngle === "show_difference"}
                onClick={() => {
                  setContentAngle("show_difference");
                  setError("");
                }}
                title="להראות הבדל"
              />
              <Card
                selected={contentAngle === "attention"}
                onClick={() => {
                  setContentAngle("attention");
                  setError("");
                }}
                title="לתפוס תשומת לב"
              />
              <Card
                selected={contentAngle === "trust"}
                onClick={() => {
                  setContentAngle("trust");
                  setError("");
                }}
                title="לבנות אמון"
              />
              <Card
                selected={contentAngle === "cta"}
                onClick={() => {
                  setContentAngle("cta");
                  setError("");
                }}
                title="להניע לפעולה"
              />
            </CardsGrid>
          </Section>

          <Section
            title="מה אתה רוצה שיקרה בפועל?"
            subtitle="כתוב בצורה פשוטה מה אתה רוצה שהתוכן הזה יעשה"
          >
            <textarea
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setError("");
              }}
              style={textareaStyle}
              placeholder="לדוגמה: אני רוצה תוכן שיגרום לאנשים לשלוח לי הודעה ויבין מהר למה כדאי לבחור בי"
            />
            <div style={helperTextStyle}>
              ככל שתהיה ברור יותר, המערכת תדע לדייק טוב יותר את התוצאה
            </div>
          </Section>

          {error ? <div style={errorBoxStyle}>{error}</div> : null}
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

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>{title}</div>
      <div style={sectionSubtitleStyle}>{subtitle}</div>
      {children}
    </div>
  );
}

function CardsGrid({ children }: { children: React.ReactNode }) {
  return <div style={gridStyle}>{children}</div>;
}

function Card({
  selected,
  onClick,
  title,
  desc,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  desc?: string;
}) {
  return (
    <button type="button" onClick={onClick} style={cardStyle(selected)}>
      <div style={cardTitleStyle}>{title}</div>
      {desc ? <div style={cardDescStyle}>{desc}</div> : null}
    </button>
  );
}

function CardMulti({
  selected,
  onClick,
  title,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button type="button" onClick={onClick} style={cardStyle(selected)}>
      <div style={cardTitleStyle}>{title}</div>
    </button>
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

const sectionStyle: React.CSSProperties = {
  marginBottom: 20,
  background: "#ffffff",
  borderRadius: 20,
  padding: 18,
  border: "1px solid #e5e7eb",
  boxShadow: "0 6px 18px rgba(0,0,0,0.04)",
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
  marginBottom: 12,
  lineHeight: 1.6,
};

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 10,
};

const cardStyle = (selected: boolean): React.CSSProperties => ({
  padding: 16,
  minHeight: 96,
  borderRadius: 16,
  border: selected ? "2px solid #111827" : "1px solid #e5e7eb",
  background: selected ? "#f9fafb" : "#ffffff",
  textAlign: "right",
  cursor: "pointer",
  boxShadow: selected ? "0 8px 20px rgba(17,24,39,0.08)" : "none",
});

const cardTitleStyle: React.CSSProperties = {
  fontWeight: 800,
  fontSize: 15,
  color: "#111827",
  marginBottom: 6,
};

const cardDescStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6b7280",
  lineHeight: 1.6,
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 120,
  borderRadius: 14,
  border: "1px solid #e5e7eb",
  padding: 14,
  fontSize: 15,
  lineHeight: 1.7,
  resize: "vertical",
  outline: "none",
};

const helperTextStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: "#6b7280",
  lineHeight: 1.6,
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

const errorBoxStyle: React.CSSProperties = {
  marginTop: 6,
  marginBottom: 8,
  background: "#fee2e2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  borderRadius: 14,
  padding: 12,
  fontSize: 13,
  lineHeight: 1.6,
};