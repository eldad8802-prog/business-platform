"use client";

/**
 * Legal identity corrections — the approver's console (owner decision 2026-11-13). Only a platform admin holding the
 * dedicated permission gets data here; anyone else gets the server's refusal, shown plainly.
 *
 *   CorrectionsListSurface    open requests (or the whole history): business, kind, status, masked numbers.
 *   CorrectionDetailSurface   current vs requested side by side, the reason, the requester, the documents, and the
 *                             three actions. "Request more information" is the safe default; approving needs an
 *                             explicit statement that identity, documents and legal entity were checked; every action
 *                             needs notes. Decisions trigger a fresh MFA step-up (the dialog answers the server's 403).
 * The number's check is a local FORMAT check only — never presented as verified with any authority.
 */
import Link from "next/link";
import { useState } from "react";

import {
  decideLegalIdentityCorrection,
  downloadLegalIdentityCorrectionAttachment,
  fetchLegalIdentityCorrection,
  fetchLegalIdentityCorrections,
  requestLegalIdentityCorrectionInfo,
} from "@/lib/platform-admin/fetch-platform-admin";
import type { CorrectionDetail, CorrectionListItem } from "@/lib/services/platform-admin/legal-identity-corrections.service";

import { EmptyBlock, ErrorBlock, LoadingBlock, describeAdminError } from "./console-states";
import { useAdminLoad } from "./use-admin-load";
import styles from "./admin-console.module.css";

const timeFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "short" });
const fmt = (iso: string | null) => (iso ? timeFmt.format(new Date(iso)) : "—");

const KIND_HE: Record<string, string> = { TYPO_CORRECTION: "תיקון טעות", BUSINESS_KIND_CHANGE: "שינוי סוג עסק (אותה ישות)" };
const BUSINESS_KIND_HE: Record<string, string> = { EXEMPT_DEALER: "עוסק פטור", AUTHORIZED_DEALER: "עוסק מורשה", LTD_COMPANY: "חברה בע״מ" };
const VERIFY_HE: Record<string, string> = { PASSWORD: "סיסמה", RECENT_SIGN_IN: "התחברות Google עדכנית" };

function statusPill(status: string, infoRequested: boolean) {
  if (status === "PENDING" && infoRequested) return <span className={`${styles.pill} ${styles.pillInfo}`}>התבקש מידע נוסף</span>;
  switch (status) {
    case "PENDING":
      return <span className={`${styles.pill} ${styles.pillWarn}`}>ממתין לבדיקה</span>;
    case "APPLIED":
      return <span className={`${styles.pill} ${styles.pillOk}`}>אושר ובוצע</span>;
    case "REJECTED":
      return <span className={`${styles.pill} ${styles.pillBad}`}>נדחה</span>;
    case "CANCELLED":
      return <span className={`${styles.pill} ${styles.pillNeutral}`}>בוטל</span>;
    case "STALE":
      return <span className={`${styles.pill} ${styles.pillNeutral}`}>לא בוצע — הפרטים השתנו</span>;
    default:
      return <span className={`${styles.pill} ${styles.pillNeutral}`}>{status}</span>;
  }
}

export function CorrectionsListSurface() {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const load = useAdminLoad(`lic-list:${filter}`, () => fetchLegalIdentityCorrections(filter));
  const items: CorrectionListItem[] = load.data?.items ?? [];

  return (
    <section className={styles.card} data-testid="lic-list">
      <div className={styles.cardHead}>
        <h2>בקשות לתיקון זהות עסקית</h2>
        <div className={styles.chips}>
          <button type="button" className={styles.chip} aria-pressed={filter === "open"} onClick={() => setFilter("open")}>
            פתוחות
          </button>
          <button type="button" className={styles.chip} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            כל ההיסטוריה
          </button>
        </div>
      </div>
      <p className={styles.note}>
        המספרים מוצגים כאן חלקית. הפרטים המלאים מוצגים בפתיחת בקשה, והצפייה נרשמת ביומן הפעולות.
      </p>
      {load.loading ? (
        <LoadingBlock label="טוען בקשות…" />
      ) : load.error ? (
        <ErrorBlock error={load.error} onRetry={load.reload} />
      ) : items.length === 0 ? (
        <EmptyBlock title={filter === "open" ? "אין בקשות פתוחות" : "אין בקשות"} />
      ) : (
        <div className={styles.list}>
          {items.map((r) => (
            <div key={r.id} className={styles.row}>
              <i className={`${styles.stripe} ${r.status === "PENDING" ? styles.stripeHigh : styles.stripeOk}`} aria-hidden="true" />
              <div>
                <span className={styles.rowTitle}>
                  {r.businessName} (#{r.businessId}) · {KIND_HE[r.kind] ?? r.kind}
                </span>
                <span className={styles.rowSub}>
                  {[
                    `בקשה #${r.id}`,
                    `הוגשה ${fmt(r.createdAt)}`,
                    r.currentTaxIdMasked !== r.requestedTaxIdMasked
                      ? `מספר: ${r.currentTaxIdMasked ?? "—"} ← ${r.requestedTaxIdMasked ?? "—"}`
                      : `שם: ${r.currentLegalNameShort ?? "—"} ← ${r.requestedLegalNameShort ?? "—"}`,
                    r.attachmentCount > 0 ? `${r.attachmentCount} מסמכים` : "ללא מסמכים",
                  ].join(" · ")}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {statusPill(r.status, r.infoRequested)}
                <Link href={`/admin/legal-identity-corrections/${r.id}`} className={styles.linkBtn}>
                  פתיחה
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Side({ title, values, other }: {
  title: string;
  values: CorrectionDetail["current"];
  other?: CorrectionDetail["current"];
}) {
  const mark = (a: string | null, b: string | null | undefined) => (other && a !== b ? styles.changed : undefined);
  return (
    <div className={styles.compareCol}>
      <h3>{title}</h3>
      <dl style={{ margin: 0 }}>
        <div className={styles.kvRow}>
          <dt>סוג העסק</dt>
          <dd><span className={mark(values.businessKind, other?.businessKind)}>{BUSINESS_KIND_HE[values.businessKind] ?? values.businessKind}</span></dd>
        </div>
        <div className={styles.kvRow}>
          <dt>השם המשפטי</dt>
          <dd><span className={mark(values.legalName, other?.legalName)}>{values.legalName ?? "—"}</span></dd>
        </div>
        <div className={styles.kvRow}>
          <dt>מספר עוסק / ח״פ</dt>
          <dd><span dir="ltr" className={mark(values.taxId, other?.taxId)}>{values.taxId ?? "—"}</span></dd>
        </div>
      </dl>
    </div>
  );
}

export function CorrectionDetailSurface({ id }: { id: number }) {
  const load = useAdminLoad(`lic-detail:${id}`, () => fetchLegalIdentityCorrection(id));
  const [publicNote, setPublicNote] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [infoNote, setInfoNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (load.loading) return <LoadingBlock label="טוען בקשה…" />;
  if (load.error) return <ErrorBlock error={load.error} onRetry={load.reload} />;
  const r = load.data?.request;
  if (!r) return <EmptyBlock title="הבקשה לא נמצאה" />;
  const open = r.status === "PENDING";

  async function run(action: () => Promise<{ message: string }>) {
    setBusy(true);
    setResult(null);
    try {
      const out = await action();
      setResult({ ok: true, text: out.message });
      setPublicNote("");
      setInternalNote("");
      setInfoNote("");
      setConfirmed(false);
      load.reload();
    } catch (error) {
      const d = describeAdminError(error);
      setResult({ ok: false, text: error instanceof Error && error.message ? error.message : d.body });
    } finally {
      setBusy(false);
    }
  }

  async function download(attachmentId: number, mimeType: string) {
    try {
      const blob = await downloadLegalIdentityCorrectionAttachment(r!.id, attachmentId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `correction-${r!.id}-${attachmentId}.${mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : "ההורדה נכשלה" });
    }
  }

  const notesOk = publicNote.trim().length >= 5 && internalNote.trim().length >= 5;

  return (
    <div style={{ display: "grid", gap: 14 }} data-testid="lic-detail">
      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2>
            בקשה #{r.id} · {r.businessName} (#{r.businessId})
          </h2>
          {statusPill(r.status, r.infoRequestedAt !== null)}
        </div>
        <p className={styles.note}>
          {KIND_HE[r.kind] ?? r.kind} · הוגשה {fmt(r.createdAt)} · אימות המבקש: {VERIFY_HE[r.verification.method] ?? r.verification.method} ({fmt(r.verification.at)})
          {r.sameLegalEntity ? " · המבקש הצהיר שזו אותה ישות משפטית" : ""}
        </p>
        <div className={styles.compare} style={{ marginTop: 10 }}>
          <Side title="הפרטים הנוכחיים (בעת הגשת הבקשה)" values={r.current} />
          <Side title="הפרטים המבוקשים" values={r.requested} other={r.current} />
        </div>
        <p className={styles.note} style={{ marginTop: 8 }}>
          במספר נבדק מבנה המספר וספרת הביקורת בלבד. הוא לא אומת מול רשות המסים או רשם החברות.
        </p>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2>הסיבה, המבקש והמסמכים</h2>
        </div>
        <dl style={{ margin: 0 }}>
          <div className={styles.kvRow}>
            <dt>הסיבה שנמסרה</dt>
            <dd style={{ fontWeight: 400 }}>{r.reason ?? "—"}</dd>
          </div>
          <div className={styles.kvRow}>
            <dt>המבקש</dt>
            <dd style={{ fontWeight: 400 }}>
              {r.requester
                ? `${r.requester.name ?? "—"} · ${r.requester.email ?? "—"} · ${r.requester.emailVerified ? "אימייל מאומת" : "אימייל לא מאומת"}`
                : "המשתמש שהגיש כבר אינו משויך לעסק"}
            </dd>
          </div>
        </dl>
        {r.attachments.length === 0 ? (
          <p className={styles.muted}>לא צורפו מסמכים תומכים.</p>
        ) : (
          <div className={styles.list}>
            {r.attachments.map((a) => (
              <div key={a.id} className={styles.row}>
                <i className={`${styles.stripe} ${styles.stripeOk}`} aria-hidden="true" />
                <div>
                  <span className={styles.rowTitle}>מסמך #{a.id}</span>
                  <span className={styles.rowSub}>
                    {a.mimeType === "application/pdf" ? "PDF" : a.mimeType === "image/png" ? "PNG" : "JPEG"} · {Math.ceil(a.sizeBytes / 1024)} KB · הועלה {fmt(a.createdAt)}
                  </span>
                </div>
                <button type="button" className={styles.linkBtn} onClick={() => void download(a.id, a.mimeType)}>
                  הורדה
                </button>
              </div>
            ))}
          </div>
        )}
        {r.infoRequestedAt ? (
          <p className={styles.note} style={{ marginTop: 8 }}>
            התבקש מידע נוסף ב־{fmt(r.infoRequestedAt)}: {r.infoRequestNote ?? "—"}
          </p>
        ) : null}
      </section>

      {!open ? (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h2>ההחלטה</h2>
          </div>
          <dl style={{ margin: 0 }}>
            <div className={styles.kvRow}>
              <dt>מועד</dt>
              <dd style={{ fontWeight: 400 }}>{fmt(r.decidedAt)}</dd>
            </div>
            <div className={styles.kvRow}>
              <dt>נימוק לבעל העסק</dt>
              <dd style={{ fontWeight: 400 }}>{r.publicNote ?? "—"}</dd>
            </div>
            <div className={styles.kvRow}>
              <dt>נימוק פנימי</dt>
              <dd style={{ fontWeight: 400 }}>{r.internalNote ?? "—"}</dd>
            </div>
            <div className={styles.kvRow}>
              <dt>המאשר</dt>
              <dd style={{ fontWeight: 400 }}>{r.decidedByUserId !== null ? `מנהל #${r.decidedByUserId}` : "—"}</dd>
            </div>
          </dl>
        </section>
      ) : (
        <>
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h2>בקשת מידע נוסף</h2>
            </div>
            <p className={styles.note}>במקרה שאינו חד־משמעי, מחזירים את הבקשה לבעל העסק. הבקשה נשארת פתוחה.</p>
            <label className={styles.field}>
              <span>מה נדרש מבעל העסק (יוצג לו)</span>
              <textarea value={infoNote} onChange={(e) => setInfoNote(e.target.value)} maxLength={1000} />
            </label>
            <div className={styles.actionsRow}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={busy || infoNote.trim().length < 5}
                onClick={() => void run(() => requestLegalIdentityCorrectionInfo(r.id, infoNote.trim()))}
              >
                החזרה לבעל העסק
              </button>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h2>החלטה</h2>
            </div>
            <label className={styles.field}>
              <span>נימוק לבעל העסק (יוצג לו, 5–1000 תווים)</span>
              <textarea value={publicNote} onChange={(e) => setPublicNote(e.target.value)} maxLength={1000} />
            </label>
            <label className={styles.field}>
              <span>נימוק פנימי (לצוות בלבד, 5–2000 תווים)</span>
              <textarea value={internalNote} onChange={(e) => setInternalNote(e.target.value)} maxLength={2000} />
            </label>
            <label className={styles.confirmRow}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>בדקתי את זהות המבקש ואת המסמכים, וזו אותה ישות משפטית.</span>
            </label>
            <div className={styles.actionsRow}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={busy || !notesOk || !confirmed}
                onClick={() =>
                  void run(() => decideLegalIdentityCorrection(r.id, { approve: true, publicNote: publicNote.trim(), internalNote: internalNote.trim(), confirmedReview: true }))
                }
              >
                אישור וביצוע התיקון
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnDanger}`}
                disabled={busy || !notesOk}
                onClick={() =>
                  void run(() => decideLegalIdentityCorrection(r.id, { approve: false, publicNote: publicNote.trim(), internalNote: internalNote.trim(), confirmedReview: false }))
                }
              >
                דחייה
              </button>
            </div>
            <p className={styles.note} style={{ marginTop: 8 }}>
              לפני ביצוע תתבקש אימות נוסף. האישור מעדכן את פרטי העסק לפעולות עתידיות בלבד: מסמכים שכבר הופקו אינם משתנים.
            </p>
          </section>
        </>
      )}

      {result ? (
        <p role="status" className={styles.note} style={{ color: result.ok ? "var(--dz-success)" : "var(--dz-danger)" }}>
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
