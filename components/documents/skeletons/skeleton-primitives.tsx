"use client";

import type { CSSProperties, ReactNode } from "react";
import { TOKEN } from "@/lib/design/tokens";

export const skeletonPulseKeyframes = `
  @keyframes documentsSkeletonPulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 0.95; }
  }
`;

export function SkeletonPulseStyles() {
  return <style>{skeletonPulseKeyframes}</style>;
}

export function skeletonBar(width: string | number, height = 14): CSSProperties {
  return {
    borderRadius: TOKEN.radius.pill,
    background: TOKEN.surface.inset,
    height,
    width,
    animation: "documentsSkeletonPulse 1.2s ease-in-out infinite",
  };
}

export function documentsShellCard(padding = 16): CSSProperties {
  return {
    background: TOKEN.surface.card,
    border: `1px solid ${TOKEN.border.DEFAULT}`,
    borderRadius: TOKEN.radius.card,
    padding,
    boxShadow: TOKEN.shadow.elevated,
  };
}

export function SkeletonBlock({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div dir="rtl" style={{ display: "flex", flexDirection: "column", gap: 12, ...style }}>
      <SkeletonPulseStyles />
      {children}
    </div>
  );
}
