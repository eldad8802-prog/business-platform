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

  const [intent, setIntent] = useState("");

  function next() {
    if (!intent) return;

    router.push(
      `/content/mode?goal=${encodeURIComponent(
        goal
      )}&goalDescription=${encodeURIComponent(
        goalDescription
      )}&intent=${encodeURIComponent(intent)}`
    );
  }

  return (
    <div style={baseStyles.page}>
      <Header title="פוקוס" />
      <ProgressBar progress={25} />

      <div style={baseStyles.container}>
        <h1 style={{ marginBottom: 8 }}>מה הפוקוס של הסרטון?</h1>

        <p style={{ marginBottom: 20, color: "#555" }}>
          בחר איך אתה רוצה שאנשים יגיבו לסרטון
        </p>

        {card("message", "לשלוח הודעה")}
        {card("call", "להתקשר")}
        {card("follow", "לעקוב")}
        {card("watch", "לצפות")}
      </div>

      <div style={baseStyles.footer}>
        <button
          style={{
            ...baseStyles.cta,
            opacity: intent ? 1 : 0.5,
          }}
          onClick={next}
          disabled={!intent}
        >
          המשך
        </button>
      </div>
    </div>
  );

  function card(val: string, text: string) {
    const selected = intent === val;

    return (
      <div onClick={() => setIntent(val)} style={btn(selected)}>
        {text}
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