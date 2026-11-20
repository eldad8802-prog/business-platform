"use client";

/**
 * Service Desk UI 1.3 — opening a case (live). Behind the Service Desk gate (service_desk OFF ⇒ "not open"); read-only
 * mode cannot open. The server snapshots the profile and decides every rule; the screen only collects what the chosen
 * activity needs. After the opening: a held item goes to the intake step, anything else to the case.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import BackButton from "@/components/ui/back-button";

import type { CaseRowData } from "./cases-model";
import { draftIssues, EMPTY_DRAFT, offeredTracks, openCaseBody, TRACK_FORMS, warrantySuggestion, type OpenCaseDraft } from "./open-case-model";
import { OpenCaseView } from "./open-case-view";
import { createCustomer, getSettings, listCases, openServiceCase, searchCustomers, type CustomerHit, type ServiceSettings } from "./service-desk-client";
import { errorView } from "./service-desk-errors";
import { LoadError, Loading, NotOpen } from "./ui";
import { useServiceDeskAccess } from "./use-service-desk-access";
import s from "./cases.module.css";

export function OpenCaseScreen() {
  const router = useRouter();
  const { access, retry } = useServiceDeskAccess();
  const [settings, setSettings] = useState<ServiceSettings | null>(null);
  const [cases, setCases] = useState<CaseRowData[]>([]);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<OpenCaseDraft>(EMPTY_DRAFT);
  const [showMore, setShowMore] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [newCustomer, setNewCustomer] = useState({ open: false, name: "", phone: "" });
  const [showIssues, setShowIssues] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (access.status !== "open") return;
    Promise.all([getSettings(), listCases()]).then(([st, cs]) => { setSettings(st); setCases(cs); }).catch(() => setFailed(true));
  }, [access.status]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); return; }
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      searchCustomers(q).then((r) => { if (seq === searchSeq.current) setHits(r); }).catch(() => { if (seq === searchSeq.current) setHits([]); });
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const tracks = useMemo(() => offeredTracks(settings?.profile ?? null), [settings]);
  useEffect(() => { if (!draft.track && tracks.first.length === 1) setDraft((d) => ({ ...d, track: tracks.first[0] })); }, [tracks, draft.track]);

  const pastCases = useMemo(() => (draft.customer ? cases.filter((c) => c.customerId === draft.customer?.id) : []), [cases, draft.customer]);
  const suggestion = useMemo(() => {
    const t = draft.track ? TRACK_FORMS[draft.track] : null;
    if (!t?.subject || !settings?.warrantyTemplate) return null;
    return warrantySuggestion(pastCases, draft.subjectName, settings.warrantyTemplate, new Date());
  }, [draft.track, draft.subjectName, pastCases, settings]);

  const onCreateCustomer = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const c = await createCustomer(newCustomer.name.trim(), newCustomer.phone.trim() || null);
      setDraft((d) => ({ ...d, customer: c, parentCaseId: null }));
      setNewCustomer({ open: false, name: "", phone: "" });
    } catch (e) {
      setError(errorView(e).text);
    } finally { setBusy(false); }
  }, [newCustomer]);

  const onSubmit = useCallback(async () => {
    setShowIssues(true);
    if (draftIssues(draft).length) return;
    setBusy(true); setError(null);
    try {
      const r = await openServiceCase(openCaseBody(draft));
      const next = draft.track ? TRACK_FORMS[draft.track].next : "case";
      router.push(next === "intake" ? `/service-desk/cases/${r.case.id}/intake` : `/service-desk/cases/${r.case.id}`);
    } catch (e) {
      setError(errorView(e).text);
      setBusy(false);
    }
  }, [draft, router]);

  const back = <BackButton fallback="/service-desk" fallbackLabel="לתיקים" />;
  if (access.status !== "open" || failed || !settings) {
    return (
      <main className={s.screen} data-page-intent="content" dir="rtl">
        <div className={s.wrap}>
          <header className={s.head}>{back}<div className={s.headTitles}><h1 className={s.title}>פתיחה חדשה</h1></div></header>
          {access.status === "loading" ? <Loading /> : access.status === "error" ? (
            <LoadError text="לא הצלחנו לבדוק אם מערכת השירות פתוחה לעסק." onRetry={retry} />
          ) : access.status === "none" ? <NotOpen /> : access.mode === "READ_ONLY" ? (
            <p className={s.msg} data-tone="error">מערכת השירות פתוחה אצלך לצפייה בלבד.</p>
          ) : failed ? <LoadError text="לא הצלחנו לטעון את ההגדרות." onRetry={() => location.reload()} /> : <Loading />}
        </div>
      </main>
    );
  }
  if (access.mode === "READ_ONLY") {
    return <main className={s.screen} dir="rtl"><div className={s.wrap}><header className={s.head}>{back}</header><p className={s.msg} data-tone="error">מערכת השירות פתוחה אצלך לצפייה בלבד.</p></div></main>;
  }
  return (
    <OpenCaseView
      back={back} now={new Date()} tracks={tracks} showMore={showMore} onShowMore={() => setShowMore(true)}
      draft={draft} onDraft={setDraft} customerQuery={query} onCustomerQuery={setQuery} customerHits={hits}
      newCustomer={newCustomer} onNewCustomer={setNewCustomer} onCreateCustomer={() => void onCreateCustomer()}
      pastCases={pastCases} suggestion={suggestion} showIssues={showIssues} busy={busy} error={error} onSubmit={() => void onSubmit()}
    />
  );
}
