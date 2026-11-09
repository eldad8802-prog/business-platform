"use client";

// Building blocks of the extended Gmail scan on /documents/email (B3-b, 2026-11-09):
// the period picker, one attachment card (phone-first) and a group header; B4 adds the in-place
// confirmation for importing a possibly-relevant or low-score file. Presentation only — no
// fetching, no scoring, no import logic; the page owns all of that.

import type { ReactNode } from "react";
import { TOKEN, chipActionStyle, glassActionStyle } from "@/lib/design/documents-theme";
import { GMAIL_SCAN_WINDOWS, type GmailScanWindow } from "@/lib/services/email-import/scan-window";
import type { EmailAttachmentUiStatus, ScoredAttachment } from "@/lib/services/email-import/scoring";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";

export function periodLabel(t: Translator, window: GmailScanWindow): string {
  return t(`documents.email.period${window}`);
}

export function periodName(t: Translator, window: GmailScanWindow): string {
  return t(`documents.email.periodName${window}`);
}

/** "PDF" / "תמונה" / "קובץ" from Gmail's declared type (display only). */
export function fileTypeLabel(t: Translator, mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("pdf")) return t("documents.email.typePdf");
  if (m.startsWith("image/")) return t("documents.email.typeImage");
  return t("documents.email.typeFile");
}

/** Today / yesterday / "3 בנוב׳" (with the year when it is not this year). */
export function displayDate(t: Translator, raw: string | null, locale: Locale, now: Date = new Date()): string {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return t("documents.email.dateToday");
  if (days === 1) return t("documents.email.dateYesterday");
  return d.toLocaleDateString(intlTag(locale), {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** The human part of the scoring reason ("PDF, קטן מאוד"), without the bucket label and score. */
export function scoreReasonText(reason: string): string {
  const at = reason.indexOf(" • ");
  return at >= 0 ? reason.slice(at + 3) : "";
}

export function PeriodPicker({
  t,
  value,
  disabled,
  onChange,
}: {
  t: Translator;
  value: GmailScanWindow;
  disabled: boolean;
  onChange: (w: GmailScanWindow) => void;
}) {
  return (
    <div role="radiogroup" aria-label={t("documents.email.periodLabel")} className="dz-email-period" style={periodRowStyle}>
      {GMAIL_SCAN_WINDOWS.map((w) => {
        const active = w === value;
        return (
          <button
            key={w}
            type="button"
            role="radio"
            aria-checked={active}
            data-period={w}
            disabled={disabled}
            onClick={() => onChange(w)}
            style={{ ...chipActionStyle(active), flex: 1, minHeight: 44, opacity: disabled ? 0.6 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
          >
            {periodLabel(t, w)}
          </button>
        );
      })}
    </div>
  );
}

export function GroupHeader({ title, count, note }: { title: string; count: string; note?: string }) {
  return (
    <div style={groupHeaderStyle}>
      <h2 style={groupTitleStyle}>
        {title} <span style={groupCountStyle}>({count})</span>
      </h2>
      {note ? <p style={groupNoteStyle}>{note}</p> : null}
    </div>
  );
}

/**
 * B4 (2026-11-09): a possibly-relevant or low-score file is imported only one at a time, after
 * the owner confirms in place. The warning depends on the group. Confirming runs the SAME import
 * as any other file — nothing here (or anywhere on the screen) relaxes a server check.
 */
export function confirmImportText(t: Translator, bucket: ScoredAttachment["bucket"]): string {
  return bucket === "hidden" ? t("documents.email.confirmLowScore") : t("documents.email.confirmPossible");
}

export function ConfirmImportPanel({
  t,
  bucket,
  disabled,
  onConfirm,
  onCancel,
}: {
  t: Translator;
  bucket: ScoredAttachment["bucket"];
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="alertdialog" aria-label={confirmImportText(t, bucket)} className="dz-email-confirm-one" style={confirmPanelStyle}>
      <div style={confirmPanelTextStyle}>{confirmImportText(t, bucket)}</div>
      <div style={confirmPanelButtonsStyle}>
        <button type="button" className="dz-email-confirm-one-yes" disabled={disabled} onClick={onConfirm} style={confirmYesButtonStyle(disabled)}>
          {t("documents.email.importForReview")}
        </button>
        <button type="button" className="dz-email-confirm-one-no" onClick={onCancel} style={confirmNoButtonStyle}>
          {t("documents.email.confirmImportNo")}
        </button>
      </div>
    </div>
  );
}

export function AttachmentCard({
  t,
  locale,
  attachment,
  status,
  importDisabled,
  confirming,
  onImport,
  onAskConfirm,
  onCancelConfirm,
  statusLabel,
}: {
  t: Translator;
  locale: Locale;
  attachment: ScoredAttachment;
  status: EmailAttachmentUiStatus;
  importDisabled: boolean;
  /** This (possibly-relevant / low-score) card shows its confirmation now. */
  confirming: boolean;
  /** Runs the import: directly for a recommended file, from the confirmation for the others. */
  onImport: () => void;
  onAskConfirm: () => void;
  onCancelConfirm: () => void;
  statusLabel: string;
}) {
  const name = attachment.filename || t("documents.email.untitled");
  const needsConfirm = attachment.bucket !== "recommended";
  const reason = needsConfirm ? scoreReasonText(attachment.reason) : "";
  const date = displayDate(t, attachment.sentAt, locale);
  const pending = status === "pending";
  let action: ReactNode = null;
  if (pending && !needsConfirm) {
    action = (
      <button type="button" className="dz-email-card-import" disabled={importDisabled} onClick={onImport} style={importButtonStyle(importDisabled)}>
        {t("documents.email.import")}
      </button>
    );
  } else if (pending && !confirming) {
    action = (
      <button type="button" className="dz-email-card-import-anyway" disabled={importDisabled} onClick={onAskConfirm} style={importButtonStyle(importDisabled)}>
        {t("documents.email.importAnyway")}
      </button>
    );
  } else if (!pending) {
    action = <span style={statusChipStyle(status)}>{statusLabel}</span>;
  }
  return (
    <article className="dz-email-card" data-key={attachment.key} data-bucket={attachment.bucket} style={cardOuterStyle}>
      <div style={cardStyle}>
      <div style={cardBodyStyle}>
        <div style={titleRowStyle}>
          <span style={typeBadgeStyle}>{fileTypeLabel(t, attachment.mimeType)}</span>
          <span dir="auto" title={name} className="dz-email-card-name" style={fileNameStyle}>
            {name}
          </span>
        </div>
        <div style={senderStyle}>
          {attachment.fromName ? (
            <>
              <bdi style={senderNameStyle}>{attachment.fromName}</bdi>
              {attachment.fromEmail ? <bdi dir="ltr" style={senderEmailStyle}>{attachment.fromEmail}</bdi> : null}
            </>
          ) : attachment.fromEmail ? (
            <bdi dir="ltr" style={senderNameStyle}>{attachment.fromEmail}</bdi>
          ) : (
            <span style={senderNameStyle}>{t("documents.common.notSpecified")}</span>
          )}
        </div>
        {date ? <div style={metaStyle}>{date}</div> : null}
        {reason ? <div style={reasonStyle}>{t("documents.email.reasonLine", { reason })}</div> : null}
      </div>
      {action ? <div style={actionColStyle}>{action}</div> : null}
      </div>
      {confirming && pending && needsConfirm ? (
        <ConfirmImportPanel t={t} bucket={attachment.bucket} disabled={importDisabled} onConfirm={onImport} onCancel={onCancelConfirm} />
      ) : null}
    </article>
  );
}

const periodRowStyle = { display: "flex", gap: 8 } as const;

const groupHeaderStyle = { marginTop: 18, marginBottom: 8 } as const;
const groupTitleStyle = {
  margin: 0,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
} as const;
const groupCountStyle = { color: TOKEN.ink.muted, fontWeight: TOKEN.weight.semibold } as const;
const groupNoteStyle = { margin: "4px 0 0", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta } as const;

const cardOuterStyle = {
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
} as const;
const cardStyle = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
} as const;
const confirmPanelStyle = {
  border: `1px solid ${TOKEN.semantic.attention.border}`,
  background: TOKEN.semantic.attention.bgSoft,
  borderRadius: TOKEN.radius.card,
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
} as const;
const confirmPanelTextStyle = { color: TOKEN.ink.primary, fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.semibold, lineHeight: 1.5 } as const;
const confirmPanelButtonsStyle = { display: "flex", gap: 8 } as const;
function confirmYesButtonStyle(disabled: boolean) {
  return { ...glassActionStyle({ height: 44, disabled }), flex: 1, minHeight: 44, fontSize: TOKEN.font.meta } as const;
}
const confirmNoButtonStyle = { ...glassActionStyle({ height: 44 }), flex: 1, minHeight: 44, fontSize: TOKEN.font.meta } as const;
const cardBodyStyle = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 } as const;
const titleRowStyle = { display: "flex", alignItems: "flex-start", gap: 8 } as const;
const typeBadgeStyle = {
  flexShrink: 0,
  marginTop: 1,
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.surface.inset,
  color: TOKEN.ink.secondary,
  padding: "2px 8px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
} as const;
// Up to two lines, broken anywhere (long names have no spaces); the full name is in `title`.
const fileNameStyle = {
  flex: 1,
  minWidth: 0,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  lineHeight: 1.35,
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
} as const;
const senderStyle = { display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, rowGap: 2, minWidth: 0 } as const;
const senderNameStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  overflowWrap: "anywhere",
} as const;
const senderEmailStyle = { color: TOKEN.ink.muted, fontSize: TOKEN.font.meta, overflowWrap: "anywhere" } as const;
const metaStyle = { color: TOKEN.ink.muted, fontSize: TOKEN.font.meta } as const;
const reasonStyle = { color: TOKEN.ink.secondary, fontSize: TOKEN.font.meta, lineHeight: 1.4 } as const;
const actionColStyle = { flexShrink: 0, display: "flex", alignItems: "center", alignSelf: "center" } as const;

function importButtonStyle(disabled: boolean) {
  return { ...glassActionStyle({ height: 44, disabled }), minHeight: 44, minWidth: 72, padding: "0 16px", whiteSpace: "nowrap" } as const;
}

function statusChipStyle(status: EmailAttachmentUiStatus) {
  const ok = status === "imported" || status === "duplicate";
  const bad = status === "failed";
  return {
    borderRadius: TOKEN.radius.pill,
    background: ok ? TOKEN.semantic.success.bgSoft : bad ? TOKEN.semantic.urgent.bgSoft : TOKEN.surface.inset,
    border: `1px solid ${ok ? TOKEN.semantic.success.border : bad ? TOKEN.semantic.urgent.border : TOKEN.border.DEFAULT}`,
    color: ok ? TOKEN.semantic.success.ink : bad ? TOKEN.semantic.urgent.ink : TOKEN.ink.secondary,
    padding: "4px 10px",
    fontSize: TOKEN.font.meta,
    fontWeight: TOKEN.weight.bold,
    whiteSpace: "nowrap",
  } as const;
}
