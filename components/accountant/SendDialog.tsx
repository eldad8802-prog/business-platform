"use client";

/**
 * The owner's approval to send ONE package version to ONE recipient (Option B).
 *
 * D2: when the package has open items, the dialog lists them, says plainly that the package may be
 * incomplete, and the send button stays disabled until a SEPARATE checkbox is ticked — the ordinary
 * "send" can never pass an incomplete package. The approval carries the exact package id + sha256 and the
 * recipient version + email the owner is looking at; the server refuses anything that changed since.
 *
 * When the previous send ended without an answer from the email provider (it may have arrived), sending
 * again is a NEW email: the dialog says so and asks for a separate confirmation as well.
 */

import { useMemo, useState } from "react";

import type { PeriodView } from "@/lib/accountant/view.service";
import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import { TOKEN, glassActionStyle, primaryActionStyle } from "@/lib/design/documents-theme";

import { ApiError, approveSend, newIdempotencyKey } from "./accountant-client";
import { blockerHe, errorHe, formatDateTimeHe } from "./labels";

export function SendDialog({
  token,
  period,
  previousUncertain = false,
  onClose,
  onSent,
}: {
  token: string;
  period: PeriodView;
  previousUncertain?: boolean;
  onClose: () => void;
  onSent: (next: PeriodView) => void;
}) {
  const pkg = period.currentPackage!;
  const recipient = period.recipient!;
  const blockers = period.readiness?.blockers ?? [];
  const incomplete = pkg.openItemCount > 0;
  const [acknowledged, setAcknowledged] = useState(false);
  const [resendAcknowledged, setResendAcknowledged] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // One key per opened dialog: a double click or a retried request is the same approval.
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);

  const canSend = !sending && (!incomplete || acknowledged) && (!previousUncertain || resendAcknowledged);

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError("");
    try {
      const result = await approveSend(
        token,
        period.periodKey,
        {
          packageId: pkg.id,
          packageSha256: pkg.sha256,
          recipientVersion: recipient.version,
          recipientEmail: recipient.email,
          acknowledgeIncomplete: incomplete && acknowledged,
        },
        idempotencyKey
      );
      onSent(result.period);
    } catch (e) {
      setError(e instanceof ApiError ? errorHe(e.code) : errorHe("INTERNAL"));
      setSending(false);
    }
  }

  return (
    // The canonical overlay: a bottom sheet on a phone (over the shell's bottom bar), a centered dialog from
    // 640px, focus trap / Escape / scroll lock — closing is ignored while the send request is in flight.
    <AdaptiveOverlay open onClose={() => !sending && onClose()} variant="form" labelledBy="send-title">
      <div dir="rtl" style={{ color: TOKEN.ink.primary }}>
        <h2 id="send-title" style={title}>שליחה לרואה החשבון</h2>
        <dl style={facts}>
          <div style={factRow}><dt style={factKey}>חודש</dt><dd style={factVal}>{period.label}</dd></div>
          <div style={factRow}><dt style={factKey}>אל</dt><dd style={factVal}>{recipient.name} · <span dir="ltr">{recipient.email}</span></dd></div>
          <div style={factRow}><dt style={factKey}>גרסה</dt><dd style={factVal}>{pkg.version} · הוכנה {formatDateTimeHe(pkg.readyAt)}</dd></div>
          <div style={factRow}><dt style={factKey}>בחבילה</dt><dd style={factVal}>{pkg.recordCount} מסמכים סרוקים · {pkg.issuedCount} מסמכים שהופקו</dd></div>
          <div style={{ ...factRow, borderBottom: "none" }}>
            <dt style={factKey}>קבצים חסרים</dt>
            <dd style={{ ...factVal, color: pkg.missingFiles > 0 ? TOKEN.semantic.attention.ink : undefined }}>{pkg.missingFiles > 0 ? pkg.missingFiles : "אין"}</dd>
          </div>
        </dl>
        <p style={hint}>
          רואה החשבון יקבל מייל עם קישור מאובטח לגרסה הזו בדיוק. בקישור הוא יוכל לפתוח ולהוריד כל מסמך מקור וכל מסמך
          שהופק, כפי שנשמרו בחבילה ובלי שינוי, להוריד את החבילה המלאה (ZIP) ואת הדוחות (Excel ו־PDF), ולראות אילו
          מסמכים חסרים. הקישור בתוקף ל־14 יום ולקריאה בלבד, אפשר לבטל אותו בכל רגע, וכל פתיחה והורדה נרשמות אצלך.
        </p>
        {previousUncertain ? (
          <div style={warnBox} role="alert">
            <strong style={{ display: "block", marginBottom: 6 }}>ייתכן שהשליחה הקודמת כבר הגיעה</strong>
            ספק המייל לא ענה על השליחה הקודמת. שליחה חוזרת היא מייל חדש, ולכן רואה החשבון עלול לקבל שני מיילים.
            <label style={ackRow}>
              <input type="checkbox" checked={resendAcknowledged} onChange={(e) => setResendAcknowledged(e.target.checked)} style={{ width: 20, height: 20 }} />
              <span>הבנתי, ואני מאשר/ת לשלוח שוב</span>
            </label>
          </div>
        ) : null}

        {incomplete ? (
          <div style={{ ...warnBox, marginTop: previousUncertain ? 12 : 0 }} role="alert">
            <strong style={{ display: "block", marginBottom: 6 }}>החבילה הזו אינה שלמה</strong>
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {blockers.map((b) => (
                <li key={b.kind}>{blockerHe(b)}</li>
              ))}
            </ul>
            <label style={ackRow}>
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} style={{ width: 20, height: 20 }} />
              <span>הבנתי שחסרים פריטים, ואני מאשר/ת לשלוח את החבילה כפי שהיא</span>
            </label>
          </div>
        ) : null}

        {error ? <div style={errorBox} role="alert">{error}</div> : null}

        <div style={actions}>
          <button type="button" onClick={() => void send()} disabled={!canSend} style={primaryActionStyle({ disabled: !canSend, height: 48 })}>
            {sending ? "שולח…" : incomplete ? "שלח בכל זאת" : "שלח לרואה החשבון"}
          </button>
          <button type="button" onClick={onClose} disabled={sending} style={glassActionStyle({ height: 48 })}>
            ביטול
          </button>
        </div>
      </div>
    </AdaptiveOverlay>
  );
}

const title = { margin: "0 0 14px", fontSize: TOKEN.font.display, fontWeight: TOKEN.weight.bold } as const;
const facts = { margin: 0, border: `1px solid ${TOKEN.border.DEFAULT}`, borderRadius: TOKEN.radius.card, padding: "2px 14px" } as const;
const factRow = { display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: `1px solid ${TOKEN.border.DEFAULT}` } as const;
const factKey = { color: TOKEN.ink.muted, fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.semibold } as const;
const factVal = { margin: 0, fontWeight: TOKEN.weight.bold, textAlign: "left" as const, minWidth: 0, overflowWrap: "anywhere" as const } as const;
const hint = { margin: "12px 0", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta, lineHeight: 1.6 } as const;
const warnBox = {
  border: `1px solid ${TOKEN.semantic.attention.border}`,
  background: TOKEN.semantic.attention.bgSoft,
  color: TOKEN.semantic.attention.ink,
  borderRadius: TOKEN.radius.card,
  padding: "12px 14px",
  lineHeight: 1.6,
  fontSize: TOKEN.font.body,
} as const;
const ackRow = { display: "flex", gap: 10, alignItems: "flex-start", marginTop: 12, fontWeight: TOKEN.weight.bold, cursor: "pointer" } as const;
const errorBox = {
  marginTop: 12,
  border: `1px solid ${TOKEN.semantic.urgent.border}`,
  background: TOKEN.semantic.urgent.bgSoft,
  color: TOKEN.semantic.urgent.ink,
  borderRadius: TOKEN.radius.card,
  padding: "10px 14px",
  fontWeight: TOKEN.weight.bold,
} as const;
const actions = { display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" as const } as const;
