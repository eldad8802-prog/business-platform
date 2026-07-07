"use client";

import { useEffect, useState } from "react";
import { DubizBearIntro } from "@/components/brand/dubiz-bear-intro";

/**
 * Internal, isolated demo for the Dubiz "chaos → order" brand intro.
 * Not linked from the product; nothing here touches auth/DB/API/app shell.
 * View at /brand-animation-demo.
 */
export default function BrandAnimationDemoPage() {
  const [width, setWidth] = useState(460);
  const [loop, setLoop] = useState(true);
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    const compute = () =>
      setWidth(Math.round(Math.min(560, Math.max(280, window.innerWidth * 0.86))));
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  return (
    <div
      dir="rtl"
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 26,
        padding: 24,
        background:
          "radial-gradient(circle at 50% 38%, #FDFBF6 0%, #F5EFE2 58%, #EDE4D3 100%)",
        color: "#2D4B47",
        fontFamily: "inherit",
        textAlign: "center",
      }}
    >
      <div style={{ height: Math.round(width * 0.72), display: "flex", alignItems: "center", justifyContent: "center" }}>
        <DubizBearIntro key={`${runId}-${loop}`} width={width} loop={loop} />
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
        <button type="button" onClick={() => setRunId((n) => n + 1)} style={btn(true)}>
          הפעל שוב
        </button>
        <button type="button" onClick={() => { setLoop((v) => !v); setRunId((n) => n + 1); }} style={btn(false)}>
          {loop ? "פעם אחת" : "לולאה"}
        </button>
      </div>

      <div style={{ maxWidth: 520, fontSize: 13, lineHeight: 1.7, opacity: 0.72 }}>
        <p style={{ margin: "0 0 6px" }}>
          פרוטוטייפ מבודד · Canvas 2D · נקודות טורקיז + נגיעות זהב · ללא תלות · קורא את <code>/dubiz-logo.png</code> בלבד.
        </p>
        <p style={{ margin: 0 }}>
          כאוס → דובי → חיים (עיניים/חיוך/נפנוף) → פיזור → מערבולת → D → כיתוב → לוגו.
          מכבד <code>prefers-reduced-motion</code> (לוגו סטטי). לא מחובר ל-login/shell.
        </p>
      </div>
    </div>
  );
}

function btn(primary: boolean): React.CSSProperties {
  return {
    minHeight: 44,
    padding: "9px 20px",
    borderRadius: 999,
    border: primary ? "1px solid rgba(255,255,255,0.3)" : "1px solid rgba(15,111,104,0.28)",
    background: primary
      ? "linear-gradient(90deg, #0F6F68 0%, #2EAAA2 55%, #8FE3DA 100%)"
      : "rgba(15,111,104,0.06)",
    color: primary ? "#fff" : "#0F6F68",
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: primary ? "0 12px 30px rgba(46,170,162,0.32)" : "none",
  };
}
