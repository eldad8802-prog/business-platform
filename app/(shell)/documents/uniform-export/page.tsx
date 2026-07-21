"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TOKEN, primaryActionStyle } from "@/lib/design/documents-theme";
import DocumentsBackButton from "@/components/documents/DocumentsBackButton";

function isoToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function isoMonthStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function UniformExportPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [from, setFrom] = useState(isoMonthStart());
  const [to, setTo] = useState(isoToday());
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.resolve().then(() => {
      const next = window.localStorage.getItem("token");
      if (!next) {
        router.replace("/login");
        return;
      }
      setToken(next);
    });
  }, [router]);

  async function handleGenerate() {
    if (!token) return;
    if (from > to) {
      setStatus("error");
      setError("תאריך ההתחלה מאוחר מתאריך הסיום");
      return;
    }
    try {
      setStatus("loading");
      setError("");
      const url = `/api/reports/uniform?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        throw new Error(response.status === 400 ? "טווח תאריכים לא תקין" : "שגיאה בהפקת הקבצים");
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = "uniform-export.zip";
      link.click();
      window.URL.revokeObjectURL(objectUrl);
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setError(errorMessage(err, "שגיאה"));
    }
  }

  const loading = status === "loading";

  return (
    <div dir="rtl" style={pageStyle}>
      <main style={mainStyle}>
        <header style={headStyle}>
          <DocumentsBackButton onClick={() => router.push("/documents")} />
          <h1 style={titleStyle}>הפקת מבנה אחיד</h1>
          <div aria-hidden style={{ width: 52 }} />
        </header>

        <section>
          <div style={labelStyle}>מתאריך</div>
          <label style={fieldStyle}>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
              aria-label="מתאריך"
              className="dz-native-date"
              style={inputStyle}
            />
          </label>
        </section>

        <section style={{ marginTop: 14 }}>
          <div style={labelStyle}>עד תאריך</div>
          <label style={fieldStyle}>
            <input
              type="date"
              value={to}
              min={from}
              onChange={(event) => setTo(event.target.value)}
              aria-label="עד תאריך"
              className="dz-native-date"
              style={inputStyle}
            />
          </label>
        </section>

        <section style={{ marginTop: 18 }}>
          <div style={hintStyle}>
            הקובץ יופק עבור המסמכים שהונפקו בטווח שנבחר ויורד כקובץ ZIP הכולל את
            INI.TXT, BKMVDATA וכן דוחות 2.6 ו‑5.4.
          </div>
        </section>

        {status === "success" ? (
          <div style={successStyle}>הקבצים הופקו והורדו בהצלחה.</div>
        ) : null}
        {status === "error" ? <div style={errorStyle}>{error}</div> : null}
      </main>

      <div style={bottomBarStyle}>
        <button
          type="button"
          disabled={loading}
          onClick={() => void handleGenerate()}
          style={{
            ...downloadButtonStyle,
            opacity: loading ? 0.7 : 1,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "מפיק קבצים..." : "הפקת קבצים (ZIP)"}
        </button>
      </div>
    </div>
  );
}

const pageStyle = {
  minHeight: "100vh",
  background: TOKEN.surface.page,
  color: TOKEN.ink.primary,
  paddingBottom: 110,
} as const;

const mainStyle = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "14px 14px 40px",
  boxSizing: "border-box",
} as const;

const headStyle = {
  display: "grid",
  gridTemplateColumns: "auto 1fr 52px",
  alignItems: "center",
  gap: 10,
  marginBottom: 20,
} as const;

const titleStyle = {
  margin: 0,
  textAlign: "center",
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.display,
  fontWeight: TOKEN.weight.bold,
  lineHeight: 1.25,
} as const;

const labelStyle = {
  color: TOKEN.ink.secondary,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  marginBottom: 10,
} as const;

const fieldStyle = {
  minHeight: 52,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: "0 14px",
  display: "flex",
  alignItems: "center",
} as const;

const inputStyle = {
  width: "100%",
  border: "none",
  outline: "none",
  background: "transparent",
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
} as const;

const hintStyle = {
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  lineHeight: 1.6,
} as const;

const noticeBase = {
  minHeight: 52,
  marginTop: 18,
  padding: "0 14px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  lineHeight: 1.5,
  borderRadius: TOKEN.radius.card,
} as const;

const successStyle = {
  ...noticeBase,
  border: `1px solid ${TOKEN.semantic.success.border}`,
  background: TOKEN.semantic.success.bgSoft,
  color: TOKEN.semantic.success.ink,
} as const;

const errorStyle = {
  ...noticeBase,
  border: `1px solid ${TOKEN.semantic.urgent.border}`,
  background: TOKEN.semantic.urgent.bgSoft,
  color: TOKEN.semantic.urgent.ink,
} as const;

const bottomBarStyle = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  background: TOKEN.surface.card,
  borderTop: `1px solid ${TOKEN.border.DEFAULT}`,
  padding: "12px 14px 22px",
  boxShadow: TOKEN.shadow.floating,
} as const;

const downloadButtonStyle = {
  ...primaryActionStyle({ height: 52 }),
  width: "min(492px, 100%)",
  minHeight: 52,
  margin: "0 auto",
  display: "block",
  fontSize: TOKEN.font.body,
} as const;
