"use client";

type Guidance = {
  tip: string;
  example: string;
  insight: string;
};

export default function OfferGuidanceCard({
  guidance,
}: {
  guidance: Guidance;
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: 20,
        padding: 18,
        border: "1px solid #e5e7eb",
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontWeight: 800,
          marginBottom: 12,
          fontSize: 16,
          color: "#111827",
        }}
      >
        מה כדאי לדעת לפני שיוצרים קופון
      </div>

      <div style={{ marginBottom: 12 }}>
        <strong>טיפ חכם</strong>
        <div
          style={{
            marginTop: 4,
            color: "#4b5563",
            lineHeight: 1.6,
            fontSize: 14,
          }}
        >
          {guidance.tip}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <strong>דוגמה מתאימה לעסק שלך</strong>
        <div
          style={{
            marginTop: 4,
            color: "#4b5563",
            lineHeight: 1.6,
            fontSize: 14,
          }}
        >
          {guidance.example}
        </div>
      </div>

      <div style={{ marginBottom: 0 }}>
        <strong>ממה להיזהר</strong>
        <div
          style={{
            marginTop: 4,
            color: "#4b5563",
            lineHeight: 1.6,
            fontSize: 14,
          }}
        >
          {guidance.insight}
        </div>
      </div>
    </div>
  );
}