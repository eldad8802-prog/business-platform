import { TOKEN } from "@/lib/design/documents-theme";

export default function ReviewTrustChecklistItem({ children }: { children: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: TOKEN.brand.mid, fontWeight: 600, lineHeight: 1.5 }}>ג“</span>
      <span style={{ color: TOKEN.ink.secondary, fontSize: 13, fontWeight: 750, lineHeight: 1.55 }}>
        {children}
      </span>
    </div>
  );
}

