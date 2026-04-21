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
        background: "#ffffff",
        borderRadius: 24,
        border: "1px solid #e5e7eb",
        padding: 20,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          marginBottom: 12,
          color: "#111827",
        }}
      >
        קופון שיכול להתאים לעסק שלך
      </div>

      <div style={{ display: "grid", gap: 10, fontSize: 14, lineHeight: 1.6 }}>
        <div>
          <strong>למה זה יכול לעבוד אצלך</strong>
          <div style={{ color: "#4b5563" }}>{guidance.why}</div>
        </div>

        <div>
          <strong>טיפ חכם</strong>
          <div style={{ color: "#4b5563" }}>{guidance.tip}</div>
        </div>

        <div>
          <strong>דוגמה</strong>
          <div style={{ color: "#4b5563" }}>{guidance.example}</div>
        </div>

        <div>
          <strong>ממה להיזהר</strong>
          <div style={{ color: "#b91c1c" }}>{guidance.caution}</div>
        </div>
      </div>
    </div>
  );
}