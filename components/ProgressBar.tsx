"use client";

export default function ProgressBar({ progress }: { progress: number }) {
  return (
    <div style={{ height: 4, background: "#e5e7eb" }}>
      <div
        style={{
          height: "100%",
          width: `${progress}%`,
          background: "#111",
        }}
      />
    </div>
  );
}