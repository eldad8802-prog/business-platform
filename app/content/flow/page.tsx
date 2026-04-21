"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { baseStyles } from "@/lib/styles/baseStyles";
export default function FlowPage() {
  const router = useRouter();
  const params = useSearchParams();

  const [goal, setGoal] = useState("");
  const [audience, setAudience] = useState("");
  const [valueType, setValueType] = useState("");
  const [style, setStyle] = useState("");

  const canContinue = goal && valueType && style;

  function handleContinue() {
    if (!canContinue) return;

    const query = new URLSearchParams({
      type: params.get("type") || "",
      category: params.get("category") || "",
      goal,
      audience,
      valueType,
      style,
    });

    router.push(`/content/mode?${query.toString()}`);
  }

  const Button = ({
    label,
    value,
    selected,
    onClick,
  }: {
    label: string;
    value: string;
    selected: boolean;
    onClick: () => void;
  }) => (
    <button
      onClick={onClick}
      style={{
        padding: "12px 16px",
        borderRadius: 12,
        border: selected ? "2px solid #111" : "1px solid #ddd",
        background: selected ? "#111" : "#fff",
        color: selected ? "#fff" : "#111",
        cursor: "pointer",
        fontWeight: 600,
        minWidth: 100,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ padding: 24, maxWidth: 500, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 20 }}>מה אתה רוצה להשיג?</h1>

      {/* GOAL */}
      <div style={{ marginBottom: 20 }}>
        <p>מטרה</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Button
            label="להביא פניות"
            value="leads"
            selected={goal === "leads"}
            onClick={() => setGoal("leads")}
          />
          <Button
            label="לבנות אמון"
            value="trust"
            selected={goal === "trust"}
            onClick={() => setGoal("trust")}
          />
          <Button
            label="למכור"
            value="sales"
            selected={goal === "sales"}
            onClick={() => setGoal("sales")}
          />
        </div>
      </div>

      {/* AUDIENCE */}
      <div style={{ marginBottom: 20 }}>
        <p>קהל יעד</p>
        <input
          placeholder="למשל: בעלי דירות לפני מעבר"
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 10,
            border: "1px solid #ddd",
          }}
        />
      </div>

      {/* VALUE */}
      <div style={{ marginBottom: 20 }}>
        <p>סוג תוכן</p>
        <div style={{ display: "flex", gap: 10 }}>
          <Button
            label="הצעה"
            value="offer"
            selected={valueType === "offer"}
            onClick={() => setValueType("offer")}
          />
          <Button
            label="ערך"
            value="value"
            selected={valueType === "value"}
            onClick={() => setValueType("value")}
          />
          <Button
            label="הוכחה"
            value="proof"
            selected={valueType === "proof"}
            onClick={() => setValueType("proof")}
          />
        </div>
      </div>

      {/* STYLE */}
      <div style={{ marginBottom: 30 }}>
        <p>סגנון</p>
        <div style={{ display: "flex", gap: 10 }}>
          <Button
            label="ישיר"
            value="direct"
            selected={style === "direct"}
            onClick={() => setStyle("direct")}
          />
          <Button
            label="רגשי"
            value="emotional"
            selected={style === "emotional"}
            onClick={() => setStyle("emotional")}
          />
          <Button
            label="מקצועי"
            value="professional"
            selected={style === "professional"}
            onClick={() => setStyle("professional")}
          />
        </div>
      </div>

      {/* CONTINUE */}
      <button
        onClick={handleContinue}
        disabled={!canContinue}
        style={{
          width: "100%",
          padding: 14,
          borderRadius: 12,
          border: "none",
          background: canContinue ? "#111" : "#ccc",
          color: "#fff",
          fontWeight: 700,
          cursor: canContinue ? "pointer" : "not-allowed",
        }}
      >
        המשך
      </button>
    </div>
  );
}