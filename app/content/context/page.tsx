"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

export default function Page() {
  const router = useRouter();
  const params = useSearchParams();

  const goal = params.get("goal") || "";
  const goalDescription = params.get("goalDescription") || "";
  const intent = params.get("intent") || "";
  const mode = params.get("mode") || "";

  const [audienceDescription, setAudienceDescription] = useState("");
  const [ageRange, setAgeRange] = useState("");

  const isValidEntry = useMemo(() => {
    return !!goal && !!goalDescription && !!intent && !!mode;
  }, [goal, goalDescription, intent, mode]);

  useEffect(() => {
    if (!isValidEntry) {
      router.replace("/content");
    }
  }, [isValidEntry, router]);

  function handleContinue() {
    if (!audienceDescription.trim() || !ageRange) return;

    const contentFlow = {
      goal,
      goalDescription,
      intent,
      mode,
      audienceDescription: audienceDescription.trim(),
      ageRange,
    };

    localStorage.setItem("content_flow", JSON.stringify(contentFlow));
    router.push("/content/direction");
  }

  return (
    <div style={baseStyles.page}>
      <Header title="קהל יעד" />
      <ProgressBar progress={75} />

      <div style={baseStyles.container}>
        <h1 style={{ marginBottom: 8 }}>למי התוכן מיועד?</h1>

        <p style={{ marginBottom: 20, color: "#555" }}>
          תאר את הקהל שאתה רוצה למשוך כדי שנוכל לדייק את הכיוון
        </p>

        <p style={{ marginBottom: 8, fontWeight: 600 }}>תיאור הקהל</p>

        <textarea
          value={audienceDescription}
          onChange={(e) => setAudienceDescription(e.target.value)}
          placeholder="לדוגמה: נשים בגילאי 25–40 שרוצות לשפר את עור הפנים לפני אירוע"
          style={{
            width: "100%",
            minHeight: 120,
            padding: 16,
            borderRadius: 12,
            border: "1px solid #ddd",
            fontSize: 14,
            marginBottom: 20,
          }}
        />

        <p style={{ marginBottom: 8, fontWeight: 600 }}>טווח גילאים</p>

        {["18-25", "25-35", "35-50", "50+"].map((range) => (
          <div
            key={range}
            onClick={() => setAgeRange(range)}
            style={buttonStyle(ageRange === range)}
          >
            {range}
          </div>
        ))}
      </div>

      <div style={baseStyles.footer}>
        <button
          style={{
            ...baseStyles.cta,
            opacity: audienceDescription.trim() && ageRange ? 1 : 0.5,
          }}
          onClick={handleContinue}
          disabled={!audienceDescription.trim() || !ageRange}
        >
          המשך
        </button>
      </div>
    </div>
  );
}

const buttonStyle = (selected: boolean) => ({
  padding: 12,
  borderRadius: 10,
  border: selected ? "2px solid #111" : "1px solid #ddd",
  marginTop: 10,
  cursor: "pointer",
});