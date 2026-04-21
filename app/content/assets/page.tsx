"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

type ContentFlowData = {
  mode: string;
  selectedFormat: "reel" | "video" | "image" | "post";
  videoType?: {
    label: string;
  };
  assetsPlan?: {
    requiredAssets: string[];
    optionalAssets: string[];
    guidance: string;
  };
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

      if (!parsed.selectedFormat || !parsed.assetsPlan) {
        router.replace("/content");
        return;
      }

      setFlowData(parsed);
    } catch {
      router.replace("/content");
    }
  }, [router]);

  function handleContinue() {
    router.push("/content/generate");
  }

  if (!flowData) {
    return (
      <div style={baseStyles.page}>
        <Header title="הכנת נכסים" />
        <ProgressBar progress={100} />

        <div style={baseStyles.container}>
          <div style={emptyCard}>טוען...</div>
        </div>
      </div>
    );
  }

  const isAI = flowData.mode === "ai";
  const assetsPlan = flowData.assetsPlan;
  const requiredAssets = assetsPlan?.requiredAssets ?? [];
  const optionalAssets = assetsPlan?.optionalAssets ?? [];
  const guidance = assetsPlan?.guidance ?? "";

  return (
    <div style={baseStyles.page}>
      <Header title="הכנת נכסים" />
      <ProgressBar progress={100} />

      <div style={baseStyles.container}>
        <h1 style={{ marginBottom: 8 }}>בוא נכין את התוכן שלך</h1>

        <div style={card}>
          <h2 style={h2}>סוג תוכן</h2>
          <div style={value}>{mapFormat(flowData.selectedFormat)}</div>
        </div>

        {flowData.videoType ? (
          <div style={card}>
            <h2 style={h2}>כיוון מוביל</h2>
            <div style={value}>{flowData.videoType.label}</div>
          </div>
        ) : null}

        {!isAI ? (
          <div style={card}>
            <h2 style={h2}>מה צריך להכין</h2>

            {requiredAssets.map((item, idx) => (
              <div key={idx} style={instruction}>
                • {item}
              </div>
            ))}
          </div>
        ) : null}

        {!isAI && optionalAssets.length > 0 ? (
          <div style={card}>
            <h2 style={h2}>אופציונלי</h2>

            {optionalAssets.map((item, idx) => (
              <div key={idx} style={instruction}>
                • {item}
              </div>
            ))}
          </div>
        ) : null}

        {isAI ? (
          <div style={card}>
            <h2 style={h2}>יצירה אוטומטית</h2>
            <p style={{ color: "#555" }}>
              המערכת תיצור עבורך את התוכן באופן אוטומטי לפי הנתונים שהזנת
            </p>
          </div>
        ) : null}

        {guidance ? (
          <div style={card}>
            <h2 style={h2}>הכוונה</h2>
            <p style={{ color: "#555" }}>{guidance}</p>
          </div>
        ) : null}
      </div>

      <div style={baseStyles.footer}>
        <button style={baseStyles.cta} onClick={handleContinue}>
          המשך ליצירת התוכן
        </button>
      </div>
    </div>
  );
}

function mapFormat(value: string) {
  if (value === "reel") return "רילס";
  if (value === "video") return "וידאו";
  if (value === "image") return "תמונה";
  return "פוסט";
}

const card = {
  background: "#fff",
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
  border: "1px solid #eee",
};

const h2 = {
  marginBottom: 8,
};

const value = {
  fontSize: 16,
  fontWeight: 600,
};

const instruction = {
  marginBottom: 6,
};

const emptyCard = {
  background: "#f3f4f6",
  color: "#555",
  padding: 16,
  borderRadius: 12,
};
