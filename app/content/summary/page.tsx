"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

type ContentFlowData = {
  goal: string;
  goalDescription: string;
  intent: string;
  mode: string;
  audienceDescription: string;
  ageRange: string;
  selectedFormat?: string;
};

export default function Page() {
  const router = useRouter();
  const [flowData, setFlowData] = useState<ContentFlowData | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem("content_flow");

    if (!raw) {
      router.replace("/content");
      return;
    }

    try {
      const parsed = JSON.parse(raw) as ContentFlowData;

      if (
        !parsed.goal ||
        !parsed.goalDescription ||
        !parsed.intent ||
        !parsed.mode ||
        !parsed.audienceDescription ||
        !parsed.ageRange ||
        !parsed.selectedFormat
      ) {
        router.replace("/content");
        return;
      }

      setFlowData(parsed);
    } catch {
      router.replace("/content");
    }
  }, [router]);

  const isValid = useMemo(() => {
    return (
      !!flowData?.goal &&
      !!flowData?.goalDescription &&
      !!flowData?.intent &&
      !!flowData?.mode &&
      !!flowData?.audienceDescription &&
      !!flowData?.ageRange &&
      !!flowData?.selectedFormat
    );
  }, [flowData]);

  function handleContinue() {
    if (!isValid) return;
    router.push("/content/create");
  }

  if (!flowData) {
    return (
      <div style={baseStyles.page}>
        <Header title="סיכום" />
        <ProgressBar progress={90} />

        <div style={baseStyles.container}>
          <div style={emptyCard}>טוען את פרטי הזרימה...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={baseStyles.page}>
      <Header title="סיכום" />
      <ProgressBar progress={90} />

      <div style={baseStyles.container}>
        <h1 style={{ marginBottom: 8 }}>בוא נוודא שהכל מדויק</h1>

        <p style={{ marginBottom: 20, color: "#555" }}>
          המערכת תמשיך לבנות את התוכן לפי הבחירות שלך
        </p>

        {card("מטרה", mapGoal(flowData.goal))}
        {card("מה אתה רוצה שיקרה", flowData.goalDescription)}
        {card("פוקוס", mapIntent(flowData.intent))}
        {card("איך התוכן יווצר", mapMode(flowData.mode))}
        {card("קהל יעד", `${flowData.audienceDescription} • גילאים: ${flowData.ageRange}`)}
        {card("כיוון תוכן שנבחר", mapFormat(flowData.selectedFormat || ""))}
      </div>

      <div style={baseStyles.footer}>
        <button
          style={{
            ...baseStyles.cta,
            opacity: isValid ? 1 : 0.5,
          }}
          onClick={handleContinue}
          disabled={!isValid}
        >
          המשך
        </button>
      </div>
    </div>
  );
}

function card(title: string, value: string) {
  return (
    <div style={cardStyle}>
      <div style={cardTitle}>{title}</div>
      <div style={cardValue}>{value}</div>
    </div>
  );
}

const cardStyle = {
  padding: 16,
  borderRadius: 12,
  border: "1px solid #e5e7eb",
  marginBottom: 12,
  background: "#fff",
};

const cardTitle = {
  fontSize: 12,
  color: "#777",
  marginBottom: 6,
};

const cardValue = {
  fontSize: 16,
  fontWeight: 600,
};

const emptyCard = {
  background: "#f3f4f6",
  color: "#555",
  padding: 16,
  borderRadius: 12,
};

function mapGoal(value: string) {
  switch (value) {
    case "leads":
      return "לקבל פניות";
    case "trust":
      return "לבנות אמון";
    case "exposure":
      return "להגדיל חשיפה";
    case "sales":
      return "להביא מכירות";
    default:
      return value;
  }
}

function mapIntent(value: string) {
  switch (value) {
    case "message":
      return "לשלוח הודעה";
    case "follow":
      return "לעקוב";
    case "watch":
      return "לצפות";
    case "sale":
      return "למכור";
    default:
      return value;
  }
}

function mapMode(value: string) {
  switch (value) {
    case "camera":
      return "אני מצטלם";
    case "voice":
      return "קריינות";
    case "ai":
      return "המערכת תיצור בשבילי";
    default:
      return value;
  }
}

function mapFormat(value: string) {
  switch (value) {
    case "reel":
      return "רילס";
    case "video":
      return "וידאו";
    case "image":
      return "תמונה";
    case "post":
      return "פוסט";
    default:
      return value;
  }
}