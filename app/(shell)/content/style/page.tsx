"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";

function ContentStylePageInner() {
  const router = useRouter();
  const params = useSearchParams();

  const goal = params.get("goal");
  const intent = params.get("intent");
  const value = params.get("value");

  const [style, setStyle] = useState("");

  function next() {
    if (!style) return;

    router.push(
      `/content/mode?goal=${goal}&intent=${intent}&value=${value}&style=${style}`
    );
  }

  function card(val: string, text: string) {
    const selected = style === val;

    return (
      <div onClick={() => setStyle(val)} style={btn(selected)}>
        {text}
      </div>
    );
  }

  return (
    <div style={baseStyles.page}>
      <ProgressBar progress={50} />

      <div style={baseStyles.container}>
        <h1>בחר סגנון</h1>

        {card("direct", "ישיר")}
        {card("emotional", "רגשי")}
        {card("authority", "מקצועי")}
      </div>

      <div style={baseStyles.footer}>
        <button style={baseStyles.cta} onClick={next}>
          המשך
        </button>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ContentStylePageInner />
    </Suspense>
  );
}

const btn = (selected: boolean) => ({
  padding: 14,
  borderRadius: 12,
  border: selected ? "2px solid #111" : "1px solid #ddd",
  marginTop: 10,
  cursor: "pointer",
});