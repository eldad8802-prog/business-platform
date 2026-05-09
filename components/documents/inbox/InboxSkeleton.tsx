"use client";

import type { CSSProperties } from "react";
import { card } from "@/app/documents/ui";

const BAR: CSSProperties = {
  borderRadius: 12,
  background: "#e5e7eb",
  height: 14,
  animation: "pulse 1.2s ease-in-out infinite",
};

const BLOCK: CSSProperties = {
  ...card,
  padding: 16,
};

export default function InboxSkeleton() {
  return (
    <div dir="rtl" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 0.95; }
        }
      `}</style>
      <div style={{ ...BLOCK, height: 120 }} />
      <div style={BLOCK}>
        <div style={{ ...BAR, width: "45%", marginBottom: 12 }} />
        <div style={{ ...BAR, width: "70%", marginBottom: 10 }} />
        <div style={{ ...BAR, width: "35%" }} />
      </div>
      <div style={BLOCK}>
        <div style={{ ...BAR, width: "55%", marginBottom: 12 }} />
        <div style={{ ...BAR, width: "80%" }} />
      </div>
    </div>
  );
}
