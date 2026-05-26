"use client";

import type { CSSProperties, ReactNode } from "react";

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
    borderRadius: 12,
    background: "#e5e7eb",
    height,
    width,
    animation: "documentsSkeletonPulse 1.2s ease-in-out infinite",
  };
}

export function documentsShellCard(padding = 16): CSSProperties {
  return {
    background: "#ffffff",
    border: "1px solid #dfe7f3",
    borderRadius: 18,
    padding,
    boxShadow: "0 10px 28px rgba(15, 23, 42, 0.06)",
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
