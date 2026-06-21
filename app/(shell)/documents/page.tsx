"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  fetchDocumentsHubSummary,
  type DocumentsHubSnapshot,
} from "@/lib/documents/fetch-inbox";
import { TOKEN } from "@/lib/design/tokens";
import { glassActionStyle, primaryActionStyle } from "@/lib/design/action-styles";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: DocumentsHubSnapshot };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: "ILS",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toLocaleString("he-IL", { maximumFractionDigits: 2 })} ש"ח`;
  }
}

function monthLabel(raw: string): string {
  if (!raw) return "ללא חודש";
  const [year, month] = raw.split("-");
  if (!year || !month) return raw;
  const d = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("he-IL", { month: "long", year: "numeric" });
}

function currentMonthValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export default function DocumentsHome() {
  const router = useRouter();
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [intakeSheet, setIntakeSheet] = useState<"upload" | "camera" | null>(null);

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
      const message = errorMessage(e, "שגיאה בטעינת המסמכים");
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
    } catch (e) {
      setUploadError(errorMessage(e, "אירעה שגיאה בהעלאת המסמך"));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  }

  const snapshot = state.status === "ready" ? state.snapshot : null;
  const pendingCount =
    snapshot?.financialPulse.inboxDocumentCounts.pendingReview ?? 0;
  const approvedCount =
    snapshot?.financialPulse.inboxDocumentCounts.approvedDocuments ?? 0;
  const pulse = snapshot?.financialPulse.fromFinancialRecords;

  return (
    <div dir="rtl" style={pageShellStyle}>
      <style>{documentsHomeCss}</style>
      <main className="documents-home" style={hubContentStyle}>
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

        <header style={hubHeaderStyle}>
          <h1 style={hubTitleStyle}>מסמכים</h1>
          <p style={hubSubtitleStyle}>
            {monthLabel(currentMonthValue())} ·{" "}
            {state.status === "loading"
              ? "טוען תור"
              : `${pendingCount.toLocaleString("he-IL")} ממתינים לאימות`}
          </p>
        </header>

        {state.status === "error" ? (
          <section style={errorCardStyle}>
            <div style={errorTitleStyle}>לא הצלחנו לטעון את מרכז המסמכים.</div>
            <p style={errorTextStyle}>{state.message}</p>
            <button type="button" onClick={() => void load()} style={secondaryButtonStyle}>
              נסה שוב
            </button>
          </section>
        ) : null}

        {state.status !== "error" ? (
          <>
        {uploadError ? (
          <section style={errorCardStyle}>
            <div style={errorTitleStyle}>{uploadError}</div>
          </section>
        ) : null}

        <section style={financialPulseStyle}>
          <div style={pulseLabelStyle}>תזרים החודש</div>
          <div style={pulseNetStyle}>{formatMoney(pulse?.net ?? 0)}</div>
          <div style={pulseStatsStyle}>
            <PulseBox label="הכנסות" value={formatMoney(pulse?.income ?? 0)} />
            <PulseBox label="הוצאות" value={formatMoney(pulse?.expense ?? 0)} />
            <PulseBox
              label="רשומות"
              value={(pulse?.recordCount ?? approvedCount).toLocaleString("he-IL")}
            />
          </div>
        </section>

        <section>
          <SectionTitle>קליטת מסמך</SectionTitle>
          <div className="documents-intake-grid" style={hubIntakeGridStyle}>
            <HubTile
              icon="📤"
              label="העלאת קובץ"
              onClick={() => {
                setUploadError("");
                setIntakeSheet("upload");
              }}
            />
            <HubTile
              icon="📷"
              label="צילום מסמך"
              onClick={() => {
                setUploadError("");
                setIntakeSheet("camera");
              }}
            />
            <HubTile
              icon="📧"
              label="מ-Gmail"
              onClick={() => router.push("/documents/email")}
            />
            <HubTile
              icon="💬"
              label="מ-WhatsApp"
              onClick={() => router.push("/settings/whatsapp")}
            />
          </div>
        </section>

        <section>
          <SectionTitle>תחנות</SectionTitle>
          <div style={hubStationsStyle}>
            <StationRow
              icon="📥"
              title="תור אימות"
              subtitle="מסמכים שממתינים לאישור שלך"
              count={pendingCount}
              onClick={() => router.push("/documents/inbox")}
            />
            <StationRow
              icon="🔍"
              title="חיפוש מסמכים"
              subtitle="חיפוש ברשומות המאושרות"
              onClick={() => router.push("/documents/search")}
            />
            <StationRow
              icon="📊"
              title="חבילת רו״ח"
              subtitle="ייצוא תקופה לרואה החשבון"
              onClick={() => router.push("/documents/accountant-pack")}
            />
          </div>
        </section>

          </>
        ) : null}

        {intakeSheet && typeof document !== "undefined"
          ? createPortal(
              <div className="documents-intake-overlay" style={intakeOverlayStyle}>
                <section role="dialog" aria-modal="true" style={intakeDialogStyle}>
                  <div style={sheetGrabStyle} />
                  <div style={intakeDialogHeaderStyle}>
                    <div>
                      <h2 style={intakeDialogTitleStyle}>
                        {intakeSheet === "upload" ? "העלאת מסמך" : "צילום מסמך"}
                      </h2>
                      <p style={intakeDialogTextStyle}>
                        {intakeSheet === "upload"
                          ? "בחר קובץ מהמחשב - נריץ OCR ונעביר לאימות."
                          : "צלם מסמך או בחר תמונה קיימת - נריץ OCR ונעביר לאימות."}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label="סגור"
                      style={intakeDialogCloseStyle}
                      onClick={() => setIntakeSheet(null)}
                    >
                      ×
                    </button>
                  </div>
                  <div style={sheetTileGridStyle}>
                    <button
                      type="button"
                      style={sheetTileStyle}
                      onClick={() => {
                        setIntakeSheet(null);
                        window.setTimeout(() => uploadInputRef.current?.click(), 0);
                      }}
                    >
                      <span style={sheetTileIconStyle}>
                        📤
                      </span>
                      <span>העלאת קובץ</span>
                    </button>
                    <button
                      type="button"
                      style={sheetTileStyle}
                      onClick={() => {
                        setIntakeSheet(null);
                        window.setTimeout(() => cameraInputRef.current?.click(), 0);
                      }}
                    >
                      <span style={sheetTileIconStyle}>
                        📷
                      </span>
                      <span>צילום מסמך</span>
                    </button>
                    <button
                      type="button"
                      style={sheetTileStyle}
                      onClick={() => router.push("/documents/email")}
                    >
                      <span style={sheetTileIconStyle}>
                        📧
                      </span>
                      <span>מ-Gmail</span>
                    </button>
                    <button
                      type="button"
                      style={sheetTileStyle}
                      onClick={() => router.push("/settings/whatsapp")}
                    >
                      <span style={sheetTileIconStyle}>
                        💬
                      </span>
                      <span>מ-WhatsApp</span>
                    </button>
                  </div>
                  <div style={sheetActionsStyle}>
                    <button
                      type="button"
                      style={intakeSecondaryActionStyle}
                      onClick={() => setIntakeSheet(null)}
                    >
                      ביטול
                    </button>
                    <button
                      type="button"
                      style={intakePrimaryActionStyle(uploading)}
                      disabled={uploading}
                      onClick={() => {
                        const target = intakeSheet;
                        setIntakeSheet(null);
                        window.setTimeout(() => {
                          if (target === "upload") uploadInputRef.current?.click();
                          if (target === "camera") cameraInputRef.current?.click();
                        }, 0);
                      }}
                    >
                      {intakeSheet === "upload" ? "בחר קובץ" : "פתח מצלמה"}
                    </button>
                  </div>
                  <p style={sheetHintStyle}>PDF או תמונה · עד 15MB</p>
                </section>
              </div>,
              document.body
            )
          : null}
      </main>
    </div>
  );
}

function PulseBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={pulseStatBoxStyle}>
      <span style={pulseStatLabelStyle}>{label}</span>
      <strong style={pulseStatValueStyle}>{value}</strong>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={hubSectionHeadStyle}>
      <h2 style={hubSectionTitleStyle}>{children}</h2>
    </div>
  );
}

function HubTile({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" style={hubTileStyle} onClick={onClick}>
      <span style={hubTileIconStyle}>{icon}</span>
      <span style={hubTileTextStyle}>{label}</span>
    </button>
  );
}

function StationRow({
  icon,
  title,
  subtitle,
  count,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button type="button" style={hubStationRowStyle} onClick={onClick}>
      <span style={hubStationIconStyle}>{icon}</span>
      <span style={hubStationTextStyle}>
        <strong style={hubStationTitleStyle}>{title}</strong>
        <span style={hubStationSubStyle}>{subtitle}</span>
      </span>
      {typeof count === "number" ? (
        <span style={hubCountStyle}>{count.toLocaleString("he-IL")}</span>
      ) : (
        <ChevronLeftIcon />
      )}
    </button>
  );
}

const pageShellStyle = {
  minHeight: "100vh",
  background: TOKEN.surface.page,
  color: TOKEN.ink.primary,
};

const hubContentStyle = {
  width: "100%",
  maxWidth: 760,
  margin: "0 auto",
  padding: "18px 18px 118px",
  boxSizing: "border-box" as const,
};

const hubHeaderStyle = {
  padding: "4px 0 10px",
};

const hubTitleStyle = {
  margin: 0,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.hero,
  fontWeight: TOKEN.weight.bold,
  lineHeight: 1.25,
};

const hubSubtitleStyle = {
  margin: "6px 0 0",
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
};

const financialPulseStyle = {
  marginTop: TOKEN.space.md,
  borderRadius: TOKEN.radius.modal,
  padding: TOKEN.space.xl,
  background: TOKEN.brand.gradient,
  color: TOKEN.ink.inverse,
  boxShadow: TOKEN.shadow.elevated,
};

const pulseLabelStyle = {
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  opacity: 0.82,
};

const pulseNetStyle = {
  marginTop: TOKEN.space.sm,
  fontSize: TOKEN.font.hero,
  fontWeight: TOKEN.weight.bold,
  lineHeight: 1.2,
};

const pulseStatsStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: TOKEN.space.sm,
  marginTop: TOKEN.space.lg,
};

const pulseStatBoxStyle = {
  borderRadius: TOKEN.radius.card,
  background: "rgba(255, 255, 255, 0.16)",
  padding: TOKEN.space.md,
  minWidth: 0,
};

const pulseStatLabelStyle = {
  display: "block",
  color: "rgba(255, 255, 255, 0.78)",
  fontSize: TOKEN.font.caption,
  fontWeight: TOKEN.weight.semibold,
};

const pulseStatValueStyle = {
  display: "block",
  marginTop: TOKEN.space.xs,
  color: TOKEN.ink.inverse,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  whiteSpace: "nowrap" as const,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const hubSectionHeadStyle = {
  margin: `${TOKEN.space.xl}px 0 ${TOKEN.space.md}px`,
};

const hubSectionTitleStyle = {
  margin: 0,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
};

const hubIntakeGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: TOKEN.space.md,
};

const hubTileStyle = {
  minHeight: 94,
  border: "none",
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.inset,
  color: TOKEN.ink.primary,
  padding: "14px 18px",
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  justifyContent: "center",
  gap: TOKEN.space.sm,
  cursor: "pointer",
  font: "inherit",
  textAlign: "center" as const,
};

const hubTileIconStyle = {
  width: 56,
  height: 56,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 23,
  flexShrink: 0,
};

const hubTileTextStyle = {
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  lineHeight: 1.3,
  textAlign: "center" as const,
};

const hubStationsStyle = {
  display: "grid",
  gap: TOKEN.space.md,
};

const hubStationRowStyle = {
  width: "100%",
  minHeight: 74,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  padding: TOKEN.space.md,
  display: "flex",
  alignItems: "center",
  gap: TOKEN.space.md,
  color: TOKEN.ink.primary,
  cursor: "pointer",
  font: "inherit",
  textAlign: "right" as const,
  boxShadow: TOKEN.shadow.elevated,
};

const hubStationIconStyle = {
  width: 46,
  height: 46,
  borderRadius: TOKEN.radius.input,
  background: TOKEN.surface.inset,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 24,
  flexShrink: 0,
};

const hubStationTextStyle = {
  minWidth: 0,
  flex: 1,
  display: "flex",
  flexDirection: "column" as const,
  gap: 2,
};

const hubStationTitleStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
};

const hubStationSubStyle = {
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  lineHeight: 1.45,
};

const hubCountStyle = {
  minWidth: 28,
  height: 28,
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.semantic.attention.bg,
  color: TOKEN.semantic.attention.ink,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 8px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
};

const errorCardStyle = {
  background: TOKEN.semantic.urgent.bgSoft,
  border: `1px solid ${TOKEN.semantic.urgent.border}`,
  borderRadius: TOKEN.radius.card,
  padding: TOKEN.space.lg,
  boxShadow: TOKEN.shadow.elevated,
};

const errorTitleStyle = {
  color: TOKEN.semantic.urgent.ink,
  fontWeight: TOKEN.weight.bold,
};

const errorTextStyle = {
  margin: "8px 0 0",
  color: TOKEN.semantic.urgent.ink,
  fontSize: TOKEN.font.body,
  lineHeight: 1.6,
};

const secondaryButtonStyle = {
  ...glassActionStyle({ fullWidth: true, height: 44 }),
  width: "100%",
  minHeight: 44,
  marginTop: 14,
  fontSize: TOKEN.font.body,
};

const intakeOverlayStyle = {
  position: "fixed" as const,
  inset: 0,
  zIndex: 2147483000,
  background: "rgba(15, 23, 42, 0.28)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
};

const intakeDialogStyle = {
  width: "min(440px, 100%)",
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.modal,
  background: TOKEN.surface.overlay,
  padding: TOKEN.space.xl,
  boxShadow: TOKEN.shadow.floating,
};

const sheetGrabStyle = {
  width: 42,
  height: 4,
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.border.hover,
  margin: "0 auto 14px",
};

const intakeDialogHeaderStyle = {
  display: "flex" as const,
  alignItems: "flex-start" as const,
  justifyContent: "space-between" as const,
  gap: 12,
};

const intakeDialogTitleStyle = {
  margin: 0,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.display,
  fontWeight: TOKEN.weight.bold,
};

const intakeDialogCloseStyle = {
  width: 40,
  height: 40,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.button,
  background: TOKEN.surface.card,
  color: TOKEN.ink.muted,
  fontSize: 24,
  lineHeight: 1,
  cursor: "pointer",
  flexShrink: 0,
};

const intakeDialogTextStyle = {
  margin: "6px 0 0",
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
  lineHeight: 1.6,
};

const sheetActionsStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1.3fr",
  gap: TOKEN.space.sm,
  marginTop: TOKEN.space.xl,
};

const sheetTileGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: TOKEN.space.sm,
  marginTop: TOKEN.space.lg,
};

const sheetTileStyle = {
  minHeight: 82,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.inset,
  color: TOKEN.ink.primary,
  display: "flex",
  flexDirection: "row" as const,
  alignItems: "center",
  justifyContent: "space-between",
  gap: TOKEN.space.md,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
  padding: "12px 14px",
  textAlign: "right" as const,
};

const sheetTileIconStyle = {
  width: 44,
  height: 44,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  fontSize: 21,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const intakeSecondaryActionStyle = {
  ...glassActionStyle({ height: 50 }),
  minHeight: 50,
  fontSize: TOKEN.font.body,
};

const intakePrimaryActionStyle = (disabled: boolean) =>
  ({
    ...primaryActionStyle({ disabled, height: 50 }),
    minHeight: 50,
    fontSize: TOKEN.font.body,
  }) as const;

const sheetHintStyle = {
  margin: `${TOKEN.space.md}px 0 0`,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  textAlign: "center" as const,
};

function ChevronLeftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m9 6 6 6-6 6"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const documentsHomeCss = `
  .documents-home input::placeholder {
    color: ${TOKEN.ink.muted};
    opacity: 1;
  }

  @media (max-width: 640px) {
    .documents-home {
      padding-inline: 14px !important;
      padding-bottom: 148px !important;
    }

    .documents-intake-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
      gap: 12px !important;
    }

    .documents-intake-grid button {
      flex-direction: row !important;
      justify-content: space-between !important;
      text-align: right !important;
      padding: 14px 18px !important;
    }

    .documents-intake-grid button > span:last-child {
      text-align: right !important;
      flex: 1 !important;
    }

    .documents-intake-overlay {
      align-items: flex-end !important;
      padding: 0 !important;
    }

    .documents-intake-overlay section {
      width: 100% !important;
      border-radius: 16px 16px 0 0 !important;
    }
  }
`;
