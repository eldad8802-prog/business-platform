"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";

/**
 * Business VISUAL signature / stamp editor (Phase 1).
 *
 * Self-contained (mirrors GlobalBusinessAvatar): loads / uploads / removes the
 * `billingSignatureDataUrl` on the invoice profile. This is a PRESENTATION asset
 * embedded on billing documents — it is NOT a cryptographic/digital signature and
 * the copy here must never claim otherwise. Same data-URL constraints as the logo
 * (PNG/JPEG/WebP, size-capped); the server re-validates.
 */

const MAX_BYTES = 500_000; // matches the server-side validator
const ACCEPT = "image/png,image/jpeg,image/webp";
const ERROR_INK = "#B85C3F";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

function isValidSignature(v: string | null): boolean {
  return typeof v === "string" && /^data:image\/(png|jpeg|webp);base64,/i.test(v);
}

export function BillingSignatureField() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [signatureUrl, setSignatureUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/billing/invoice-profile", {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      const raw = data?.profile?.billingSignatureDataUrl;
      setSignatureUrl(typeof raw === "string" ? raw : null);
    } catch {
      /* ignore — the field simply shows empty */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(dataUrl: string | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/invoice-profile", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${getAuthToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ billingSignatureDataUrl: dataUrl }),
      });
      if (res.ok) {
        const data = await res.json();
        const raw = data?.profile?.billingSignatureDataUrl;
        setSignatureUrl(typeof raw === "string" ? raw : null);
      } else {
        setError("לא הצלחנו לשמור את החתימה. נסו שוב.");
      }
    } catch {
      setError("לא הצלחנו לשמור את החתימה. נסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  function readFile(file: File | null) {
    setError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
      setError("יש להעלות קובץ תמונה מסוג PNG, JPEG או WebP.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("הקובץ גדול מדי (עד 500KB).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r === "string" && isValidSignature(r)) {
        void save(r);
      } else {
        setError("קובץ לא תקין.");
      }
    };
    reader.onerror = () => setError("קריאת הקובץ נכשלה.");
    reader.readAsDataURL(file);
  }

  const has = isValidSignature(signatureUrl);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: TOKEN.ink.primary }}>
          חתימה / חותמת של העסק
        </span>
        <span style={{ fontSize: 11.5, color: TOKEN.ink.secondary, lineHeight: 1.5 }}>
          חתימה או חותמת ויזואלית שתופיע על מסמכי הגבייה. זוהי תמונה בלבד — אינה חתימה
          דיגיטלית או קריפטוגרפית ואינה מהווה אימות של המסמך.
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          borderRadius: 12,
          padding: 12,
          background: TOKEN.surface.card,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 120,
            height: 60,
            borderRadius: 8,
            border: `1px dashed ${TOKEN.border.DEFAULT}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: TOKEN.surface.inset,
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {has ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={signatureUrl as string}
              alt="חתימת העסק"
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
          ) : (
            <span style={{ fontSize: 11, color: TOKEN.ink.muted }}>אין חתימה</span>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            style={{ display: "none" }}
            onChange={(e) => {
              readFile(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            style={{
              fontSize: 13,
              fontWeight: 600,
              padding: "8px 14px",
              borderRadius: 10,
              border: "none",
              cursor: busy ? "not-allowed" : "pointer",
              background: TOKEN.action.primary.background,
              color: TOKEN.action.primary.color,
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "שומר…" : has ? "החלפת חתימה" : "העלאת חתימה"}
          </button>
          {has ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(null)}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                padding: "6px 12px",
                borderRadius: 10,
                border: `1px solid ${TOKEN.border.DEFAULT}`,
                cursor: busy ? "not-allowed" : "pointer",
                background: "transparent",
                color: TOKEN.ink.secondary,
              }}
            >
              הסרה
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <span style={{ fontSize: 12, color: ERROR_INK }}>{error}</span>
      ) : null}
    </div>
  );
}
