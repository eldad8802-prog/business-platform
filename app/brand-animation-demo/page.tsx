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
          "radial-gradient(circle at 50% 38%, var(--dz-surface-flat) 0%, var(--dz-surface-muted) 58%, var(--dz-surface-muted) 100%)",
        color: "var(--dz-text-primary)",
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
    border: primary ? "1px solid rgba(255,255,255,0.3)" : "1px solid rgba(36, 105, 102,0.28)",
    background: primary
      ? "linear-gradient(90deg, var(--dz-brand) 0%, var(--dz-brand) 55%, var(--dz-brand-soft-strong) 100%)"
      : "rgba(36, 105, 102,0.06)",
    color: primary ? "var(--dz-text-on-brand)" : "var(--dz-brand)",
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: primary ? "0 12px 30px rgba(36, 105, 102,0.32)" : "none",
  };
}
