export default function ReviewTrustChecklistItem({ children }: { children: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: "#22c55e", fontWeight: 950, lineHeight: 1.5 }}>✓</span>
      <span style={{ color: "#475569", fontSize: 12, fontWeight: 800, lineHeight: 1.55 }}>
        {children}
      </span>
    </div>
  );
}
