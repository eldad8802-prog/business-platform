"use client";

/**
 * Service Desk UI 1.3 — the case screen (live): reads the case and its journal, and runs the owner's actions against
 * the real server (the case machine decides; nothing is decided here). After every answer — success or refusal — the
 * case is read again, so the screen always shows what the server holds. Read-only mode shows no action at all.
 *
 * Pilot review fixes (2026-11-21): the charge panel (record a charge / "no charge" / link an issued invoice or receipt —
 * the server's existing commands; without it a handover could never pass the unknown-balance rule), a confirmation
 * before a quote is attached (and honest words: the system does not deliver it to the customer), the QA "passed" step
 * explained when it cannot pass, success messages that clear themselves, and the history with the stored side records.
 */
import { useCallback, useEffect, useState } from "react";

import BackButton from "@/components/ui/back-button";

import { CaseActionDialog, ConfirmDialog, type DialogResult } from "./case-action-dialog";
import { buildActionBody, caseActions, needsDebtDecision, type CaseActionDef } from "./case-actions-model";
import { caseNoun, isClosed, journaledLoanIds, telHref, type CaseCardData, type JournalItem, type SideHistoryItem } from "./cases-model";
import { CaseView, DetailsBody, IntakeBody, type MoreItem, type Step } from "./case-view";
import { chargeSummary, docName, ils, loanReminder, parseShekels, pickupSummary, PICKUP_OUTCOME_TEXT, qaBody, qaPassBlocker, quoteMode, type QaResults } from "./case-extras-model";
import { ChargePanel, FieldsPanel, LoansPanel, PickupPanel, QaPanel, QuotePanel, TasksPanel } from "./case-panels";
import {
  decideQuote, getCase, getCaseCharges, getCaseFields, getCaseQa, lendItem, linkCaseBillingDocument, listCaseEvents, listCaseTasks, listCustomerQuoteDocs,
  listCustomerSettlementDocs, listLoans, listPickupCalls, listQuotes, listQuotesFull, recordCaseCharge, recordPickupCall, recordQa, returnLoan, runCaseAction,
  sendCaseQuote, ServiceDeskApiError, setCaseFields, setTaskLink,
  type CaseChargeView, type CaseFields, type CaseQa, type CaseTask, type Loan, type PickupCall, type QuoteDoc, type QuoteSummary, type SettlementDoc,
} from "./service-desk-client";
import { errorView } from "./service-desk-errors";
import { LoadError, Loading, NotOpen } from "./ui";
import { useServiceDeskAccess } from "./use-service-desk-access";
import s from "./cases.module.css";

type Message = { tone: "error" | "ok"; text: string };
type Extras = {
  qa: CaseQa | null; quoteDocs: QuoteDoc[]; caseQuotes: QuoteSummary[]; otherCaseDocIds: number[]; calls: PickupCall[];
  loans: { available: boolean; loans: Loan[] }; tasks: { available: boolean; linked: CaseTask[]; open: CaseTask[] }; fields: CaseFields | null;
  charge: CaseChargeView | null; settlementDocs: SettlementDoc[];
};
const NO_EXTRAS: Extras = {
  qa: null, quoteDocs: [], caseQuotes: [], otherCaseDocIds: [], calls: [], loans: { available: false, loans: [] }, tasks: { available: false, linked: [], open: [] },
  fields: null, charge: null, settlementDocs: [],
};
const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
/** Statuses where the charge decides something (the handover / the completion) or can still be corrected. */
const CHARGE_STATUSES = ["IN_REPAIR", "QA", "READY", "WORK_DONE", "DELIVERED", "ABANDONED"];
/** A success line clears itself after this long; an error stays until the next action (it explains a refusal). */
const OK_MESSAGE_MS = 4000;

/** The panels' data — each read on its own, so one failing read never hides the case. */
async function loadExtras(card: CaseCardData): Promise<Extras> {
  const id = card.id;
  const mode = quoteMode(card.status);
  const handover = card.status === "READY" || card.status === "WORK_DONE";
  const [qa, quotes, calls, loans, tasks, fields, charge] = await Promise.all([
    card.status === "QA" || card.status === "IN_REPAIR" ? soft(getCaseQa(id), null) : Promise.resolve(null),
    soft(listQuotesFull(id), { quotes: [], otherCaseDocumentIds: [] }),
    soft(listPickupCalls(id), []),
    soft(listLoans(id), NO_EXTRAS.loans),
    soft(listCaseTasks(id), NO_EXTRAS.tasks),
    soft(getCaseFields(id), null),
    CHARGE_STATUSES.includes(card.status) ? soft(getCaseCharges(id), null) : Promise.resolve(null),
  ]);
  const [quoteDocs, settlementDocs] = await Promise.all([
    (mode || quotes.quotes.length) && card.customerId ? soft(listCustomerQuoteDocs(card.customerId), []) : Promise.resolve([]),
    handover && card.customerId && charge?.current?.mode === "CHARGEABLE" ? soft(listCustomerSettlementDocs(card.customerId), []) : Promise.resolve([]),
  ]);
  return { qa, quoteDocs, caseQuotes: quotes.quotes, otherCaseDocIds: quotes.otherCaseDocumentIds, calls, loans, tasks, fields, charge, settlementDocs };
}

/** The side records as history lines — only what is stored, with its own stored time. */
function sideHistory(x: Extras, events: readonly JournalItem[]): SideHistoryItem[] {
  const out: SideHistoryItem[] = [];
  const journaled = journaledLoanIds(events); // once migration 20261222090000 is applied the journal carries them (with who)
  for (const l of x.loans.loans) {
    if (journaled.has(l.id)) continue;
    out.push({ key: `loan-${l.id}`, text: `ניתן ציוד חלופי: ${l.itemName}`, occurredAt: l.lentAt });
    if (l.returnedAt) out.push({ key: `loan-${l.id}-r`, text: `הוחזר ציוד חלופי: ${l.itemName}`, occurredAt: l.returnedAt });
  }
  for (const c of x.calls) out.push({ key: `call-${c.id}`, text: `שיחת איסוף: ${PICKUP_OUTCOME_TEXT[c.outcome]}`, occurredAt: c.calledAt });
  return out;
}

type PanelDialog =
  | { kind: "quote"; doc: QuoteDoc; revise: boolean }
  | { kind: "amount" }
  | { kind: "noCharge" }
  | { kind: "charge" }
  | { kind: "link"; doc: SettlementDoc };

export function CaseScreen({ caseId }: { caseId: number }) {
  const { access, retry } = useServiceDeskAccess();
  const [data, setData] = useState<{ card: CaseCardData; events: JournalItem[] } | null>(null);
  const [error, setError] = useState<"none" | "missing" | "failed">("none");
  const [pending, setPending] = useState<{ def: CaseActionDef; debtMode: boolean } | null>(null);
  const [panelDialog, setPanelDialog] = useState<PanelDialog | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [extras, setExtras] = useState<Extras>(NO_EXTRAS);
  const [loadingExtras, setLoadingExtras] = useState(true);
  const [pickupAttempt, setPickupAttempt] = useState(0);
  const [qaDraft, setQaDraft] = useState<QaResults | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [card, events] = await Promise.all([getCase(caseId), listCaseEvents(caseId)]);
      setData({ card, events });
      setError("none");
      setExtras(await loadExtras(card)); // each panel restarts only when its own server data changed (keys below)
      setQaDraft(undefined);
    } catch (e) {
      setError(e instanceof ServiceDeskApiError && e.status === 404 ? "missing" : "failed");
    } finally {
      setLoadingExtras(false);
    }
  }, [caseId]);
  useEffect(() => { if (access.status === "open") void load(); }, [access.status, load]);
  // A success line does not stay on screen for ever (pilot review 2026-11-21); an error stays until the next action.
  useEffect(() => {
    if (message?.tone !== "ok") return;
    const t = setTimeout(() => setMessage((m) => (m === message ? null : m)), OK_MESSAGE_MS);
    return () => clearTimeout(t);
  }, [message]);

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

  const charge = extras.charge;
  const fieldCase = data ? caseNoun(data.card.kind) === "קריאה" : false;
  const balance = chargeSummary(charge?.balance ?? null, { field: fieldCase });

  /**
   * QA in one action (owner decision 2026-11-24): the marked checks are saved, then QA is passed or failed — two existing
   * server steps, the second on the fresh version. If the second is refused, the screen says the checks were saved and
   * why the step did not go through; nothing is invented and nothing is rolled back behind the owner's back.
   */
  const sendQa = useCallback(async (def: CaseActionDef, then: "PASS" | "FAIL") => {
    if (!data) return;
    const card = data.card;
    const qa = extras.qa;
    setBusyId(def.id);
    setMessage(null);
    let saved = false;
    try {
      const marks = qaDraft ?? qa?.results;
      const changed = !!qa?.template && !!marks && qa.template.items.some((i) => (marks[i.key] ?? null) !== (qa.results[i.key] ?? null));
      if (qa?.template && marks && changed) {
        await recordQa(card.id, qaBody(qa.template.items, marks), card.version ?? 0);
        saved = true;
      }
      const fresh = saved ? await getCase(caseId) : card;
      await runCaseAction(caseId, then === "PASS" ? { type: "PASS_QA", outcome: "REPAIRED" } : { type: "FAIL_QA" }, fresh.version ?? 0);
      setMessage({ tone: "ok", text: then === "PASS" ? "הבדיקות נשמרו ואושרו. התיק מוכן למסירה." : "הבדיקות נשמרו. התיק חזר לעבודה." });
    } catch (e) {
      setMessage({ tone: "error", text: saved ? `הבדיקות נשמרו, אבל ${then === "PASS" ? "האישור" : "ההחזרה לעבודה"} לא עבר: ${errorView(e).text}` : errorView(e).text });
    } finally {
      await load();
      setBusyId(null);
    }
  }, [caseId, data, extras.qa, qaDraft, load]);

  const onAction = useCallback((def: CaseActionDef) => {
    if (def.target.endpoint === "charge") { setPanelDialog({ kind: "charge" }); return; }
    if (def.target.endpoint === "scroll") { document.getElementById(def.target.to)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (def.target.endpoint === "qa") { void sendQa(def, def.target.then); return; }
    if (def.target.endpoint === "link" || def.blockedReason) return;
    // The handover dialog asks for the debt reason up front when the balance is known to be open (no refusal round-trip).
    const debtUpFront = (def.id === "deliver" || def.id === "complete") && balance.needsDebtReason;
    if (def.input.kind === "none" && !debtUpFront) void send(def, {});
    else setPending({ def, debtMode: debtUpFront });
  }, [send, sendQa, balance.needsDebtReason]);

  /** One panel write: the server answers, the case is read again, a refusal is shown in Hebrew. */
  const panelWrite = useCallback(async (id: string, f: () => Promise<unknown>, ok = "נשמר.") => {
    setBusyId(id);
    setMessage(null);
    try { await f(); setMessage({ tone: "ok", text: ok }); }
    catch (e) { setMessage({ tone: "error", text: errorView(e).text }); }
    finally { setPanelDialog(null); await load(); setBusyId(null); }
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
  const card = data.card;
  const finished = isClosed(card.status);
  const handoverStep = card.status === "READY" || card.status === "WORK_DONE";
  const chargeUndecided = handoverStep && !!charge && !charge.current;
  const qaBlocker = card.status === "QA" ? qaPassBlocker(extras.qa, qaDraft) : null;
  const handoverBlocker = handoverStep && !chargeUndecided && balance.blocksHandover ? balance.text : null;
  // QA: the checklist as marked on screen decides the main action (owner decision 2026-11-24).
  const qaItems = extras.qa?.template?.items ?? null;
  const qaMarks = qaDraft ?? extras.qa?.results ?? {};
  const qaState: "incomplete" | "ready" | "failed" | undefined = card.status !== "QA" || !qaItems ? undefined
    : qaItems.some((i) => qaMarks[i.key] === "FAIL") ? "failed"
    : qaItems.filter((i) => i.required || extras.qa!.template!.everyCheckRecorded).every((i) => qaMarks[i.key] === "PASS") ? "ready" : "incomplete";
  const actions = full ? caseActions(card, { qaMode: extras.qa?.mode, qaBlocker, qaState, handoverBlocker, chargeUndecided }) : [];
  const now = new Date();
  const v = card.version ?? 0;
  const busy = busyId !== null;
  const held = card.kind === "IN_SHOP";
  const qMode = quoteMode(card.status);
  const notes = [loanReminder(extras.loans.loans, card.status), card.status === "READY" ? pickupSummary(extras.calls, now) : null].filter((x): x is string => !!x);
  const intakeReady = !!card.intake && card.intake.conditionRecorded && card.intake.accessoriesRecorded;
  const nextCtx = {
    intakeReady,
    chargeMissing: handoverStep && balance.blocksHandover,
    qaFailed: card.status === "QA" && qaState === "failed",
    qa: card.status === "QA" && qaState && qaItems ? {
      state: qaState,
      remaining: qaItems.filter((i) => (i.required || extras.qa!.template!.everyCheckRecorded) && !qaMarks[i.key]).length,
      failedLabels: qaItems.filter((i) => qaMarks[i.key] === "FAIL").map((i) => i.label),
    } : undefined,
  };
  const caseHref = `/service-desk/cases/${card.id}`;
  const newQuoteHref = card.customerId
    ? `/billing?create=QUOTE&customerId=${card.customerId}${card.customerName ? `&customerName=${encodeURIComponent(card.customerName)}` : ""}&returnTo=${encodeURIComponent(caseHref)}`
    : "/billing?create=QUOTE";
  const chargeWords = charge?.current ? (charge.current.mode === "NO_CHARGE" ? "ללא חיוב" : ils(charge.current.amountAgorot ?? 0)) : null;
  const steps: Step[] | undefined = handoverStep && charge ? [
    { label: "לקבוע חיוב", detail: chargeWords ?? "סכום או «ללא חיוב»", state: charge.current ? "done" : "current" },
    { label: fieldCase ? "לסגור את הקריאה" : "למסור ללקוח", state: charge.current ? "current" : "todo" },
  ] : undefined;

  // The panels, each built once; the stage decides which are in ③ («עכשיו») and which wait in ④ («עוד»).
  const openLoans = extras.loans.loans.filter((l) => !l.returnedAt).length;
  const qaPanel = card.status === "QA" && extras.qa && extras.qa.template ? (
    <QaPanel key={sig(extras.qa)} qa={extras.qa} editable={full} busy={busy} onDraft={setQaDraft}
      onSave={(r) => void panelWrite("qa", () => recordQa(card.id, qaBody(extras.qa!.template!.items, r), v), "הבדיקות נשמרו.")} />
  ) : null;
  const chargePanel = charge && (handoverStep || charge.current) ? (
    <ChargePanel key={sig([charge, extras.settlementDocs])} charge={charge} settlementDocs={extras.settlementDocs} editable={full && !finished} busy={busy} field={fieldCase}
      onAmount={() => setPanelDialog({ kind: "amount" })} onNoCharge={() => setPanelDialog({ kind: "noCharge" })} onLink={(doc) => setPanelDialog({ kind: "link", doc })} />
  ) : null;
  const quotePanel = qMode || extras.caseQuotes.length ? (
    <QuotePanel key={sig([qMode, extras.quoteDocs, extras.caseQuotes, extras.otherCaseDocIds])} mode={qMode} docs={extras.quoteDocs} caseQuotes={extras.caseQuotes}
      otherCaseDocIds={extras.otherCaseDocIds} editable={full} busy={busy} now={now} newQuoteHref={newQuoteHref}
      onPick={(doc) => setPanelDialog({ kind: "quote", doc, revise: qMode === "revise" })} />
  ) : null;
  const pickupPanel = card.status === "READY" || extras.calls.length ? (
    <PickupPanel key={sig(extras.calls)} calls={extras.calls} now={now} editable={full && card.status === "READY"} busy={busy}
      onRecord={(o, note) => { setPickupAttempt((n) => n + 1); void panelWrite("pickup", () => recordPickupCall(card.id, o, note, pickupAttempt), "השיחה תועדה."); }} />
  ) : null;
  const fieldsPanel = extras.fields ? <FieldsPanel key={sig(extras.fields)} fields={extras.fields} editable={full && !finished} busy={busy} held={held}
    onSave={(loc, d) => void panelWrite("fields", () => setCaseFields(card.id, loc, d))} /> : null;
  const loansPanel = extras.loans.available ? (
    <LoansPanel key={sig(extras.loans)} available={extras.loans.available} loans={extras.loans.loans} now={now} editable={full} finished={finished} busy={busy}
      onLend={(name, note) => void panelWrite("loan", () => lendItem(card.id, name, note), "נרשם.")}
      onReturn={(id) => void panelWrite("loan", () => returnLoan(card.id, id), "סומן כהוחזר.")} />
  ) : null;
  const tasksPanel = extras.tasks.available ? (
    <TasksPanel key={sig(extras.tasks)} available={extras.tasks.available} linked={extras.tasks.linked} open={extras.tasks.open} editable={full} finished={finished} busy={busy}
      onLink={(id, link) => void panelWrite("task", () => setTaskLink(card.id, id, link), link ? "המשימה קושרה." : "הקישור הוסר.")} />
  ) : null;
  const detailsCard = <section className={s.infoCard} aria-label={held ? "הפריט והתקלה" : "פרטי העבודה"}><p className={s.infoTitle}>{held ? "הפריט והתקלה" : "פרטי העבודה"}</p><DetailsBody card={card} now={now} /></section>;

  const st = card.status;
  const early = st === "OPEN" || st === "SCHEDULED" || st === "CHECKED_IN";
  const diagnosing = st === "DIAGNOSING" || st === "QUOTE_PENDING";
  const working = st === "IN_REPAIR" || st === "EXTERNAL";
  const inNow = {
    details: early || diagnosing || finished,
    quote: diagnosing && !!quotePanel,
    tasks: working,
    loans: working || (handoverStep && openLoans > 0),
    fields: working,
    qa: st === "QA",
    pickup: st === "READY",
    charge: handoverStep || (finished && !!charge?.current),
  };
  const nowPanels = (
    <div style={{ display: "contents" }}>
      {loadingExtras ? <Loading /> : null}
      {inNow.qa ? qaPanel : null}
      {inNow.pickup ? pickupPanel : null}
      {inNow.charge ? chargePanel : null}
      {inNow.details ? detailsCard : null}
      {inNow.quote ? quotePanel : null}
      {inNow.tasks ? tasksPanel : null}
      {inNow.loans ? loansPanel : null}
      {inNow.fields ? fieldsPanel : null}
    </div>
  );
  const fieldsSummary = extras.fields && (extras.fields.itemLocationNote || extras.fields.estimatedReadyOn)
    ? [extras.fields.itemLocationNote, extras.fields.estimatedReadyOn ? `סיום משוער ${extras.fields.estimatedReadyOn.split("-").reverse().slice(0, 2).map(Number).join(".")}` : null].filter(Boolean).join(" · ")
    : "לא נקבע";
  const more: MoreItem[] = [
    ...(!inNow.details ? [{ key: "details", title: held ? "הפריט והתקלה" : "פרטי העבודה", summary: card.problemDescription?.slice(0, 40) ?? null, body: <DetailsBody card={card} now={now} /> }] : []),
    ...(held ? [{ key: "intake", title: "פרטי הקליטה", summary: card.intake ? (intakeReady ? "הושלמה" : "חסרים פרטים") : "עוד לא בוצעה", body: <IntakeBody card={card} /> }] : []),
    ...(quotePanel && !inNow.quote ? [{ key: "quote", title: "הצעת מחיר", summary: extras.caseQuotes.length ? `${extras.caseQuotes.length} בתיק` : "אין", body: quotePanel }] : []),
    ...(tasksPanel && !inNow.tasks && (!finished || extras.tasks.linked.length) ? [{ key: "tasks", title: "משימות", summary: extras.tasks.linked.length ? `${extras.tasks.linked.length}` : "אין", body: tasksPanel }] : []),
    ...(loansPanel && !inNow.loans && (!finished || extras.loans.loans.length) ? [{ key: "loans", title: "ציוד חלופי", summary: openLoans ? `${openLoans} אצל הלקוח` : extras.loans.loans.length ? "הוחזר" : "לא ניתן", body: loansPanel }] : []),
    ...(fieldsPanel && !inNow.fields && !finished ? [{ key: "fields", title: "מיקום ותאריך משוער", summary: fieldsSummary, body: fieldsPanel }] : []),
    ...(pickupPanel && !inNow.pickup ? [{ key: "pickup", title: "תזכורות איסוף", summary: `${extras.calls.length}`, body: pickupPanel }] : []),
    ...(chargePanel && !inNow.charge ? [{ key: "charge", title: "חיוב ותשלום", summary: chargeWords, body: chargePanel }] : []),
  ];
  return (
    <>
      <CaseView card={card} events={data.events} sideHistory={sideHistory(extras, data.events)}
        historyNames={{ loans: Object.fromEntries(extras.loans.loans.map((l) => [l.id, l.itemName])), tasks: Object.fromEntries([...extras.tasks.linked, ...extras.tasks.open].map((t) => [t.id, t.title])) }}
        nextCtx={nextCtx} now={now} back={back} actions={actions} onAction={onAction}
        busyId={busyId} message={message} notes={notes} steps={steps} nowPanels={nowPanels} more={more} callHref={telHref(card.customerPhone)} />
      {pending ? (
        <CaseActionDialog def={pending.def} debtMode={pending.debtMode} busy={busyId !== null}
          onCancel={() => setPending(null)} onSubmit={(r) => void send(pending.def, r)} />
      ) : null}
      {panelDialog ? (
        <PanelDialogView dialog={panelDialog} card={card} charge={charge} busy={busy} onCancel={() => setPanelDialog(null)}
          onQuote={(doc, revise) => void panelWrite("quote", () => sendCaseQuote(card.id, doc.id, v, revise), "ההצעה צורפה לתיק. התיק ממתין לתשובת הלקוח.")}
          onCharge={(body) => void panelWrite("charge", () => recordCaseCharge(card.id, body, v), body.mode === "NO_CHARGE" ? "נרשם: ללא חיוב." : "החיוב נרשם.")}
          onLink={(doc) => void panelWrite("link", () => linkCaseBillingDocument(card.id, doc.id, doc.type === "RECEIPT" ? "STANDALONE_PAYMENT" : "CHARGE", v), "המסמך קושר לתיק.")} />
      ) : null}
    </>
  );
}

const SETTLEMENT_NAME: Record<string, string> = { TAX_INVOICE: "חשבונית מס", TAX_INVOICE_RECEIPT: "חשבונית מס קבלה", RECEIPT: "קבלה" };

/** The confirmation of a panel step: what will happen, what is recorded, and — for a quote — what the system does NOT do. */
function PanelDialogView({ dialog, card, charge, busy, onCancel, onQuote, onCharge, onLink }: {
  dialog: PanelDialog; card: CaseCardData; charge: CaseChargeView | null; busy: boolean; onCancel: () => void;
  onQuote: (doc: QuoteDoc, revise: boolean) => void;
  onCharge: (body: { mode: "CHARGEABLE" | "NO_CHARGE"; amountAgorot?: number; reason?: string }) => void;
  onLink: (doc: SettlementDoc) => void;
}) {
  const [amount, setAmount] = useState(charge?.current?.mode === "CHARGEABLE" && charge.current.amountAgorot ? String(charge.current.amountAgorot / 100) : "");
  const [reason, setReason] = useState("");
  const [chargeMode, setChargeMode] = useState<"amount" | "noCharge">("amount");
  const hasCharge = !!charge?.current;
  if (dialog.kind === "quote") {
    const d = dialog.doc;
    return (
      <ConfirmDialog title={dialog.revise ? "להחליף את ההצעה בתיק?" : "לצרף את ההצעה לתיק?"} confirmLabel={dialog.revise ? "להחליף" : "לצרף לתיק"} busy={busy}
        onCancel={onCancel} onConfirm={() => onQuote(d, dialog.revise)}>
        <p className={s.dialogText}>{docName("הצעה", d.number)} · ₪{Number(d.totalAmount).toLocaleString("he-IL")} · ללקוח {card.customerName ?? "ללא שם"}.</p>
        <p className={s.dialogText}>
          {dialog.revise ? "ההצעה הקודמת תסומן כמוחלפת. " : ""}עותק קבוע של ההצעה יישמר בתיק, והתיק יעבור ל&quot;ממתין לאישור הצעה&quot;.
        </p>
        <p className={s.blockedNote}>המערכת לא שולחת את ההצעה ללקוח. מוסרים אותה בעצמכם (הדפסה, וואטסאפ או מייל ממסך המסמכים), ואת תשובת הלקוח רושמים בתיק.</p>
      </ConfirmDialog>
    );
  }
  if (dialog.kind === "link") {
    const d = dialog.doc;
    return (
      <ConfirmDialog title="לקשר את המסמך לתיק?" confirmLabel="לקשר" busy={busy} onCancel={onCancel} onConfirm={() => onLink(d)}>
        <p className={s.dialogText}>{docName(SETTLEMENT_NAME[d.type] ?? "מסמך", d.number)} · ₪{Number(d.totalAmount).toLocaleString("he-IL")}.</p>
        <p className={s.dialogText}>היתרה של התיק תחושב מחדש לפי המסמך. המסמך עצמו לא משתנה.</p>
      </ConfirmDialog>
    );
  }
  // "charge" (the main action of a case waiting for its charge) offers both in one sheet; the panel's buttons open one.
  const kind: "amount" | "noCharge" = dialog.kind === "charge" ? chargeMode : dialog.kind === "noCharge" ? "noCharge" : "amount";
  const reasonNeeded = kind === "noCharge" || hasCharge;
  const agorot = parseShekels(amount);
  const reasonOk = !reasonNeeded || reason.trim().length > 0;
  return (
    <ConfirmDialog title={dialog.kind === "charge" ? "לקבוע חיוב" : kind === "noCharge" ? "לקבוע: ללא חיוב" : hasCharge ? "לשנות את סכום החיוב" : "לקבוע סכום לחיוב"}
      confirmLabel="לשמור" busy={busy} confirmDisabled={!reasonOk || (kind === "amount" && agorot === null)} onCancel={onCancel}
      onConfirm={() => onCharge(kind === "noCharge" ? { mode: "NO_CHARGE", reason: reason.trim() } : { mode: "CHARGEABLE", amountAgorot: agorot!, ...(reason.trim() ? { reason: reason.trim() } : {}) })}>
      {dialog.kind === "charge" ? (
        <div className={s.segment} role="group" aria-label="סוג החיוב">
          <button type="button" aria-pressed={chargeMode === "amount"} onClick={() => setChargeMode("amount")}>סכום לחיוב</button>
          <button type="button" aria-pressed={chargeMode === "noCharge"} onClick={() => setChargeMode("noCharge")}>ללא חיוב</button>
        </div>
      ) : null}
      {kind === "amount" ? (
        <label className={s.label}>
          סכום לחיוב (₪, כולל מע&quot;מ)
          <input className={s.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="למשל 350" aria-invalid={amount !== "" && agorot === null} />
          {amount !== "" && agorot === null ? <span className={s.fieldError}>צריך סכום גדול מאפס, עד שתי ספרות אחרי הנקודה.</span> : agorot !== null ? <span className={s.muted}>{ils(agorot)}</span> : null}
        </label>
      ) : (
        <p className={s.dialogText}>התיק יימסר בלי חיוב. ההחלטה נשמרת בהיסטוריה, והסיבה נשמרת בתיק.</p>
      )}
      {reasonNeeded ? (
        <label className={s.label}>
          {kind === "noCharge" ? "סיבה (חובה)" : "סיבת השינוי (חובה)"}
          <textarea className={s.textarea} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </label>
      ) : null}
      <p className={s.muted}>הרישום בתיק לא מפיק חשבונית או קבלה.</p>
    </ConfirmDialog>
  );
}

/** A panel's key: what the server holds for it. A reload that changed nothing there keeps what is being typed. */
function sig(v: unknown): string { return JSON.stringify(v ?? null); }
