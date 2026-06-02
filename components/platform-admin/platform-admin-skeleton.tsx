"use client";

import { TOKEN } from "@/lib/design/tokens";
import { PA } from "./platform-admin-styles";

function Block({ height = 48 }: { height?: number }) {
  return (
    <div
      style={{
        height,
        borderRadius: PA.radius,
        background: TOKEN.surface.inset,
        animation: "pa-pulse 1.4s ease-in-out infinite",
      }}
    />
  );
}

export function PlatformAdminSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: PA.gap }}>
      <style>{`
        @keyframes pa-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
      `}</style>
      <Block height={56} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: 12,
        }}
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <Block key={i} height={72} />
        ))}
      </div>
      <Block height={160} />
      <Block height={200} />
      <Block height={240} />
    </div>
  );
}
