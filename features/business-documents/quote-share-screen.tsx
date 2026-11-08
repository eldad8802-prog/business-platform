"use client";

/**
 * ר1 — follow-up of one quote: a NEW copy rendered from the quote and stored for sharing, and the owner's own manual
 * record. Behind business_documents (off by default).
 *
 * What this screen never claims: delivery, reading, or the customer's actual answer. "Downloaded", "share sheet
 * opened" and "marked as sent by you" are three different records, each written only by its own explicit action;
 * serving the file records nothing. The copy is a new file of this screen — never the PDF the existing quote screen
 * produced earlier.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";

import {
  fetchCopyPdf,
  getQuoteShare,
  issueKey,
  prepareShareCopy,
  recordShareEvent,
  ShareRequestError,
  type QuoteShareViewWire,
  type ShareEventKindWire,
} from "./business-documents-client";
import { Empty, FeatureOff, LoadError, Loading, ScreenHead } from "./ui";
import s from "./docs.module.css";

const EVENT_LABEL: Record<ShareEventKindWire, string> = {
  DOWNLOADED: "הקובץ הורד מהמסך",
  SHARE_SHEET_OPENED: "נפתח חלון שיתוף במכשיר",
  MARKED_SENT: "סימנת שההצעה נשלחה (רישום ידני)",
  RESPONSE_ACCEPTED: "רשמת: הלקוח אישר",
  RESPONSE_DECLINED: "רשמת: הלקוח דחה",
  NOTE: "הערה",
  CORRECTION: "סימנת רישום כשגוי",
};
const CHANNEL_LABEL: Record<string, string> = { WHATSAPP: "וואטסאפ", EMAIL: "אימייל", PRINT: "הדפסה / מסירה ביד", OTHER: "אחר" };
const CORRECTABLE = new Set<ShareEventKindWire>(["MARKED_SENT", "RESPONSE_ACCEPTED", "RESPONSE_DECLINED"]);

const dateTime = (iso: string) => new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const dateOnly = (iso: string) => new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
const money = (v: string, currency: string) => {
  try {
    return new Intl.NumberFormat("he-IL", { style: "currency", currency }).format(Number(v));
  } catch {
    return `${v} ${currency}`;
  }
};
/** Retrying the same action keeps its key; only these answers mean "this key is finished". */
const keyFinished = (e: unknown) => e instanceof ShareRequestError && ["IDEMPOTENCY_CONFLICT", "UNKNOWN_KEY", "EXPIRED", "VALIDATION", "NOT_FOUND"].includes(e.code);

export function QuoteShareScreen({ quoteId }: { quoteId: number }) {
  const on = useFeatureState("business_documents");
  const [view, setView] = useState<QuoteShareViewWire | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [channel, setChannel] = useState("WHATSAPP");
  const [note, setNote] = useState("");
  const keys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    try {
      setView(await getQuoteShare(quoteId));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [quoteId]);

  useEffect(() => {
    if (!on) return;
    let live = true;
    getQuoteShare(quoteId).then(
      (v) => {
        if (!live) return;
        setView(v);
        setLoadFailed(false);
      },
      () => live && setLoadFailed(true)
    );
    return () => {
      live = false;
    };
  }, [on, quoteId]);

  /** Run one action with its own server-issued key; the same action retried reuses the key it got. */
  async function act(signature: string, operation: "QUOTE_SHARE_COPY" | "QUOTE_SHARE_EVENT", run: (key: string) => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(signature);
    setMessage(null);
    try {
      let key = keys.current.get(signature);
      if (!key) {
        key = await issueKey(operation);
        keys.current.set(signature, key);
      }
      await run(key);
      keys.current.delete(signature);
      setMessage({ tone: "ok", text: done });
      await load();
    } catch (e) {
      if (keyFinished(e)) keys.current.delete(signature);
      setMessage({ tone: "error", text: e instanceof ShareRequestError ? e.message : "הפעולה נכשלה. נסו שוב." });
    } finally {
      setBusy(null);
    }
  }

  const latest = view?.copies[0] ?? null;
  const fileName = latest ? `הצעת-מחיר-${latest.quoteNumber}.pdf` : "quote.pdf";

  async function download() {
    if (!latest) return;
    await act(`download:${latest.id}:${Date.now()}`, "QUOTE_SHARE_EVENT", async (key) => {
      const blob = await fetchCopyPdf(latest.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      await recordShareEvent(quoteId, key, { kind: "DOWNLOADED", copyId: latest.id });
    }, "הקובץ הורד. נרשם: הורדה מהמסך.");
  }

  async function share() {
    if (!latest) return;
    await act(`share:${latest.id}:${Date.now()}`, "QUOTE_SHARE_EVENT", async (key) => {
      const blob = await fetchCopyPdf(latest.id);
      const file = new File([blob], fileName, { type: "application/pdf" });
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (!nav.share || !nav.canShare?.({ files: [file] })) throw new ShareRequestError(null, "VALIDATION", "המכשיר לא תומך בשיתוף קבצים. אפשר להוריד את הקובץ ולשתף אותו ידנית.");
      try {
        await nav.share({ files: [file], title: fileName });
      } catch (e) {
        // The sheet was opened and closed without choosing: still "opened". Anything else: nothing is recorded.
        if (!(e instanceof DOMException && e.name === "AbortError")) throw new ShareRequestError(null, "VALIDATION", "חלון השיתוף לא נפתח.");
      }
      await recordShareEvent(quoteId, key, { kind: "SHARE_SHEET_OPENED", copyId: latest.id });
    }, "נרשם: נפתח חלון שיתוף. אם שלחת — סמן זאת בנפרד.");
  }

  if (on === false) return <Shell><FeatureOff /></Shell>;
  if (on === null || (!view && !loadFailed)) return <Shell><Loading /></Shell>;
  if (!view) return <Shell><LoadError text="לא הצלחנו לטעון את ההצעה." onRetry={() => void load()} /></Shell>;

  const q = view.quote;
  const shareSupported = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <Shell title={`מעקב הצעת מחיר ${q.number ?? ""}`.trim()}>
      <section className={s.section}>
        <p className={s.rowTitle}>{q.customerName ?? "ללא שם לקוח"} · {money(q.total, q.currency)}</p>
        <p className={s.rowSub}>
          {q.validUntil ? `בתוקף עד ${dateOnly(q.validUntil)}` : "ללא תאריך תוקף"}
          {q.convertedToInvoice ? " · הומרה לחשבונית" : ""}
        </p>
        <p className={s.rowSub}>
          {view.state.response === "ACCEPTED" ? "רשמת שהלקוח אישר. " : view.state.response === "DECLINED" ? "רשמת שהלקוח דחה. " : ""}
          {view.state.sentAt ? `סימנת שנשלחה ב־${dateTime(view.state.sentAt)}.` : "לא סימנת שליחה של הגרסה הנוכחית."}
          {view.state.staleResponses > 0 ? " יש תגובות שנרשמו על גרסה קודמת של ההצעה." : ""}
        </p>
      </section>

      {q.serviceDesk ? (
        <Empty title="הצעה זו שייכת למוקד השירות">מעקב ושליחה של הצעות שירות נעשים במוקד השירות.</Empty>
      ) : !q.number ? (
        <section className={s.section}>
          <p className={s.note}>להצעה אין עדיין מספר. הפיקו PDF פעם אחת במסך ההצעה (שם ההצעה ממוספרת), ואז חזרו לכאן.</p>
          <Link className={s.button} href={`/billing/${q.id}`}>למסך ההצעה</Link>
        </section>
      ) : (
        <>
          <section className={s.section}>
            <h2 className={s.sectionTitle}>עותק לשיתוף</h2>
            <p className={s.note}>עותק חדש שנוצר מההצעה כפי שהיא עכשיו ונשמר לשיתוף. זה אינו הקובץ שהופק בעבר במסך ההצעה.</p>
            {latest ? (
              <div className={s.row} style={{ cursor: "default" }}>
                <span className={s.rowText}>
                  <span className={s.rowTitle}>עותק מ־{dateTime(latest.createdAt)}</span>
                  <span className={s.rowSub}>{money(latest.total, latest.currency)}</span>
                </span>
                {latest.changedSince ? <span className={`${s.tag} ${s.tagWarn}`}>ההצעה שונתה מאז העותק</span> : <span className={`${s.tag} ${s.tagOk}`}>תואם להצעה הנוכחית</span>}
              </div>
            ) : null}
            <div className={s.actions}>
              <button type="button" className={`${s.button} ${latest ? "" : s.primary}`} disabled={!!busy} onClick={() => void act(`copy:${quoteId}`, "QUOTE_SHARE_COPY", (key) => prepareShareCopy(quoteId, key), "נוצר עותק חדש ונשמר לשיתוף.")}>
                {busy?.startsWith("copy:") ? "מכין עותק…" : latest ? "הכנת עותק חדש" : "הכנת עותק לשיתוף"}
              </button>
              {latest ? (
                <>
                  <button type="button" className={s.button} disabled={!!busy} onClick={() => void download()}>הורדת הקובץ</button>
                  {shareSupported ? <button type="button" className={s.button} disabled={!!busy} onClick={() => void share()}>שיתוף…</button> : null}
                </>
              ) : null}
            </div>
          </section>

          {latest ? (
            <section className={s.section}>
              <h2 className={s.sectionTitle}>סימון כנשלח</h2>
              <p className={s.hint}>רישום ידני שלך. המערכת לא שולחת דבר ללקוח ואינה יודעת אם ההצעה נמסרה או נקראה.</p>
              <div className={s.field}>
                <label className={s.label} htmlFor="share-channel">איך שלחת</label>
                <select id="share-channel" className={s.select} value={channel} onChange={(e) => setChannel(e.target.value)}>
                  {Object.entries(CHANNEL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className={s.actions}>
                <button type="button" className={`${s.button} ${s.primary}`} disabled={!!busy} onClick={() => void act(`sent:${latest.id}:${channel}`, "QUOTE_SHARE_EVENT", (key) => recordShareEvent(quoteId, key, { kind: "MARKED_SENT", copyId: latest.id, channel }), "נרשם: סימנת שההצעה נשלחה.")}>
                  סימנתי שנשלחה
                </button>
              </div>
            </section>
          ) : null}

          <section className={s.section}>
            <h2 className={s.sectionTitle}>תגובת הלקוח (כפי שתרשום)</h2>
            <div className={s.actions}>
              <button type="button" className={s.button} disabled={!!busy} onClick={() => void act(`accepted:${view.currentContentHash}`, "QUOTE_SHARE_EVENT", (key) => recordShareEvent(quoteId, key, { kind: "RESPONSE_ACCEPTED" }), "נרשם: הלקוח אישר.")}>הלקוח אישר</button>
              <button type="button" className={s.button} disabled={!!busy} onClick={() => void act(`declined:${view.currentContentHash}`, "QUOTE_SHARE_EVENT", (key) => recordShareEvent(quoteId, key, { kind: "RESPONSE_DECLINED" }), "נרשם: הלקוח דחה.")}>הלקוח דחה</button>
            </div>
            <div className={s.field}>
              <label className={s.label} htmlFor="share-note">הערה (אינה אישור ואינה דחייה)</label>
              <textarea id="share-note" className={s.textarea} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className={s.actions}>
              <button type="button" className={s.button} disabled={!!busy || !note.trim()} onClick={() => void act(`note:${note.trim()}`, "QUOTE_SHARE_EVENT", async (key) => { await recordShareEvent(quoteId, key, { kind: "NOTE", note: note.trim() }); setNote(""); }, "ההערה נשמרה.")}>שמירת הערה</button>
            </div>
          </section>
        </>
      )}

      {message ? <p className={message.tone === "error" ? s.error : s.note} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p> : null}

      <section className={s.section}>
        <h2 className={s.sectionTitle}>הרישומים שלך</h2>
        {view.events.length === 0 ? (
          <p className={s.note}>עוד אין רישומים.</p>
        ) : (
          <ul className={s.list}>
            {view.events.map((e) => (
              <li key={e.id} className={s.row} style={{ cursor: "default" }}>
                <span className={s.rowText}>
                  <span className={s.rowTitle} style={e.corrected ? { textDecoration: "line-through" } : undefined}>
                    {EVENT_LABEL[e.kind]}{e.channel ? ` · ${CHANNEL_LABEL[e.channel] ?? e.channel}` : ""}
                  </span>
                  <span className={s.rowSub}>{dateTime(e.createdAt)}{e.note ? ` · ${e.note}` : ""}</span>
                </span>
                <span className={s.rowEnd}>
                  {e.corrected ? <span className={s.tag}>סומן כשגוי</span> : null}
                  {e.olderVersion && !e.corrected ? <span className={`${s.tag} ${s.tagWarn}`}>גרסה קודמת</span> : null}
                  {CORRECTABLE.has(e.kind) && !e.corrected ? (
                    <button type="button" className={s.button} disabled={!!busy} onClick={() => void act(`correct:${e.id}`, "QUOTE_SHARE_EVENT", (key) => recordShareEvent(quoteId, key, { kind: "CORRECTION", correctsEventId: e.id }), "הרישום סומן כשגוי.")}>סימון כשגוי</button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}

function Shell({ title = "מעקב הצעת מחיר", children }: { title?: string; children: React.ReactNode }) {
  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title={title} subtitle="רישום ידני שלך — לא אישור מסירה" fallback="/business-documents" fallbackLabel="למסמכים נוספים" />
        {children}
      </div>
    </main>
  );
}
