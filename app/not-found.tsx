import Link from "next/link";

export default function NotFound() {
  return (
    <div
      dir="rtl"
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: "#f0f4f8",
        color: "#0f172a",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: 20,
          boxShadow: "0 18px 50px rgba(15, 23, 42, 0.10)",
          padding: "32px 24px",
          textAlign: "center",
          boxSizing: "border-box",
        }}
      >
        <div
          aria-hidden
          style={{
            width: 56,
            height: 56,
            margin: "0 auto 18px",
            borderRadius: 16,
            background: "linear-gradient(135deg, #243b57, #3F619C)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 22,
            fontWeight: 900,
          }}
        >
          ?
        </div>
        <div style={{ fontSize: 44, fontWeight: 950, letterSpacing: "-1px", lineHeight: 1 }}>404</div>
        <h1 style={{ margin: "12px 0 6px", fontSize: 20, fontWeight: 900 }}>הדף לא נמצא</h1>
        <p style={{ margin: "0 0 22px", fontSize: 14, fontWeight: 600, color: "#64748b", lineHeight: 1.6 }}>
          הקישור שגוי או שהדף הוסר. אפשר לחזור לעמוד הראשי ולהמשיך מכאן.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Link
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 48,
              borderRadius: 12,
              background: "#243b57",
              color: "#fff",
              fontSize: 15,
              fontWeight: 900,
              textDecoration: "none",
            }}
          >
            חזרה לעמוד הראשי
          </Link>
          <Link
            href="/inventory"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 46,
              borderRadius: 12,
              border: "1px solid #e2e8f0",
              background: "#fff",
              color: "#0f172a",
              fontSize: 14,
              fontWeight: 800,
              textDecoration: "none",
            }}
          >
            למסך המלאי
          </Link>
        </div>
      </div>
    </div>
  );
}
