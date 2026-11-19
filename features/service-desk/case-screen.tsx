"use client";

/**
 * Service Desk UI 1.3 — the case screen (live). Reads the case card and its journal; actions come in the next step.
 * Gated by the server's Service Desk access like every Service Desk screen.
 */
import { useCallback, useEffect, useState } from "react";

import BackButton from "@/components/ui/back-button";

import type { CaseCardData, JournalItem } from "./cases-model";
import { CaseView } from "./case-view";
import { getCase, listCaseEvents, ServiceDeskApiError } from "./service-desk-client";
import { LoadError, Loading, NotOpen } from "./ui";
import { useServiceDeskAccess } from "./use-service-desk-access";
import s from "./cases.module.css";

export function CaseScreen({ caseId }: { caseId: number }) {
  const { access, retry } = useServiceDeskAccess();
  const [data, setData] = useState<{ card: CaseCardData; events: JournalItem[] } | null>(null);
  const [error, setError] = useState<"none" | "missing" | "failed">("none");

  const load = useCallback(() => {
    setError("none");
    Promise.all([getCase(caseId), listCaseEvents(caseId)])
      .then(([card, events]) => setData({ card, events }))
      .catch((e) => setError(e instanceof ServiceDeskApiError && e.status === 404 ? "missing" : "failed"));
  }, [caseId]);
  useEffect(() => { if (access.status === "open") load(); }, [access.status, load]);

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
          ) : error === "failed" ? <LoadError text="לא הצלחנו לטעון את התיק." onRetry={load} /> : <Loading />}
        </div>
      </main>
    );
  }
  return <CaseView card={data.card} events={data.events} now={new Date()} back={back} actionsEnabled={false} />;
}
