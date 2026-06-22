"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TOKEN } from "@/lib/design/tokens";
import { glassActionStyle } from "@/lib/design/action-styles";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function DocumentsUploadPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [processingName, setProcessingName] = useState("");
  const [error, setError] = useState("");

  async function upload(file: File | null | undefined) {
    if (!file) return;
    const token = window.localStorage.getItem("token");
    if (!token) {
      router.replace("/login");
      return;
    }

    try {
      setProcessingName(file.name);
      setError("");
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/documents/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.documentId) {
        throw new Error(data?.error || "Upload failed");
      }
      router.push(`/documents/review/${data.documentId}`);
    } catch (err) {
      setError(errorMessage(err, "לא הצלחנו להעלות את המסמך"));
      setProcessingName("");
    }
  }

  return (
    <div dir="rtl" style={pageStyle}>
      <main style={mainStyle}>
        <header style={headStyle}>
          <button type="button" onClick={() => router.push("/documents")} style={backButtonStyle}>
            <BackChevronIcon />
            חזרה
          </button>
          <h1 style={titleStyle}>העלאת קובץ</h1>
          <div aria-hidden style={{ width: 52 }} />
        </header>

        <button
          type="button"
          style={dropzoneStyle}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void upload(event.dataTransfer.files.item(0));
          }}
        >
          <UploadIcon />
          <strong style={dropTitleStyle}>גרור קובץ או לחץ לבחירה</strong>
          <span style={dropTextStyle}>PDF או תמונה · עד 15MB</span>
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/*"
          hidden
          onChange={(event) => void upload(event.target.files?.item(0))}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(event) => void upload(event.target.files?.item(0))}
        />

        <button type="button" style={cameraButtonStyle} onClick={() => cameraInputRef.current?.click()}>
          <CameraIcon />
          צילום מסמך
        </button>

        {processingName ? (
          <>
            <div style={labelStyle}>בעיבוד כעת</div>
            <div style={processingStyle}>
              <span style={spinnerStyle} aria-hidden />
              <div style={{ minWidth: 0 }}>
                <div style={processingTitleStyle}>{processingName}</div>
                <div style={processingMetaStyle}>מריץ OCR וחילוץ נתונים...</div>
              </div>
            </div>
          </>
        ) : null}

        {error ? <div style={errorStyle}>{error}</div> : null}
      </main>
    </div>
  );
}

function UploadIcon() {
  return (
    <svg width="38" height="38" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 15V4m0 0 4 4m-4-4-4 4M5 15v4h14v-4" stroke={TOKEN.brand.mid} strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BackChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="6" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <circle cx="12" cy="13" r="3.4" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <path d="M8 6l1.5-2h5L16 6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

const pageStyle = {
  minHeight: "100vh",
  background: TOKEN.surface.page,
  color: TOKEN.ink.primary,
} as const;

const mainStyle = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "14px 14px 40px",
  boxSizing: "border-box",
} as const;

const headStyle = {
  display: "grid",
  gridTemplateColumns: "52px 1fr 52px",
  alignItems: "center",
  gap: 10,
  marginBottom: 14,
} as const;

const backButtonStyle = {
  ...glassActionStyle({ height: 40 }),
  width: 40,
  height: 40,
  fontSize: 0,
  padding: 0,
} as const;

const titleStyle = {
  margin: 0,
  textAlign: "center",
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.display,
  fontWeight: TOKEN.weight.bold,
} as const;

const dropzoneStyle = {
  width: "100%",
  minHeight: 210,
  border: `2px dashed ${TOKEN.brand.softBorder}`,
  borderRadius: TOKEN.radius.modal,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  cursor: "pointer",
  color: TOKEN.ink.primary,
} as const;

const dropTitleStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.title,
  fontWeight: TOKEN.weight.bold,
} as const;

const dropTextStyle = {
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
} as const;

const cameraButtonStyle = {
  ...glassActionStyle({ fullWidth: true, height: 48 }),
  width: "100%",
  minHeight: 48,
  marginTop: 14,
  fontSize: TOKEN.font.body,
} as const;

const labelStyle = {
  paddingTop: 20,
  color: TOKEN.ink.secondary,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
} as const;

const processingStyle = {
  minHeight: 62,
  marginTop: 8,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: "0 14px",
  display: "flex",
  alignItems: "center",
  gap: 12,
} as const;

const spinnerStyle = {
  width: 22,
  height: 22,
  borderRadius: TOKEN.radius.pill,
  border: `3px solid ${TOKEN.brand.softBorder}`,
  borderTopColor: TOKEN.brand.mid,
  flexShrink: 0,
} as const;

const processingTitleStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const processingMetaStyle = {
  marginTop: 4,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
} as const;

const errorStyle = {
  marginTop: 14,
  border: `1px solid ${TOKEN.semantic.urgent.border}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.semantic.urgent.bgSoft,
  color: TOKEN.semantic.urgent.ink,
  padding: TOKEN.space.lg,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
} as const;
