"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

export default function Page() {
  const router = useRouter();
  const params = useSearchParams();

  const goal = params.get("goal") || "";
  const goalDescription = params.get("goalDescription") || "";
  const intent = params.get("intent") || "";

  const [mode, setMode] = useState("");

  function next() {
    if (!mode) return;

    router.push(
      `/content/context?goal=${encodeURIComponent(
        goal
      )}&goalDescription=${encodeURIComponent(
        goalDescription
      )}&intent=${encodeURIComponent(intent)}&mode=${encodeURIComponent(mode)}`
    );
  }

  return (
    <div style={baseStyles.page}>
      <Header title="איך ליצור" />
      <ProgressBar progress={50} />

      <div style={baseStyles.container}>
        <h1 style={{ marginBottom: 8 }}>איך תרצה ליצור את הסרטון?</h1>

        <p style={{ marginBottom: 20, color: "#555" }}>
          בחר את הדרך שהכי נוחה לך לעבוד
        </p>

        {card("camera", "אני מצטלם", "אני אצטלם בעצמי לפי הנחיות")}
        {card("voice", "קריינות", "המערכת תיצור סרטון עם קריינות")}
        {card("ai", "תיצור לי", "המערכת תיצור הכל בשבילי")}
      </div>

      <div style={baseStyles.footer}>
        <button
          style={{
            ...baseStyles.cta,
            opacity: mode ? 1 : 0.5,
          }}
          onClick={next}
          disabled={!mode}
        >
          המשך
        </button>
      </div>
    </div>
  );

  function card(val: string, title: string, description: string) {
    const selected = mode === val;

    return (
      <div onClick={() => setMode(val)} style={btn(selected)}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 14, color: "#555" }}>{description}</div>
      </div>
    );
  }
}

const btn = (selected: boolean) => ({
  padding: 14,
  borderRadius: 12,
  border: selected ? "2px solid #111" : "1px solid #ddd",
  marginTop: 10,
  cursor: "pointer",
});