"use client";

/**
 * "מעבר לעוסק מורשה" — the documents issued as an exempt dealer since the official date (4a T4): the note on steps 1
 * and 3 and on the success screen, and the list in a bottom sheet (paged, 50 at a time). Read only: nothing here
 * changes a document.
 */
import { useEffect, useRef, useState } from "react";

import s from "@/app/business/legal-identity/kind-transition/kind-transition.module.css";
import { IconAlert, IconDoc, IconInfo, IconSpinner, IconWarn, Note } from "@/components/legal-identity/kind-transition-parts";
import { displayDate } from "@/lib/legal-identity/kind-transition-client";
import {
  creditStateHe, displayAmount, DOCUMENT_TYPE_HE, fetchInterimDocuments, INTERIM_LOAD_ERROR, interimNone, interimSentence, mergePages,
  type InterimAnswer, type InterimItem,
} from "@/lib/legal-identity/kind-transition-interim-client";

export type InterimState = { status: "idle" } | { status: "loading" } | { status: "error" } | { status: "ready"; answer: InterimAnswer };

/**
 * The note. `hideWhenNone`: on step 1 with today's date and on the success screen, "no documents" says nothing new.
 */
export function InterimDocumentsNote({ state, fromDate, onRetry, onOpenList, hideWhenNone = false }: {
  state: InterimState; fromDate: string; onRetry: () => void; onOpenList: () => void; hideWhenNone?: boolean;
}) {
  const from = displayDate(fromDate);
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <Note tone="info" role="status">
        <IconSpinner className={s.spin} />
        <span data-testid="kt-interim-loading">בודקים אילו מסמכים הופקו מאז {from}…</span>
      </Note>
    );
  }
  if (state.status === "error") {
    return (
      <Note tone="err" column role="alert">
        <span style={{ display: "flex", gap: 10 }}><IconAlert size={18} /><span data-testid="kt-interim-error">{INTERIM_LOAD_ERROR}</span></span>
        <button type="button" className={s.linkBtn} style={{ alignSelf: "flex-start" }} onClick={onRetry} data-testid="kt-interim-retry">לבדוק שוב</button>
      </Note>
    );
  }
  const n = state.answer.count;
  if (n === 0) {
    if (hideWhenNone) return null;
    return <Note tone="info" role="status"><IconInfo /><span data-testid="kt-interim" data-count="0">{interimNone(from)}</span></Note>;
  }
  return (
    <Note tone="warn" column role="status">
      <span style={{ display: "flex", gap: 10 }}>
        <IconWarn />
        <span data-testid="kt-interim" data-count={n}>{interimSentence(n, from)}</span>
      </span>
      <button type="button" className={s.linkBtn} style={{ alignSelf: "flex-start" }} onClick={onOpenList} data-testid="kt-interim-list-open">
        {n === 1 ? "להצגת המסמך" : `להצגת ${n} המסמכים`}
      </button>
    </Note>
  );
}

/** The list: a modal bottom sheet (focus in, Escape closes, focus back to the opener), first page on open, then more. */
export function InterimDocumentsSheet({ open, onClose, from }: { open: boolean; onClose: () => void; from: string | null }) {
  // Mounted only while open: every opening starts from an empty list and asks again.
  return open ? <SheetBody onClose={onClose} from={from} /> : null;
}

type Page = { items: InterimItem[]; count: number | null; cursor: string | null; phase: "loading" | "ready" | "error" | "more" };

function SheetBody({ onClose, from }: { onClose: () => void; from: string | null }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<Page>({ items: [], count: null, cursor: null, phase: "loading" });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { opener?.focus?.(); };
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    fetchInterimDocuments({ from, list: true }, ctl.signal)
      .then((r) => setPage(r.ok
        ? { items: r.answer.items ?? [], count: r.answer.count, cursor: r.answer.nextCursor ?? null, phase: "ready" }
        : { items: [], count: null, cursor: null, phase: "error" }))
      .catch(() => { /* aborted: the sheet closed */ });
    return () => ctl.abort();
  }, [from]);

  const more = async () => {
    const cursor = page.cursor;
    if (!cursor) return;
    setPage((p) => ({ ...p, phase: "more" }));
    try {
      const r = await fetchInterimDocuments({ from, list: true, cursor });
      setPage((p) => (r.ok ? { ...p, items: mergePages(p.items, r.answer.items ?? []), cursor: r.answer.nextCursor ?? null, phase: "ready" } : { ...p, phase: "error" }));
    } catch {
      setPage((p) => ({ ...p, phase: "error" }));
    }
  };

  const { items, count, cursor, phase } = page;
  return (
    <div className={s.scrim} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef} className={`${s.sheet} ${s.sheetTall}`} role="dialog" aria-modal="true" aria-labelledby="kt-interim-title" tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
        data-testid="kt-interim-sheet"
      >
        <span className={s.grab} aria-hidden="true" />
        <h2 id="kt-interim-title" className={s.sheetTitle}>מסמכים שהופקו כעוסק פטור{count !== null ? ` (${count})` : ""}</h2>
        <p className={s.help}>המסמכים נשארים בדיוק כפי שהופקו. הרשימה לעיון בלבד.</p>
        <div className={s.sheetScroll}>
          {phase === "loading" ? <div className={s.center} role="status"><IconSpinner size={24} className={s.spin} /><span className={s.lead}>טוען…</span></div> : null}
          {items.length > 0 ? (
            <ul className={s.docList} aria-label="רשימת המסמכים">
              {items.map((d) => {
                const credit = creditStateHe(d.creditState);
                return (
                  <li key={d.id} className={s.docRow} data-testid="kt-interim-item">
                    <IconDoc className={`${s.liIcon} ${s.brand}`} />
                    <span className={s.docMain}>
                      <span className={s.docTitle}>{DOCUMENT_TYPE_HE[d.documentType] ?? d.documentType} <span className={s.ltr}>{d.documentNumberFormatted ?? d.documentNumber ?? ""}</span></span>
                      <small className={s.docSub}><span className={s.ltr}>{displayDate(d.documentDate)}</span>{credit ? <> · <span className={s.docCredit}>{credit}</span></> : null}</small>
                    </span>
                    <span className={`${s.docAmount} ${s.ltr}`}>{displayAmount(d.totalAmount, d.currency)}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {phase === "error" ? (
            <Note tone="err" role="alert"><IconAlert size={18} /><span>{INTERIM_LOAD_ERROR}</span></Note>
          ) : null}
        </div>
        {cursor && phase !== "loading" ? (
          <button type="button" className={s.btnGhost} onClick={more} disabled={phase === "more"} data-testid="kt-interim-more">
            {phase === "more" ? <><IconSpinner className={s.spin} />טוען…</> : "להצגת מסמכים נוספים"}
          </button>
        ) : null}
        <button type="button" className={s.btnPrimary} onClick={onClose} data-testid="kt-interim-close">סגירה</button>
      </div>
    </div>
  );
}
