export default function ReviewTrustChecklistItem({ children }: { children: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: "#ff8a2a", fontWeight: 950, lineHeight: 1.5 }}>✓</span>
      <span style={{ color: "#4f5f81", fontSize: 13, fontWeight: 750, lineHeight: 1.55 }}>
        {children}
      </span>
    </div>
  );
}
