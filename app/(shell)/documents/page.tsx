"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchDocumentsHubSummary,
  type DocumentsHubSnapshot,
} from "@/lib/documents/fetch-inbox";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: DocumentsHubSnapshot };

function formatMoney(n: number): string {
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: "ILS",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${Math.round(n).toLocaleString("he-IL")} ₪`;
  }
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  try {
    return new Intl.DateTimeFormat("he-IL", {
      month: "long",
      year: "numeric",
    }).format(new Date(y, m - 1, 1));
  } catch {
    return ym;
  }
}

function metricLabel(value: number): string {
  return Number.isFinite(value) ? String(value.toLocaleString("he-IL")) : "0";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const hubSkeletonBar = (width: string | number, height = 14) => ({
  borderRadius: 12,
  background: "#e5e7eb",
  height,
  width,
  animation: "documentsHubSkeletonPulse 1.2s ease-in-out infinite",
});

function HubLoadingPlaceholder() {
  const card = {
    background: "#ffffff",
    border: "1px solid #dfe7f3",
    borderRadius: 18,
    padding: 16,
    boxShadow: "0 10px 28px rgba(15, 23, 42, 0.06)",
  };
  return (
    <div dir="rtl" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <style>{`
        @keyframes documentsHubSkeletonPulse {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 0.95; }
        }
      `}</style>
      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={hubSkeletonBar("55%", 16)} />
            <div style={{ ...hubSkeletonBar("70%", 12), marginTop: 10 }} />
          </div>
          <div
            style={{
              width: 74,
              height: 74,
              borderRadius: 999,
              background: "#e5e7eb",
              flexShrink: 0,
              animation: "documentsHubSkeletonPulse 1.2s ease-in-out infinite",
            }}
          />
        </div>
      </section>
    </div>
  );
}

function mainShellStyle() {
  return {
    minHeight: "100vh",
    background: "#f3f7ff",
  };
}

function contentStyle() {
  return {
    maxWidth: 760,
    margin: "0 auto",
    padding: "18px 14px 40px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
    boxSizing: "border-box" as const,
  };
}

function cardStyle() {
  return {
    background: "#ffffff",
    border: "1px solid #dfe7f3",
    borderRadius: 18,
    padding: 16,
    boxShadow: "0 10px 28px rgba(15, 23, 42, 0.06)",
  };
}

function primaryButtonStyle(disabled = false) {
  return {
    width: "100%",
    minHeight: 48,
    border: "none",
    borderRadius: 9,
    background: "#002b6b",
    color: "#ffffff",
    fontSize: 15,
    fontWeight: 950,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.65 : 1,
  };
}

function secondaryButtonStyle() {
  return {
    width: "100%",
    minHeight: 44,
    border: "1px solid #dfe7f3",
    borderRadius: 10,
    background: "#ffffff",
    color: "#002b6b",
    fontSize: 14,
    fontWeight: 900,
    cursor: "pointer",
  };
}

function MetricTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div
      style={{
        border: "1px solid #dfe7f3",
        borderRadius: 12,
        background: "#ffffff",
        padding: 12,
        minWidth: 0,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 800 }}>
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 22,
          color: "#0f172a",
          fontWeight: 950,
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 12,
          color: "#9ca3af",
          fontWeight: 700,
          lineHeight: 1.4,
        }}
      >
        {hint}
      </div>
    </div>
  );
}

function IntakeTile({
  icon,
  title,
  subtitle,
  href,
  onClick,
}: {
  icon: string;
  title: string;
  subtitle: string;
  href: string;
  onClick: (href: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(href)}
      style={{
        border: "1px solid #dfe7f3",
        borderRadius: 12,
        background: "#ffffff",
        padding: 12,
        minHeight: 94,
        cursor: "pointer",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 24, marginBottom: 6 }}>{icon}</div>
      <div style={{ color: "#0f172a", fontSize: 13, fontWeight: 950 }}>
        {title}
      </div>
      <div style={{ color: "#64748b", fontSize: 11, fontWeight: 750, marginTop: 4 }}>
        {subtitle}
      </div>
    </button>
  );
}

function FlowStep({
  icon,
  title,
  subtitle,
  active,
}: {
  icon: string;
  title: string;
  subtitle: string;
  active?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 999,
          border: active ? "1px solid #22c55e" : "1px solid #dbeafe",
          background: active ? "#f0fdf4" : "#f8fbff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: active ? "#16a34a" : "#002b6b",
          fontSize: 20,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: "#0f172a", fontSize: 12, fontWeight: 950 }}>
          {title}
        </div>
        <div style={{ color: "#64748b", fontSize: 10, fontWeight: 750, marginTop: 2 }}>
          {subtitle}
        </div>
      </div>
    </div>
  );
}

export default function DocumentsHome() {
  const router = useRouter();
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  async function load() {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;

    if (!token) {
      router.replace("/login");
      return;
    }

    setState({ status: "loading" });
    try {
      const snapshot = await fetchDocumentsHubSummary(token);
      setState({ status: "ready", snapshot });
    } catch (e) {
      const message = e instanceof Error ? e.message : "שגיאה בטעינת המסמכים";
      if (message === "Unauthorized") {
        window.localStorage.removeItem("token");
        window.localStorage.removeItem("user");
        router.replace("/login");
        return;
      }
      setState({ status: "error", message });
    }
  }

  useEffect(() => {
    void Promise.resolve().then(() => load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function uploadDocument(file: File | null | undefined) {
    if (!file) return;

    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) {
      router.replace("/login");
      return;
    }

    setUploading(true);
    setUploadError("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/documents/upload", {
        method: "POST",
        body: formData,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();
      if (!res.ok || !data?.documentId) {
        throw new Error(data?.error || "Upload failed");
      }

      router.push(`/documents/review/${data.documentId}`);
    } catch (e: unknown) {
      setUploadError(errorMessage(e, "אירעה שגיאה בהעלאת המסמך"));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  }

  function openUploadPicker() {
    setUploadError("");
    uploadInputRef.current?.click();
  }

  function openCameraPicker() {
    setUploadError("");
    cameraInputRef.current?.click();
  }

  const snapshot = state.status === "ready" ? state.snapshot : null;
  const pulse = snapshot?.financialPulse ?? null;
  const pendingCount = pulse?.inboxDocumentCounts.pendingReview ?? 0;
  const approvedCount = pulse?.inboxDocumentCounts.approvedDocuments ?? 0;
  const monthDocs = pendingCount + approvedCount;
  const recordCount = pulse?.fromFinancialRecords.recordCount ?? 0;
  const net = pulse?.fromFinancialRecords.net ?? 0;
  const pending = snapshot?.nextPending ?? null;

  const primary = useMemo(() => {
    if (!snapshot) {
      return {
        label: "טוען...",
        description: "בודקים את מצב הניירת הפיננסית.",
        href: "/documents",
        disabled: true,
      };
    }

    if (pending) {
      return {
        label: "בדוק את המסמך הבא",
        description: "יש מסמכים שמונעים מהדוח החודשי להיות סופי.",
        href: `/documents/review/${pending.documentId}`,
        disabled: false,
      };
    }

    if (pendingCount > 0) {
      return {
        label: "פתח את תור הבדיקה",
        description: "יש מסמכים שמחכים לבדיקה, אבל הם לא נטענו ברשימה הראשונה.",
        href: "/documents/inbox",
        disabled: false,
      };
    }

    if (recordCount > 0) {
      return {
        label: "צפה בדוח החודשי",
        description: "המסמכים המאושרים כבר עובדים בשבילך בדוחות.",
        href: "/documents/dashboard",
        disabled: false,
      };
    }

    return {
      label: "העלה או ייבא מסמך ראשון",
      description:
        "הכנס קבלה, חשבונית או אישור תשלום. המערכת תזהה את העסקה, תכין אותה לבדיקה ותבנה ממנה דוחות וחבילה לרו״ח.",
      href: "/documents/upload",
      disabled: false,
    };
  }, [pending, pendingCount, recordCount, snapshot]);

  const readiness = useMemo(() => {
    if (!snapshot) return "טוען את מצב הדוח.";
    if (monthDocs === 0) {
      return "ברגע שתעלה מסמך, המערכת תחלץ ממנו פרטים ותראה לך מה צריך לאשר לפני שהוא נכנס לדוחות.";
    }
    if (pendingCount > 0) {
      return `הדוח עדיין לא מלא: ${pendingCount.toLocaleString("he-IL")} מסמכים מחכים לבדיקה.`;
    }
    if (recordCount > 0) return "הדוח החודשי מוכן על בסיס המסמכים שאושרו.";
    return "יש מסמכים מאושרים, אבל עדיין אין עסקאות בדוח.";
  }, [monthDocs, pendingCount, recordCount, snapshot]);

  const readyPercent =
    monthDocs === 0 ? 0 : Math.round((approvedCount / Math.max(monthDocs, 1)) * 100);

  return (
    <div dir="rtl" style={mainShellStyle()}>
      <main style={contentStyle()}>
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*,application/pdf"
          style={{ display: "none" }}
          onChange={(e) => void uploadDocument(e.target.files?.[0])}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => void uploadDocument(e.target.files?.[0])}
        />
        <header
          style={{
            background: "#ffffff",
            border: "1px solid #dfe7f3",
            borderRadius: 18,
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
          }}
        >
          <div>
            <div style={{ color: "#0f172a", fontSize: 20, fontWeight: 950 }}>
              מרכז פיננסי - סקירה
            </div>
            <div style={{ color: "#64748b", fontSize: 12, fontWeight: 800, marginTop: 3 }}>
              התמונה המלאה על המסמכים והדוחות
            </div>
          </div>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 999,
              background: "#eff6ff",
              color: "#002b6b",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 950,
            }}
          >
            ↻
          </div>
        </header>

        {state.status === "error" ? (
          <section
            style={{
              ...cardStyle(),
              borderColor: "#fecaca",
              background: "#fef2f2",
            }}
          >
            <div style={{ color: "#991b1b", fontWeight: 900, fontSize: 15 }}>
              לא הצלחנו לטעון את מרכז המסמכים.
            </div>
            <p
              style={{
                margin: "8px 0 0",
                color: "#7f1d1d",
                fontSize: 14,
                lineHeight: 1.6,
              }}
            >
              {state.message}
            </p>
            <button
              type="button"
              style={{ ...secondaryButtonStyle(), marginTop: 14 }}
              onClick={() => void load()}
            >
              נסה שוב
            </button>
          </section>
        ) : null}

        {uploadError ? (
          <section
            style={{
              ...cardStyle(),
              borderColor: "#fecaca",
              background: "#fef2f2",
              color: "#991b1b",
              fontSize: 14,
              fontWeight: 850,
              lineHeight: 1.5,
            }}
          >
            {uploadError}
          </section>
        ) : null}

        {state.status === "loading" ? <HubLoadingPlaceholder /> : null}

        {state.status !== "loading" ? (
        <>
        <section style={cardStyle()}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ color: "#0f172a", fontSize: 16, fontWeight: 950 }}>
                מצב העסק - {snapshot ? monthLabel(snapshot.scope.month) : "טוען..."}
              </div>
              <div style={{ color: "#64748b", fontSize: 12, fontWeight: 800, marginTop: 4 }}>
                מבוסס על מסמכים שאושרו ונמצאים בתור בדיקה
              </div>
            </div>
            <div
              style={{
                width: 74,
                height: 74,
                borderRadius: 999,
                background: `conic-gradient(#22c55e ${readyPercent * 3.6}deg, #e5e7eb 0deg)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 999,
                  background: "#ffffff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#0f172a",
                  fontWeight: 950,
                  fontSize: 18,
                }}
              >
                {`${readyPercent}%`}
              </div>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 10,
              marginTop: 14,
            }}
          >
            <MetricTile
              label="מסמכים שטופלו"
              value={metricLabel(approvedCount)}
              hint="מאושרים"
            />
            <MetricTile
              label="ממתינים לבדיקה"
              value={metricLabel(pendingCount)}
              hint="מסמכים"
            />
            <MetricTile
              label="עסקאות בדוחות"
              value={metricLabel(recordCount)}
              hint="החודש"
            />
            <MetricTile
              label="נטו חודשי"
              value={formatMoney(net)}
              hint="דוחות"
            />
          </div>
        </section>

        <section style={cardStyle()}>
          <div style={{ textAlign: "center" }}>
            <div style={{ color: "#0f172a", fontWeight: 950, fontSize: 17 }}>
              יש {pendingCount.toLocaleString("he-IL")} מסמכים שממתינים לבדיקה
            </div>
            <p
              style={{
                margin: "8px 0 0",
                color: "#64748b",
                fontSize: 13,
                lineHeight: 1.6,
                fontWeight: 800,
              }}
            >
              {readiness}
            </p>
          </div>
          <button
            type="button"
            disabled={primary.disabled || uploading}
            style={{ ...primaryButtonStyle(primary.disabled || uploading), marginTop: 16 }}
            onClick={() => {
              if (primary.disabled || uploading) return;
              if (primary.href === "/documents/upload") {
                openUploadPicker();
                return;
              }
              router.push(primary.href);
            }}
          >
            {uploading && primary.href === "/documents/upload"
              ? "מעלה מסמך..."
              : primary.label}{" "}
            <span style={{ marginInlineStart: 10 }}>←</span>
          </button>
          <button
            type="button"
            style={{
              border: "none",
              background: "transparent",
              color: "#002b6b",
              fontSize: 12,
              fontWeight: 900,
              cursor: "pointer",
              marginTop: 10,
              width: "100%",
            }}
            onClick={() => router.push("/documents/inbox")}
          >
            ראה את כל התור
          </button>
        </section>

        <section style={cardStyle()}>
          <div style={{ color: "#0f172a", fontWeight: 950, fontSize: 16, marginBottom: 12 }}>
            כניסת מסמכים
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: 10,
            }}
          >
            <IntakeTile
              icon="⬆"
              title="העלה מסמך"
              subtitle="פתח בחירה מהמכשיר"
              href="direct-upload"
              onClick={() => openUploadPicker()}
            />
            <IntakeTile
              icon="✉"
              title="ייבוא מייל"
              subtitle="Gmail וקבצים"
              href="/documents/email"
              onClick={(href) => router.push(href)}
            />
            <IntakeTile
              icon="▣"
              title="סריקה"
              subtitle="צילום מהנייד"
              href="direct-camera"
              onClick={() => openCameraPicker()}
            />
            <IntakeTile
              icon="⌕"
              title="חיפוש"
              subtitle="מסמכים"
              href="/documents/search"
              onClick={(href) => router.push(href)}
            />
          </div>
        </section>

        <section style={{ ...cardStyle(), marginTop: 28 }}>
          <div style={{ color: "#0f172a", fontWeight: 950, fontSize: 16, marginBottom: 14 }}>
            איך זה עובד?
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
              gap: 8,
            }}
          >
            <FlowStep icon="▤" title="מסמך נכנס" subtitle="ידני או מייל" />
            <FlowStep icon="⚙" title="זיהוי וסיווג" subtitle="חילוץ פרטים" />
            <FlowStep
              icon="✓"
              title="בדיקה"
              subtitle="אישור אנושי"
              active={pendingCount > 0}
            />
            <FlowStep
              icon="▥"
              title="דוחות"
              subtitle="עדכון אוטומטי"
              active={recordCount > 0}
            />
            <FlowStep icon="□" title="רו״ח" subtitle="חבילה מוכנה" />
          </div>
        </section>
        </>
        ) : null}
      </main>
    </div>
  );
}
