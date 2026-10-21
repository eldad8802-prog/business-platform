"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { TOKEN } from "@/lib/design/tokens";
import { IconLock } from "./wa-icons";

export function WhatsAppMetaDataPrivacySection({
  onChanged,
}: {
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    setNotice(null);
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;

    try {
      const res = await fetch(
        "/api/integrations/whatsapp/connection/meta-data",
        {
          method: "DELETE",
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        }
      );
      if (!res.ok) {
        setError(t("inbox.whatsapp.privacy.deleteError"));
        setDeleting(false);
        return;
      }
      setDeleting(false);
      setConfirmOpen(false);
      setNotice(t("inbox.whatsapp.privacy.deleted"));
      onChanged();
    } catch {
      setError(t("inbox.whatsapp.privacy.deleteError"));
      setDeleting(false);
    }
  }

  return (
    <section
      style={{
        background: TOKEN.surface.card,
        borderRadius: TOKEN.radius.modal,
        boxShadow: TOKEN.shadow.floating,
        padding: 22,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", gap: TOKEN.space.md, alignItems: "flex-start" }}>
        <span
          aria-hidden
          style={{
            width: 42,
            height: 42,
            flex: "0 0 42px",
            borderRadius: TOKEN.radius.card,
            background: TOKEN.surface.inset,
            color: TOKEN.ink.primary,
            display: "grid",
            placeItems: "center",
          }}
        >
          <IconLock size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontSize: TOKEN.font.title,
              fontWeight: TOKEN.weight.bold,
              color: TOKEN.ink.primary,
              lineHeight: 1.35,
            }}
          >
            {t("inbox.whatsapp.privacy.title")}
          </h2>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: TOKEN.font.body,
              fontWeight: TOKEN.weight.medium,
              color: TOKEN.ink.muted,
              lineHeight: 1.55,
            }}
          >
            {t("inbox.whatsapp.privacy.body")}
          </p>
          <p
            style={{
              margin: "8px 0 0",
              fontSize: TOKEN.font.meta,
              fontWeight: TOKEN.weight.medium,
              lineHeight: 1.55,
            }}
          >
            {/* An inline link inside a paragraph renders at the text's own line
                box — 18px here, below A-7's 24x24 gating target. A centred
                inline-flex box with a min-height reaches 24 without changing the
                paragraph's rhythm. Presentation only: same href, same wording. */}
            <a
              href="/data-deletion"
              style={{
                color: TOKEN.brand.mid,
                textDecoration: "underline",
                display: "inline-flex",
                alignItems: "center",
                minHeight: 24,
              }}
            >
              {t("inbox.whatsapp.privacy.link")}
            </a>
          </p>
        </div>
      </div>

      {notice && (
        <p
          role="status"
          style={{
            margin: 0,
            fontSize: TOKEN.font.meta,
            color: TOKEN.semantic.success.ink,
            lineHeight: 1.5,
          }}
        >
          {notice}
        </p>
      )}

      <button
        type="button"
        onClick={() => {
          setError(null);
          setNotice(null);
          setConfirmOpen(true);
        }}
        disabled={deleting}
        style={{
          minHeight: 48,
          width: "100%",
          border: TOKEN.action.danger.border,
          borderRadius: TOKEN.radius.card,
          background: TOKEN.action.danger.background,
          color: TOKEN.action.danger.color,
          boxShadow: TOKEN.action.danger.shadow,
          fontSize: TOKEN.font.body,
          fontWeight: TOKEN.weight.semibold,
          fontFamily: "inherit",
          cursor: deleting ? "wait" : "pointer",
          opacity: deleting ? 0.65 : 1,
          padding: "10px 14px",
        }}
      >
        {t("inbox.whatsapp.privacy.deleteButton")}
      </button>

      {confirmOpen && (
        <DeleteMetaDataDialog
          busy={deleting}
          error={error}
          onConfirm={handleDelete}
          onCancel={() => {
            if (deleting) return;
            setConfirmOpen(false);
            setError(null);
          }}
        />
      )}
    </section>
  );
}

function DeleteMetaDataDialog({
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("inbox.whatsapp.privacy.dialogTitle")}
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(52, 60, 50, 0.42)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 480,
          background: TOKEN.surface.overlay,
          borderRadius: `${TOKEN.radius.modal}px ${TOKEN.radius.modal}px 0 0`,
          boxShadow: TOKEN.shadow.floating,
          padding: "14px 24px 88px",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          aria-hidden
          style={{
            width: 40,
            height: 4,
            borderRadius: TOKEN.radius.pill,
            background: TOKEN.border.hover,
            margin: "0 auto 16px",
          }}
        />
        <div
          aria-hidden
          style={{
            width: 58,
            height: 58,
            borderRadius: TOKEN.radius.modal,
            background: TOKEN.semantic.attention.bgSoft,
            color: TOKEN.semantic.attention.ink,
            display: "grid",
            placeItems: "center",
            margin: "0 auto 14px",
          }}
        >
          <IconLock size={26} />
        </div>

        <h2
          style={{
            margin: 0,
            fontSize: TOKEN.font.display,
            fontWeight: TOKEN.weight.bold,
            color: TOKEN.ink.primary,
            textAlign: "center",
            lineHeight: 1.3,
          }}
        >
          {t("inbox.whatsapp.privacy.dialogTitle")}
        </h2>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 10,
            fontSize: TOKEN.font.body,
            fontWeight: TOKEN.weight.medium,
            color: TOKEN.ink.muted,
            textAlign: "center",
            lineHeight: 1.55,
          }}
        >
          <p style={{ margin: 0 }}>
            {t("inbox.whatsapp.privacy.dialogBody")}
          </p>
          <p style={{ margin: 0, color: TOKEN.ink.primary, fontWeight: TOKEN.weight.semibold }}>
            {t("inbox.whatsapp.privacy.dialogKept")}
          </p>
          <p style={{ margin: 0 }}>{t("inbox.whatsapp.privacy.dialogReconnect")}</p>
        </div>

        {error && (
          <p
            role="alert"
            style={{
              margin: "12px 0 0",
              fontSize: TOKEN.font.meta,
              color: TOKEN.semantic.urgent.ink,
              lineHeight: 1.5,
              textAlign: "center",
            }}
          >
            {error}
          </p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              height: 52,
              width: "100%",
              border: "none",
              borderRadius: TOKEN.radius.card,
              background: TOKEN.surface.inset,
              color: TOKEN.ink.secondary,
              fontSize: TOKEN.font.title,
              fontWeight: TOKEN.weight.semibold,
              fontFamily: "inherit",
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {t("inbox.whatsapp.privacy.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{
              height: 52,
              width: "100%",
              border: TOKEN.action.danger.border,
              borderRadius: TOKEN.radius.card,
              background: TOKEN.action.danger.background,
              color: TOKEN.action.danger.color,
              fontSize: TOKEN.font.title,
              fontWeight: TOKEN.weight.bold,
              fontFamily: "inherit",
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? t("inbox.whatsapp.privacy.confirmBusy") : t("inbox.whatsapp.privacy.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
