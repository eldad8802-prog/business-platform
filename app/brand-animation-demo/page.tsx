"use client";

import { useEffect, useState } from "react";
import { DubizLogoAnimation } from "@/components/brand/dubiz-logo-animation";

/**
 * Internal, isolated demo for the Dubiz brand intro animation.
 * Not linked from the product; nothing here touches auth/DB/API/app shell.
 * View at /brand-animation-demo.
 */
export default function BrandAnimationDemoPage() {
  const [runId, setRunId] = useState(0);
  const [width, setWidth] = useState(360);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const compute = () =>
      setWidth(Math.round(Math.min(460, Math.max(240, window.innerWidth * 0.8))));
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  const replay = () => {
    setDone(false);
    setRunId((n) => n + 1);
  };

  return (
    <div
      dir="rtl"
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        padding: 24,
        background:
          "radial-gradient(circle at 50% 38%, #0F3C39 0%, #0A2A28 55%, #061716 100%)",
        color: "#CFF0EC",
        fontFamily: "inherit",
        textAlign: "center",
      }}
    >
      <div
        style={{
          height: Math.round(width * (266 / 827)),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <DubizLogoAnimation
          key={runId}
          width={width}
          duration={1500}
          onDone={() => setDone(true)}
        />
      </div>

      <button
        type="button"
        onClick={replay}
        style={{
          minHeight: 46,
          padding: "10px 22px",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.28)",
          background:
            "linear-gradient(90deg, #0F6F68 0%, #2EAAA2 55%, #8FE3DA 100%)",
          color: "#fff",
          fontFamily: "inherit",
          fontSize: 15,
          fontWeight: 700,
          cursor: "pointer",
          boxShadow: "0 12px 30px rgba(46,170,162,0.32)",
        }}
      >
        הפעל שוב
      </button>

      <div style={{ maxWidth: 460, fontSize: 13, lineHeight: 1.7, opacity: 0.72 }}>
        <p style={{ margin: "0 0 6px" }}>
          דמו מבודד · Canvas 2D · ללא תלות חדשה · משתמש ב־<code>/dubiz-logo.png</code> הקיים (קריאה בלבד).
        </p>
        <p style={{ margin: 0 }}>
          מכבד <code>prefers-reduced-motion</code>: במצב תנועה מופחתת יוצג לוגו סטטי בלבד.
          {done ? " · ✓ הסתיים" : ""}
        </p>
      </div>
    </div>
  );
}
