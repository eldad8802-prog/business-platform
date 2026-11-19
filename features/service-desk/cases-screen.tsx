"use client";

/**
 * Service Desk UI 1.3 — the entry screen: the cases list (live). Access comes from the server's Service Desk gate; while
 * service_desk is off no business reaches this list (mode NONE → the "not open" notice). Reads only.
 */
import { useCallback, useEffect, useState } from "react";

import BackButton from "@/components/ui/back-button";

import type { CaseRowData, ListFilter } from "./cases-model";
import { CasesListView } from "./cases-list-view";
import { listCases, getProfileChoice } from "./service-desk-client";
import { LoadError, Loading, NotOpen } from "./ui";
import { useServiceDeskAccess } from "./use-service-desk-access";
import s from "./cases.module.css";

export function CasesScreen() {
  const { access, retry } = useServiceDeskAccess();
  const [rows, setRows] = useState<CaseRowData[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<ListFilter>("all");
  const [query, setQuery] = useState("");
  const [needsSetup, setNeedsSetup] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    listCases().then(setRows).catch(() => setFailed(true));
    getProfileChoice().then((c) => setNeedsSetup(!c.chosen)).catch(() => setNeedsSetup(false));
  }, []);
  useEffect(() => { if (access.status === "open") load(); }, [access.status, load]);

  if (access.status !== "open" || rows === null || failed) {
    return (
      <main className={s.screen} data-page-intent="content" dir="rtl">
        <div className={s.wrap}>
          <header className={s.head}>
            <BackButton fallback="/app" fallbackLabel="לבית" />
            <div className={s.headTitles}><h1 className={s.title}>תיקי שירות</h1></div>
          </header>
          {access.status === "loading" ? <Loading /> : access.status === "error" ? (
            <LoadError text="לא הצלחנו לבדוק אם מערכת השירות פתוחה לעסק." onRetry={retry} />
          ) : access.status === "none" ? <NotOpen /> : failed ? (
            <LoadError text="לא הצלחנו לטעון את התיקים." onRetry={load} />
          ) : <Loading />}
        </div>
      </main>
    );
  }

  return (
    <CasesListView
      rows={rows}
      now={new Date()}
      filter={filter}
      query={query}
      onFilter={setFilter}
      onQuery={setQuery}
      back={<BackButton fallback="/app" fallbackLabel="לבית" />}
      caseHref={(id) => `/service-desk/cases/${id}`}
      settingsHref="/service-desk/settings"
      readOnly={access.mode === "READ_ONLY"}
      openCaseEnabled={access.mode === "FULL"}
      newCaseHref="/service-desk/new"
      setupHref={access.mode === "FULL" && needsSetup ? "/service-desk/setup" : null}
    />
  );
}
