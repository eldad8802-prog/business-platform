"use client";

/**
 * One month of the accountant workflow: where it stands, what is open, the package, the recipient,
 * sending and the history of sends. Every number here comes from the server's period view.
 */

import { useState } from "react";

import type { DeliveryView, PeriodView } from "@/lib/accountant/view.service";
import { TOKEN, chipActionStyle, dangerActionStyle, glassActionStyle, primaryActionStyle } from "@/lib/design/documents-theme";

import { ApiError, cancelSend, completeManually, downloadPackage, preparePeriod, revokeLink, saveRecipient } from "./accountant-client";
import {
  blockerHe,
  blockerHref,
  deliveryAccessHe,
  deliveryStatusHe,
  deliveryTone,
  errorHe,
  formatBytes,
  formatDateTimeHe,
  warningHe,
} from "./labels";
import { SendDialog } from "./SendDialog";

type Props = { token: string; period: PeriodView; onChange: (next: PeriodView) => void; onReload: () => Promise<void> };

export function AccountantMonthPanel({ token, period, onChange, onReload }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [sendOpen, setSendOpen] = useState(false);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? errorHe(e.code) : errorHe("INTERNAL"));
    } finally {
      setBusy(null);
    }
  }

  const pkg = period.currentPackage;
  const blockers = period.readiness?.blockers ?? [];
  const warnings = period.readiness?.warnings ?? [];
  const inFlight = period.deliveries.find((d) => d.status === "APPROVED" || d.status === "SENDING") ?? null;
  const canSend = !!pkg && pkg.status === "READY" && !!period.recipient && period.sendingAvailable && !inFlight;
  const latestSend = period.deliveries.find((d) => d.status !== "CANCELED") ?? null;

  return (
    <>
      <section style={card} aria-labelledby="month-status">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
          <h2 id="month-status" style={h2}>{period.label}</h2>
          {period.statusLabel ? <span style={pill(toneOf(period))}>{period.statusLabel}</span> : null}
        </div>

        {!period.closed ? <p style={muted}>החודש עדיין לא הסתיים. החבילה תוכן אוטומטית ב־1 לחודש הבא.</p> : null}
        {period.closed && !period.prepared ? (
          <>
            <p style={muted}>החבילה לחודש הזה עוד לא הוכנה.</p>
            <button type="button" style={primaryActionStyle({ height: 48, disabled: busy !== null })} disabled={busy !== null}
              onClick={() => void run("prepare", async () => onChange(await preparePeriod(token, period.periodKey)))}>
              {busy === "prepare" ? "מכין…" : "הכן את החבילה עכשיו"}
            </button>
          </>
        ) : null}

        {period.changedSinceSent ? (
          <div style={banner("attention")} role="status">
            נוספו או השתנו נתונים לחודש הזה אחרי שהחבילה נשלחה. הכנו גרסה מעודכנת — היא לא תישלח בלי אישור שלך.
          </div>
        ) : null}
        {period.completedManually ? <p style={muted}>סימנת שהחבילה נשלחה מחוץ ל־Dubiz.</p> : null}

        {blockers.length > 0 ? (
          <div style={{ marginTop: 14 }}>
            <div style={label}>מה עדיין פתוח</div>
            <ul style={list}>
              {blockers.map((b) => {
                const link = blockerHref(b, period.periodKey);
                return (
                  <li key={b.kind} style={listItem}>
                    <span>{blockerHe(b)}</span>
                    {link ? <a href={link.href} style={chipLink}>{link.label}</a> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : period.prepared && period.closed ? (
          <p style={{ ...muted, color: TOKEN.semantic.success.ink }}>אין פריטים פתוחים בדוביז לחודש הזה.</p>
        ) : null}

        {warnings.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <div style={label}>לתשומת לב</div>
            <ul style={list}>
              {warnings.map((w) => (
                <li key={w.kind} style={listItem}><span>{warningHe(w)}</span></li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {pkg ? (
        <section style={card} aria-labelledby="month-package">
          <h3 id="month-package" style={h3}>החבילה</h3>
          <dl style={facts}>
            <Row k="גרסה" v={`${pkg.version} · הוכנה ${formatDateTimeHe(pkg.readyAt)}`} />
            <Row k="מסמכים סרוקים שאושרו" v={String(pkg.recordCount)} />
            <Row k="מסמכים שהופקו בדוביז" v={String(pkg.issuedCount)} />
            <Row k="ממתינים (ברשימה בלבד)" v={String(pkg.pendingCount)} />
            {/* LTR isolate: "11 KB" must not reorder into "KB 11" inside Hebrew text. */}
            <Row k="גודל" v={`⁦${formatBytes(pkg.sizeBytes)}⁩`} last />
          </dl>
          <p style={muted}>החבילה מרכזת את מה שקיים בדוביז לחודש הזה. היא אינה מאשרת שהנהלת החשבונות שלמה.</p>
          <div role="group" aria-label="הורדה" style={downloads}>
            <button type="button" style={glassActionStyle({ height: 46 })} disabled={busy !== null}
              onClick={() => void run("download", () => downloadPackage(token, pkg.id, "zip"))}>
              {busy === "download" ? "מוריד…" : "הורד חבילה מלאה (ZIP)"}
            </button>
            <button type="button" style={glassActionStyle({ height: 46 })} disabled={busy !== null}
              onClick={() => void run("download-xlsx", () => downloadPackage(token, pkg.id, "xlsx"))}>
              {busy === "download-xlsx" ? "מכין…" : "הורד דוח (Excel)"}
            </button>
            <button type="button" style={glassActionStyle({ height: 46 })} disabled={busy !== null}
              onClick={() => void run("download-pdf", () => downloadPackage(token, pkg.id, "pdf"))}>
              {busy === "download-pdf" ? "מכין…" : "הורד דוח (PDF)"}
            </button>
          </div>
          <p style={muted}>דוח ה־Excel הוא הקובץ שבתוך החבילה עצמה, וה־PDF מציג אותו להדפסה — בלי שינוי ובלי חישוב מחדש.</p>
          <div style={buttons}>
            <button type="button" style={glassActionStyle({ height: 46 })} disabled={busy !== null}
              onClick={() => void run("prepare", async () => onChange(await preparePeriod(token, period.periodKey)))}>
              {busy === "prepare" ? "בודק…" : "בדוק שוב והכן מחדש"}
            </button>
          </div>
        </section>
      ) : null}

      {period.closed && period.prepared ? (
        <RecipientCard token={token} period={period} onSaved={onReload} />
      ) : null}

      {pkg ? (
        <section style={card} aria-labelledby="month-send">
          <h3 id="month-send" style={h3}>שליחה לרואה החשבון</h3>
          {!period.sendingAvailable ? (
            <p style={muted}>השליחה מתוך Dubiz עדיין לא הופעלה. אפשר להוריד את החבילה ולשלוח אותה בעצמך.</p>
          ) : !period.recipient ? (
            <p style={muted}>כדי לשלוח, הגדירו קודם את רואה החשבון.</p>
          ) : inFlight ? (
            <p style={muted}>השליחה בדרך…</p>
          ) : null}
          <div style={buttons}>
            <button type="button" style={primaryActionStyle({ height: 48, disabled: !canSend || busy !== null })} disabled={!canSend || busy !== null}
              onClick={() => setSendOpen(true)}>
              {latestSend && (latestSend.status === "FAILED" || latestSend.status === "BOUNCED") ? "שלח שוב" : "שלח לרואה החשבון"}
            </button>
            {pkg.status === "READY" && !period.completedManually && !inFlight ? (
              <button type="button" style={chipActionStyle(false)} disabled={busy !== null}
                onClick={() => {
                  if (!window.confirm("לסמן שהחבילה של החודש הזה נשלחה לרואה החשבון מחוץ ל־Dubiz?")) return;
                  void run("manual", async () => onChange(await completeManually(token, period.periodKey, pkg.id)));
                }}>
                שלחתי בעצמי
              </button>
            ) : null}
          </div>
          {period.deliveries.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <div style={label}>שליחות</div>
              <ul style={list}>
                {period.deliveries.map((d) => (
                  <DeliveryRow key={d.id} d={d} busy={busy !== null}
                    onRevoke={() => void run(`revoke-${d.id}`, async () => { await revokeLink(token, d.id); await onReload(); })}
                    onCancel={() => void run(`cancel-${d.id}`, async () => { await cancelSend(token, d.id); await onReload(); })} />
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {error ? <div style={banner("urgent")} role="alert">{error}</div> : null}

      {sendOpen && pkg && period.recipient ? (
        <SendDialog token={token} period={period} previousUncertain={latestSend?.outcomeUncertain === true} onClose={() => setSendOpen(false)}
          onSent={(next) => { setSendOpen(false); onChange(next); }} />
      ) : null}
    </>
  );
}

function DeliveryRow({ d, busy, onRevoke, onCancel }: { d: DeliveryView; busy: boolean; onRevoke: () => void; onCancel: () => void }) {
  const linkLive = d.linkState === "live";
  const access = deliveryAccessHe(d);
  return (
    <li style={{ ...listItem, flexDirection: "column", alignItems: "stretch" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <strong>גרסה {d.packageVersion} · <span dir="ltr">{d.recipientEmail ?? "—"}</span></strong>
        <span style={pill(deliveryTone(d))}>{deliveryStatusHe(d)}</span>
      </div>
      <div style={{ ...muted, margin: "6px 0 0" }}>
        אושר {formatDateTimeHe(d.approvedAt)}
        {d.incompleteAcknowledged ? ` · אושר למרות ${d.openItemCount} פריטים פתוחים` : ""}
        {d.acceptedAt ? ` · התקבל אצל ספק המייל ${formatDateTimeHe(d.acceptedAt)}` : ""}
        {d.deliveredAt ? ` · נמסר ${formatDateTimeHe(d.deliveredAt)}` : ""}
        {d.nextAttemptAt ? ` · ניסיון נוסף ב־${formatDateTimeHe(d.nextAttemptAt)}` : ""}
      </div>
      {d.outcomeUncertain ? (
        <div style={{ ...banner("attention"), marginTop: 8, fontWeight: TOKEN.weight.semibold }} role="status">
          ספק המייל לא אישר ולא דחה את המייל, ולכן ייתכן שהוא הגיע לרואה החשבון. לפני שליחה חוזרת כדאי לבדוק איתו —
          שליחה חוזרת היא מייל חדש.
        </div>
      ) : null}
      {access.length > 0 ? (
        <ul style={{ ...muted, margin: "6px 0 0", paddingInlineStart: 18 }}>
          {access.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        {linkLive ? (
          <button type="button" style={dangerActionStyle({ height: 38 })} disabled={busy}
            onClick={() => window.confirm("לבטל את הקישור? רואה החשבון לא יוכל להוריד יותר את החבילה הזו.") && onRevoke()}>
            בטל קישור
          </button>
        ) : null}
        {d.status === "APPROVED" ? (
          <button type="button" style={glassActionStyle({ height: 38 })} disabled={busy} onClick={onCancel}>בטל שליחה</button>
        ) : null}
      </div>
    </li>
  );
}

function RecipientCard({ token, period, onSaved }: { token: string; period: PeriodView; onSaved: () => Promise<void> }) {
  const r = period.recipient;
  const [editing, setEditing] = useState(!r);
  const [name, setName] = useState(r?.name ?? "");
  const [email, setEmail] = useState(r?.email ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const changing = !!r && (r.email !== email.trim().toLowerCase() || r.name !== name.trim());

  async function save() {
    setSaving(true);
    setError("");
    try {
      await saveRecipient(token, { name, email, expectedVersion: r?.version ?? null });
      setEditing(false);
      setConfirmed(false);
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? errorHe(e.code) : errorHe("INTERNAL"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={card} aria-labelledby="month-recipient">
      <h3 id="month-recipient" style={h3}>רואה החשבון</h3>
      {!editing && r ? (
        <>
          <p style={{ margin: 0, fontWeight: TOKEN.weight.bold }}>{r.name}</p>
          <p style={{ margin: "4px 0 0" }} dir="ltr">{r.email}</p>
          <button type="button" style={{ ...chipActionStyle(false), marginTop: 12 }} onClick={() => setEditing(true)}>שינוי פרטים</button>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (confirmed && !saving) void save(); }}>
          <label style={field}>
            <span style={label}>שם</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" style={input} required />
          </label>
          <label style={field}>
            <span style={label}>אימייל</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" autoComplete="email" dir="ltr" maxLength={254} style={input} required />
          </label>
          {changing ? <p style={muted}>שינוי הפרטים מבטל אישורי שליחה שעוד לא יצאו. שליחות קודמות לא משתנות.</p> : null}
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "10px 0", cursor: "pointer" }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ width: 20, height: 20 }} />
            <span>אני מאשר/ת שזו הכתובת של רואה החשבון שלי</span>
          </label>
          {error ? <div style={banner("urgent")} role="alert">{error}</div> : null}
          <div style={buttons}>
            <button type="submit" style={primaryActionStyle({ height: 46, disabled: !confirmed || saving })} disabled={!confirmed || saving}>
              {saving ? "שומר…" : "שמירה"}
            </button>
            {r ? (
              <button type="button" style={glassActionStyle({ height: 46 })} onClick={() => { setEditing(false); setName(r.name); setEmail(r.email); setConfirmed(false); }}>
                ביטול
              </button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}

function Row({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <div style={{ ...factRow, ...(last ? { borderBottom: "none" } : {}) }}>
      <dt style={factKey}>{k}</dt>
      <dd style={factVal}>{v}</dd>
    </div>
  );
}

type Tone = "success" | "attention" | "urgent" | "info";

function toneOf(p: PeriodView): Tone {
  if (p.changedSinceSent) return "attention";
  switch (p.status) {
    case "SENT":
    case "COMPLETED_MANUALLY":
    case "READY_FOR_REVIEW":
      return "success";
    case "PREPARATION_FAILED":
    case "SEND_FAILED":
      return "urgent";
    case "NEEDS_ATTENTION":
      return "attention";
    default:
      return "info";
  }
}

function pill(tone: Tone) {
  const t = TOKEN.semantic[tone];
  return {
    display: "inline-block",
    padding: "4px 10px",
    borderRadius: TOKEN.radius.pill,
    border: `1px solid ${t.border}`,
    background: t.bgSoft,
    color: t.ink,
    fontSize: TOKEN.font.meta,
    fontWeight: TOKEN.weight.bold,
  } as const;
}

function banner(tone: Tone) {
  const t = TOKEN.semantic[tone];
  return {
    marginTop: 12,
    border: `1px solid ${t.border}`,
    background: t.bgSoft,
    color: t.ink,
    borderRadius: TOKEN.radius.card,
    padding: "12px 14px",
    fontWeight: TOKEN.weight.bold,
    lineHeight: 1.6,
  } as const;
}

const card = {
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: "16px",
  marginBottom: 14,
} as const;
const h2 = { margin: 0, fontSize: TOKEN.font.display, fontWeight: TOKEN.weight.bold } as const;
const h3 = { margin: "0 0 10px", fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold } as const;
const label = { color: TOKEN.ink.secondary, fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, marginBottom: 6, display: "block" } as const;
const muted = { margin: "8px 0", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta, lineHeight: 1.6 } as const;
const list = { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 } as const;
const listItem = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap" as const,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  padding: "10px 12px",
  lineHeight: 1.5,
} as const;
const chipLink = { ...chipActionStyle(false), minHeight: 34, padding: "0 12px", textDecoration: "none" } as const;
const facts = { margin: 0, border: `1px solid ${TOKEN.border.DEFAULT}`, borderRadius: TOKEN.radius.card, padding: "2px 14px" } as const;
const factRow = { display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderBottom: `1px solid ${TOKEN.border.DEFAULT}` } as const;
const factKey = { color: TOKEN.ink.muted, fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.semibold } as const;
const factVal = { margin: 0, fontWeight: TOKEN.weight.bold, textAlign: "left" as const } as const;
const buttons = { display: "flex", gap: 10, flexWrap: "wrap" as const, marginTop: 12 } as const;
// Side by side on a desktop, one under the other (full width) on a phone.
const downloads = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginTop: 12 } as const;
const field = { display: "block", marginBottom: 10 } as const;
const input = {
  width: "100%",
  minHeight: 46,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.input,
  padding: "0 12px",
  fontSize: TOKEN.font.body,
  background: TOKEN.surface.card,
  color: TOKEN.ink.primary,
  boxSizing: "border-box" as const,
} as const;
