"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

export default function Page() {
  const router = useRouter();
  const params = useSearchParams();

  const goal = params.get("goal");
  const intent = params.get("intent");

  const [value, setValue] = useState("");

  function next() {
    if (!value) return;
    router.push(
      `/content/style?goal=${goal}&intent=${intent}&value=${value}`
    );
  }

  return (
    <div style={baseStyles.page}>
      <ProgressBar progress={33} />

      <div style={baseStyles.container}>
        <h1>איזה סוג תוכן?</h1>

        {card("offer", "הצעה")}
        {card("value", "ערך")}
        {card("proof", "הוכחה")}
      </div>

      <div style={baseStyles.footer}>
        <button style={baseStyles.cta} onClick={next}>
          המשך
        </button>
      </div>
    </div>
  );

  function card(val: string, text: string) {
    const selected = value === val;

    return (
      <div onClick={() => setValue(val)} style={btn(selected)}>
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