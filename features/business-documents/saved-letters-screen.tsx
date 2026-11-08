"use client";

/**
 * Saved letters — the letters the owner saved, each with its stored PDF. A saved letter is never edited; hiding it
 * removes it from this list (its record and file stay — retention is not decided yet). Behind business_documents.
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";

import { fetchSavedLetterPdf, hideSavedLetter, listSavedLetters, ShareRequestError, type SavedLetterWire } from "./business-documents-client";
import { Empty, FeatureOff, LoadError, Loading, ScreenHead } from "./ui";
import s from "./docs.module.css";

const KIND_LABEL: Record<SavedLetterWire["recipientKind"], string> = { CUSTOMER: "לקוח", SUPPLIER: "ספק", FREE: "נמען חופשי" };
const day = (iso: string) => new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`));

export function SavedLettersScreen() {
  const on = useFeatureState("business_documents");
  const [letters, setLetters] = useState<SavedLetterWire[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!on) return;
    let live = true;
    listSavedLetters().then((l) => {
      if (!live) return;
      setLetters(l);
      setFailed(false);
    }, () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [on, reload]);

  async function download(l: SavedLetterWire) {
    setBusy(l.id);
    setMessage(null);
    try {
      const url = URL.createObjectURL(await fetchSavedLetterPdf(l.id));
      const a = document.createElement("a");
      a.href = url;
      a.download = `letter-${l.letterDate}-${l.id}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setMessage(e instanceof ShareRequestError ? e.message : "ההורדה נכשלה.");
    } finally {
      setBusy(null);
    }
  }

  async function hide(l: SavedLetterWire) {
    if (!window.confirm("להסתיר את המכתב מהרשימה?")) return;
    setBusy(l.id);
    setMessage(null);
    try {
      await hideSavedLetter(l.id);
      setReload((n) => n + 1);
    } catch (e) {
      setMessage(e instanceof ShareRequestError ? e.message : "הפעולה נכשלה.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="מכתבים שמורים" subtitle="המכתבים ששמרת והקבצים שלהם" fallback="/business-documents" fallbackLabel="למסמכים נוספים" />
        {on === false ? (
          <FeatureOff />
        ) : on === null || (letters === null && !failed) ? (
          <Loading />
        ) : failed ? (
          <LoadError text="לא הצלחנו לטעון את המכתבים." onRetry={() => setReload((n) => n + 1)} />
        ) : letters!.length === 0 ? (
          <Empty title="אין עדיין מכתבים שמורים">
            <Link href="/business-documents/letters/new">מכתב חדש</Link>
          </Empty>
        ) : (
          <>
            {message ? <p className={s.error} role="alert">{message}</p> : null}
            <ul className={s.list}>
              {letters!.map((l) => (
                <li key={l.id} className={s.row} style={{ cursor: "default" }}>
                  <span className={s.rowText}>
                    <span className={s.rowTitle}>{l.subject}</span>
                    <span className={s.rowSub}>
                      {KIND_LABEL[l.recipientKind]}: {l.recipientName} · {day(l.letterDate)}
                      {l.linkRemoved ? " · הרשומה המקורית נמחקה, פרטי הנמען נשמרו במכתב" : ""}
                    </span>
                  </span>
                  <span className={s.rowEnd}>
                    <button type="button" className={s.button} disabled={busy !== null} onClick={() => void download(l)}>הורדה</button>
                    <button type="button" className={s.button} disabled={busy !== null} onClick={() => void hide(l)}>הסתרה</button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
