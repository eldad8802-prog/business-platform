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
import { decideQuote, getCase, listCaseEvents, listQuotes, runCaseAction, ServiceDeskApiError } from "./service-desk-client";
import { errorView } from "./service-desk-errors";
import { LoadError, Loading, NotOpen } from "./ui";
import { useServiceDeskAccess } from "./use-service-desk-access";
import s from "./cases.module.css";

type Message = { tone: "error" | "ok"; text: string };

export function CaseScreen({ caseId }: { caseId: number }) {
  const { access, retry } = useServiceDeskAccess();
  const [data, setData] = useState<{ card: CaseCardData; events: JournalItem[] } | null>(null);
  const [error, setError] = useState<"none" | "missing" | "failed">("none");
  const [pending, setPending] = useState<{ def: CaseActionDef; debtMode: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const load = useCallback(async () => {
    try {
      const [card, events] = await Promise.all([getCase(caseId), listCaseEvents(caseId)]);
      setData({ card, events });
      setError("none");
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
      setBusyId(null);
      await load();
    }
  }, [caseId, data, load]);

  const onAction = useCallback((def: CaseActionDef) => {
    if (def.target.endpoint === "link") return;
    if (def.input.kind === "none") void send(def, {});
    else setPending({ def, debtMode: false });
  }, [send]);

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
  const actions = access.mode === "FULL" ? caseActions(data.card) : [];
  return (
    <>
      <CaseView card={data.card} events={data.events} now={new Date()} back={back} actions={actions} onAction={onAction} busyId={busyId} message={message} />
      {pending ? (
        <CaseActionDialog def={pending.def} debtMode={pending.debtMode} busy={busyId !== null}
          onCancel={() => setPending(null)} onSubmit={(r) => void send(pending.def, r)} />
      ) : null}
    </>
  );
}
