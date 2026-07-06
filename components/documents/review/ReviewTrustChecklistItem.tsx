import { TOKEN } from "@/lib/design/documents-theme";

export default function ReviewTrustChecklistItem({ children }: { children: string }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 18,
          height: 18,
          marginTop: 1,
          borderRadius: 999,
          background: TOKEN.brand.soft,
          color: TOKEN.brand.mid,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden focusable="false">
          <path
            d="M2.5 6.2 4.7 8.5 9.5 3.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span style={{ color: TOKEN.ink.secondary, fontSize: 13, fontWeight: 750, lineHeight: 1.55 }}>
        {children}
      </span>
    </div>
  );
}
