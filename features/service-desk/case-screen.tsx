"use client";

/**
 * Service Desk UI 1.3 — the case screen (live): reads the case and its journal, and runs the owner's actions against
 * the real server (the case machine decides; nothing is decided here). After every answer — success or refusal — the
 * case is read again, so the screen always shows what the server holds. Read-only mode shows no action at all.
 */
import { useCallback, useEffect, useState } from "react";

import BackButton from "@/components/ui/back-button";

import { CaseActionDialog, type DialogResult } from "./case-action-dialog";
import { buildActionBody, caseActions, needsDebtDecision, type CaseActionDef } from "./case-actions-model";
import type { CaseCardData, JournalItem } from "./cases-model";
import { CaseView } from "./case-view";
import { loanReminder, pickupSummary, qaBody, quoteMode } from "./case-extras-model";
import { FieldsPanel, LoansPanel, PickupPanel, QaPanel, QuotePanel, TasksPanel } from "./case-panels";
import {
  decideQuote, getCase, getCaseFields, getCaseQa, lendItem, listCaseEvents, listCaseTasks, listCustomerQuoteDocs, listLoans, listPickupCalls, listQuotes,
  recordPickupCall, recordQa, returnLoan, runCaseAction, sendCaseQuote, ServiceDeskApiError, setCaseFields, setTaskLink,
  type CaseFields, type CaseQa, type CaseTask, type Loan, type PickupCall, type QuoteDoc,
} from "./service-desk-client";
import { errorView } from "./service-desk-errors";
import { LoadError, Loading, NotOpen } from "./ui";
import { useServiceDeskAccess } from "./use-service-desk-access";
import s from "./cases.module.css";

type Message = { tone: "error" | "ok"; text: string };
type Extras = {
  qa: CaseQa | null; quoteDocs: QuoteDoc[]; sentDocIds: number[]; calls: PickupCall[];
  loans: { available: boolean; loans: Loan[] }; tasks: { available: boolean; linked: CaseTask[]; open: CaseTask[] }; fields: CaseFields | null;
};
const NO_EXTRAS: Extras = { qa: null, quoteDocs: [], sentDocIds: [], calls: [], loans: { available: false, loans: [] }, tasks: { available: false, linked: [], open: [] }, fields: null };
const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

/** The panels' data — each read on its own, so one failing read never hides the case. */
async function loadExtras(card: CaseCardData): Promise<Extras> {
  const id = card.id;
  const mode = quoteMode(card.status);
  const [qa, quotes, quoteDocs, calls, loans, tasks, fields] = await Promise.all([
    card.status === "QA" || card.status === "IN_REPAIR" ? soft(getCaseQa(id), null) : Promise.resolve(null),
    mode ? soft(listQuotes(id), []) : Promise.resolve([]),
    mode && card.customerId ? soft(listCustomerQuoteDocs(card.customerId), []) : Promise.resolve([]),
    soft(listPickupCalls(id), []),
    soft(listLoans(id), NO_EXTRAS.loans),
    soft(listCaseTasks(id), NO_EXTRAS.tasks),
    soft(getCaseFields(id), null),
  ]);
  return { qa, quoteDocs, sentDocIds: quotes.map((q) => q.billingDocumentId).filter((x): x is number => typeof x === "number"), calls, loans, tasks, fields };
}

export function CaseScreen({ caseId }: { caseId: number }) {
  const { access, retry } = useServiceDeskAccess();
  const [data, setData] = useState<{ card: CaseCardData; events: JournalItem[] } | null>(null);
  const [error, setError] = useState<"none" | "missing" | "failed">("none");
  const [pending, setPending] = useState<{ def: CaseActionDef; debtMode: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [extras, setExtras] = useState<Extras>(NO_EXTRAS);
  const [extrasKey, setExtrasKey] = useState(0);
  const [pickupAttempt, setPickupAttempt] = useState(0);

  const load = useCallback(async () => {
    try {
      const [card, events] = await Promise.all([getCase(caseId), listCaseEvents(caseId)]);
      setData({ card, events });
      setError("none");
      setExtras(await loadExtras(card));
      setExtrasKey((k) => k + 1); // panels restart from what the server holds
    } catch (e) {
      setError(e instanceof ServiceDeskApiError && e.status === 404 ? "missing" : "failed");
    }
  }, [caseId]);
  useEffect(() => { if (access.status === "open") void load(); }, [access.status, load]);

  const send = useCallback(async (def: CaseActionDef, r: DialogResult) => {
    if (!data) return;
    const card = data.card;
    setBusyId(def.id);
    setMessage(null);
    try {
      if (def.target.endpoint === "quote") {
        const quotes = await listQuotes(caseId);
        const open = quotes.filter((q) => q.state === "SENT").sort((a, b) => b.version - a.version)[0];
        if (!open) throw new ServiceDeskApiError(409, "REFUSED", { violations: ["QUOTE_NOT_AWAITING_DECISION"] });
        await decideQuote(caseId, open.version, def.target.decision, r.method ?? "PHONE", card.version ?? 0);
      } else if (def.target.endpoint === "action") {
        await runCaseAction(caseId, buildActionBody(def, card, r), card.version ?? 0);
      }
      setPending(null);
      setMessage({ tone: "ok", text: "נשמר." });
    } catch (e) {
      const violations = e instanceof ServiceDeskApiError && Array.isArray(e.details?.violations)
        ? (e.details?.violations as unknown[]).map(String) : [];
      if (needsDebtDecision(violations) && !r.debtReason) {
        setPending({ def, debtMode: true }); // the owner decides, with a documented reason
      } else {
        setPending(null);
        setMessage({ tone: "error", text: errorView(e).text });
      }
    } finally {
      await load();
      setBusyId(null); // only after the fresh case is on screen: no action runs on a stale version
    }
  }, [caseId, data, load]);

  const onAction = useCallback((def: CaseActionDef) => {
    if (def.target.endpoint === "link") return;
    if (def.input.kind === "none") void send(def, {});
    else setPending({ def, debtMode: false });
  }, [send]);

  /** One panel write: the server answers, the case is read again, a refusal is shown in Hebrew. */
  const panelWrite = useCallback(async (id: string, f: () => Promise<unknown>, ok = "נשמר.") => {
    setBusyId(id);
    setMessage(null);
    try { await f(); setMessage({ tone: "ok", text: ok }); }
    catch (e) { setMessage({ tone: "error", text: errorView(e).text }); }
    finally { await load(); setBusyId(null); }
  }, [load]);

  const back = <BackButton fallback="/service-desk" fallbackLabel="לתיקים" />;
  if (access.status !== "open" || !data || error !== "none") {
    return (
      <main className={s.screen} data-page-intent="content" dir="rtl">
        <div className={s.wrap}>
          <header className={s.head}>{back}<div className={s.headTitles}><h1 className={s.title}>תיק</h1></div></header>
          {access.status === "loading" ? <Loading /> : access.status === "error" ? (
            <LoadError text="לא הצלחנו לבדוק אם מערכת השירות פתוחה לעסק." onRetry={retry} />
          ) : access.status === "none" ? <NotOpen /> : error === "missing" ? (
            <div className={s.empty}><h2>התיק לא נמצא</h2></div>
          ) : error === "failed" ? <LoadError text="לא הצלחנו לטעון את התיק." onRetry={() => void load()} /> : <Loading />}
        </div>
      </main>
    );
  }
  const full = access.mode === "FULL";
  const actions = full ? caseActions(data.card, { qaMode: extras.qa?.mode }) : [];
  const card = data.card;
  const now = new Date();
  const v = card.version ?? 0;
  const busy = busyId !== null;
  const held = card.kind === "IN_SHOP";
  const qMode = quoteMode(card.status);
  const notes = [loanReminder(extras.loans.loans, card.status), card.status === "READY" ? pickupSummary(extras.calls, now) : null].filter((x): x is string => !!x);
  const extraMain = (
    <div key={extrasKey} style={{ display: "contents" }}>
      {card.status === "QA" && extras.qa && extras.qa.template ? (
        <QaPanel qa={extras.qa} editable={full} busy={busy}
          onSave={(r) => void panelWrite("qa", () => recordQa(card.id, qaBody(extras.qa!.template!.items, r), v), "הבדיקות נשמרו.")} />
      ) : null}
      {qMode ? (
        <QuotePanel mode={qMode} docs={extras.quoteDocs} sentDocIds={extras.sentDocIds} editable={full} busy={busy}
          newQuoteHref="/billing?create=QUOTE" onSend={(docId) => void panelWrite("quote", () => sendCaseQuote(card.id, docId, v, qMode === "revise"), "ההצעה נשלחה ונשמרה בתיק.")} />
      ) : null}
      {card.status === "READY" ? (
        <PickupPanel calls={extras.calls} now={now} editable={full} busy={busy}
          onRecord={(o, note) => { setPickupAttempt((n) => n + 1); void panelWrite("pickup", () => recordPickupCall(card.id, o, note, pickupAttempt), "השיחה תועדה."); }} />
      ) : null}
    </div>
  );
  const extraSide = (
    <div key={extrasKey} style={{ display: "contents" }}>
      {extras.fields ? <FieldsPanel fields={extras.fields} editable={full} busy={busy} held={held}
        onSave={(loc, d) => void panelWrite("fields", () => setCaseFields(card.id, loc, d))} /> : null}
      <LoansPanel available={extras.loans.available} loans={extras.loans.loans} now={now} editable={full} busy={busy}
        onLend={(name, note) => void panelWrite("loan", () => lendItem(card.id, name, note), "נרשם.")}
        onReturn={(id) => void panelWrite("loan", () => returnLoan(card.id, id), "סומן כהוחזר.")} />
      <TasksPanel available={extras.tasks.available} linked={extras.tasks.linked} open={extras.tasks.open} editable={full} busy={busy}
        onLink={(id, link) => void panelWrite("task", () => setTaskLink(card.id, id, link), link ? "המשימה קושרה." : "הקישור הוסר.")} />
    </div>
  );
  return (
    <>
      <CaseView card={card} events={data.events} now={now} back={back} actions={actions} onAction={onAction} busyId={busyId} message={message}
        notes={notes} extraMain={extraMain} extraSide={extraSide} />
      {pending ? (
        <CaseActionDialog def={pending.def} debtMode={pending.debtMode} busy={busyId !== null}
          onCancel={() => setPending(null)} onSubmit={(r) => void send(pending.def, r)} />
      ) : null}
    </>
  );
}
