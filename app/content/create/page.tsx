"use client";

import { useEffect, useState } from "react";
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
  selectedFormat: "reel" | "video" | "image" | "post";
};

type PlanResult = {
  videoType: {
    type: string;
    label: string;
    description: string;
  };
  decision: {
    strategy: string;
    angle: string;
    tone: string;
  };
  script: string;
  instructions: string[];
  packaging: {
    hookText: string;
    captionLines: string[];
    thumbnailText: string;
    musicType: string;
    hashtags: string[];
  };
  assetsPlan: {
    requiredAssets: string[];
    optionalAssets: string[];
    guidance: string;
  };
};

export default function Page() {
  const router = useRouter();

  const [flowData, setFlowData] = useState<ContentFlowData | null>(null);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  useEffect(() => {
    if (!flowData) return;

    let cancelled = false;

    async function run() {
      try {
        setLoading(true);
        setError("");

        const token =
          typeof window !== "undefined"
            ? localStorage.getItem("token") || ""
            : "";

        const res = await fetch("/api/video/plan", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(flowData),
        });

        const json = await res.json();

        if (!res.ok) {
          throw new Error(json?.error || "Failed to build plan");
        }

        if (!cancelled) {
          setPlan(json);

          localStorage.setItem(
            "content_flow",
            JSON.stringify({
              ...flowData,
              ...json,
            })
          );
        }
      } catch {
        if (!cancelled) {
          setError("משהו השתבש בבניית התוכן");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [flowData]);

  function handleContinue() {
    router.push("/content/assets");
  }

  if (loading) {
    return (
      <div style={baseStyles.page}>
        <Header title="בניית תוכן" />
        <ProgressBar progress={95} />

        <div style={loadingWrap}>
          <h1>בונים עבורך את התוכן...</h1>
          <p style={{ color: "#555" }}>
            המערכת מנתחת את הבחירות שלך ומכינה כיוון מדויק
          </p>
        </div>
      </div>
    );
  }

  if (error || !plan || !flowData) {
    return (
      <div style={baseStyles.page}>
        <Header title="בניית תוכן" />
        <ProgressBar progress={95} />

        <div style={baseStyles.container}>
          <div style={errorCard}>{error || "שגיאה בטעינת התוכן"}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={baseStyles.page}>
      <Header title="התוכן שלך מוכן" />
      <ProgressBar progress={95} />

      <div style={baseStyles.container}>
        <div style={card}>
          <h2 style={h2}>סוג תוכן</h2>
          <div style={value}>{mapFormat(flowData.selectedFormat)}</div>
        </div>

        <div style={card}>
          <h2 style={h2}>סוג תוכן מוביל</h2>
          <div style={value}>{plan.videoType?.label}</div>
        </div>

        <div style={card}>
          <h2 style={h2}>תסריט</h2>
          <pre style={script}>{plan.script}</pre>
        </div>

        <div style={card}>
          <h2 style={h2}>איך לבצע</h2>
          {plan.instructions.map((item, idx) => (
            <div key={idx} style={instruction}>
              • {item}
            </div>
          ))}
        </div>

        <div style={card}>
          <h2 style={h2}>איך לחזק את התוכן</h2>

          <div style={section}>
            <div style={label}>פתיחה</div>
            <div style={value}>{plan.packaging.hookText}</div>
          </div>

          <div style={section}>
            <div style={label}>טקסטים</div>
            {plan.packaging.captionLines.map((line, idx) => (
              <div key={idx} style={caption}>
                {line}
              </div>
            ))}
          </div>

          <div style={section}>
            <div style={label}>טקסט מוביל</div>
            <div style={value}>{plan.packaging.thumbnailText}</div>
          </div>

          <div style={section}>
            <div style={label}>אווירה</div>
            <div style={value}>{plan.packaging.musicType}</div>
          </div>
        </div>

        <div style={card}>
          <h2 style={h2}>מה צריך להכין</h2>

          {plan.assetsPlan.requiredAssets.map((item, idx) => (
            <div key={idx} style={instruction}>
              • {item}
            </div>
          ))}

          {plan.assetsPlan.optionalAssets.length > 0 && (
            <>
              <div style={subLabel}>אופציונלי</div>
              {plan.assetsPlan.optionalAssets.map((item, idx) => (
                <div key={idx} style={instruction}>
                  • {item}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div style={baseStyles.footer}>
        <button style={baseStyles.cta} onClick={handleContinue}>
          המשך להכנת התוכן
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

const loadingWrap = {
  minHeight: "70vh",
  display: "flex",
  flexDirection: "column" as const,
  justifyContent: "center",
  alignItems: "center",
  textAlign: "center" as const,
};

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

const script = {
  whiteSpace: "pre-wrap" as const,
};

const instruction = {
  marginBottom: 6,
};

const section = {
  marginTop: 12,
};

const label = {
  fontWeight: 600,
  marginBottom: 4,
};

const caption = {
  background: "#f3f4f6",
  padding: 8,
  borderRadius: 8,
  marginBottom: 4,
};

const subLabel = {
  marginTop: 10,
  fontWeight: 600,
};

const errorCard = {
  background: "#fee2e2",
  padding: 16,
  borderRadius: 12,
  color: "#991b1b",
};