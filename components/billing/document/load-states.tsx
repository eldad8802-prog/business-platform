"use client";

/**
 * Billing document load states — skeleton, error and not-found.
 *
 * Extracted verbatim from `app/billing/[id]/page.tsx` (B1, mechanical
 * decomposition): same components, same behavior, different file boundary.
 */
import Link from "next/link";
import { TOKEN } from "@/lib/design/billing-theme";

export function WorkspaceSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      style={{ display: "grid", gap: 12 }}
    >
      {[120, 100, 220].map((h, i) => (
        <div
          key={i}
          aria-hidden="true"
          style={{
            height: h,
            borderRadius: 14,
            background:
              "linear-gradient(90deg, rgba(239, 241, 235,1) 0%, rgba(252, 252, 250,1) 50%, rgba(239, 241, 235,1) 100%)",
            backgroundSize: "200% 100%",
            animation: "billing-skeleton 1.2s ease-in-out infinite",
            border: `1px solid ${TOKEN.border.DEFAULT}`,
          }}
        />
      ))}
      <style>{`
        @keyframes billing-skeleton {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

export function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        background: TOKEN.semantic.urgent.bg,
        border: `1px solid ${TOKEN.semantic.urgent.border}`,
        color: TOKEN.semantic.urgent.ink,
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 15 }}>שגיאה בטעינת המסמך</div>
      <div style={{ fontSize: 14, lineHeight: 1.5 }}>{message}</div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          alignSelf: "flex-start",
          padding: "8px 14px",
          borderRadius: 10,
          border: `1px solid ${TOKEN.semantic.urgent.ink}`,
          background: TOKEN.semantic.urgent.ink,
          color: TOKEN.ink.inverse,
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        נסה שוב
      </button>
    </div>
  );
}

export function NotFoundCard() {
  return (
    <div
      style={{
        background: TOKEN.surface.card,
        border: `1px dashed ${TOKEN.border.hover}`,
        borderRadius: 14,
        padding: "32px 16px",
        textAlign: "center",
        color: TOKEN.ink.secondary,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600 }}>המסמך לא נמצא</div>
      <div style={{ fontSize: 14 }}>
        ייתכן שהקישור שגוי או שהמסמך הוסר.
      </div>
      <Link
        href="/billing"
        style={{
          padding: "8px 16px",
          borderRadius: 10,
          border: `1px solid ${TOKEN.brand.mid}`,
          background: TOKEN.action.primary.background,
          color: TOKEN.ink.inverse,
          fontSize: 14,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        חזרה לרשימת המסמכים
      </Link>
    </div>
  );
}
