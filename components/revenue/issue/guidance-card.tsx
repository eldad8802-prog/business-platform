"use client";

type Guidance = {
  why: string;
  tip: string;
  example: string;
  caution: string;
};

export default function GuidanceCard({ guidance }: { guidance: Guidance }) {
  return (
    <div
      style={{
        background: "var(--dz-surface)",
        borderRadius: 24,
        border: "1px solid var(--dz-border)",
        padding: 20,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          marginBottom: 12,
          color: "var(--dz-text-primary)",
        }}
      >
        קופון שיכול להתאים לעסק שלך
      </div>

      <div style={{ display: "grid", gap: 10, fontSize: 14, lineHeight: 1.6 }}>
        <div>
          <strong>למה זה יכול לעבוד אצלך</strong>
          <div style={{ color: "var(--dz-text-secondary)" }}>{guidance.why}</div>
        </div>

        <div>
          <strong>טיפ חכם</strong>
          <div style={{ color: "var(--dz-text-secondary)" }}>{guidance.tip}</div>
        </div>

        <div>
          <strong>דוגמה</strong>
          <div style={{ color: "var(--dz-text-secondary)" }}>{guidance.example}</div>
        </div>

        <div>
          <strong>ממה להיזהר</strong>
          <div style={{ color: "var(--dz-danger)" }}>{guidance.caution}</div>
        </div>
      </div>
    </div>
  );
}