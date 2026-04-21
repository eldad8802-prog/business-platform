"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

export default function Page() {
  const router = useRouter();

  const [goal, setGoal] = useState("");
  const [goalDescription, setGoalDescription] = useState("");

  function next() {
    if (!goal || !goalDescription.trim()) return;

    router.push(
      `/content/intent?goal=${goal}&goalDescription=${encodeURIComponent(
        goalDescription
      )}`
    );
  }

  return (
    <div style={baseStyles.page}>
      <Header title="מטרה" />
      <ProgressBar progress={10} />

      <div style={baseStyles.container}>
        <h1 style={{ marginBottom: 8 }}>מה אתה רוצה להשיג מהסרטון?</h1>

        <p style={{ marginBottom: 20, color: "#555" }}>
          בחר מטרה ותפרט מה היית רוצה שיקרה בפועל
        </p>

        {card("leads", "לקבל פניות")}
        {card("customers", "להביא לקוחות")}
        {card("exposure", "להגדיל חשיפה")}
        {card("trust", "לבנות אמון")}

        {goal && (
          <div style={{ marginTop: 20 }}>
            <p style={{ marginBottom: 8, fontWeight: 600 }}>
              תפרט במשפט מה אתה רוצה שיקרה
            </p>

            <textarea
              value={goalDescription}
              onChange={(e) => setGoalDescription(e.target.value)}
              placeholder="לדוגמה: שיפנו אליי בוואטסאפ לגבי השירות שלי"
              style={{
                width: "100%",
                minHeight: 100,
                padding: 14,
                borderRadius: 12,
                border: "1px solid #ddd",
                fontSize: 14,
              }}
            />
          </div>
        )}
      </div>

      <div style={baseStyles.footer}>
        <button
          style={{
            ...baseStyles.cta,
            opacity: goal && goalDescription.trim() ? 1 : 0.5,
          }}
          onClick={next}
          disabled={!goal || !goalDescription.trim()}
        >
          המשך
        </button>
      </div>
    </div>
  );

  function card(val: string, text: string) {
    const selected = goal === val;

    return (
      <div onClick={() => setGoal(val)} style={btn(selected)}>
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