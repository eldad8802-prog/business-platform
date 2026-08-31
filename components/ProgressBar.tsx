"use client";

export default function ProgressBar({ progress }: { progress: number }) {
  return (
    <div style={{ height: 4, background: "var(--dz-surface-muted)" }}>
      <div
        style={{
          height: "100%",
          width: `${progress}%`,
          background: "var(--dz-text-primary)",
        }}
      />
    </div>
  );
}