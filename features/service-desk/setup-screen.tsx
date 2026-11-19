"use client";

/**
 * Service Desk UI 1.3 — the activation screen (live). Behind the Service Desk gate; read-only mode cannot save. The
 * server keeps the choice in the settings (journaled) and stays the authority on every rule.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import BackButton from "@/components/ui/back-button";

import { chooseProfile, initialSetup, toggleTrack, type SetupDraft } from "./setup-model";
import { SetupView } from "./setup-view";
import { getProfileChoice, saveProfileChoice, type ProfileChoice } from "./service-desk-client";
import { errorView } from "./service-desk-errors";
import { LoadError, Loading, NotOpen } from "./ui";
import { useServiceDeskAccess } from "./use-service-desk-access";
import s from "./cases.module.css";

export function SetupScreen() {
  const router = useRouter();
  const { access, retry } = useServiceDeskAccess();
  const [choice, setChoice] = useState<ProfileChoice | null>(null);
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (access.status !== "open") return;
    getProfileChoice().then((c) => { setChoice(c); setDraft(initialSetup(c)); }).catch(() => setFailed(true));
  }, [access.status]);

  const back = <BackButton fallback="/service-desk" fallbackLabel="לתיקים" />;
  if (access.status !== "open" || failed || !choice || !draft || access.mode !== "FULL") {
    return (
      <main className={s.screen} data-page-intent="content" dir="rtl">
        <div className={s.wrap}>
          <header className={s.head}>{back}<div className={s.headTitles}><h1 className={s.title}>סוגי הפעילות</h1></div></header>
          {access.status === "loading" ? <Loading /> : access.status === "error" ? <LoadError text="לא הצלחנו לבדוק אם מערכת השירות פתוחה לעסק." onRetry={retry} />
            : access.status === "none" ? <NotOpen /> : access.mode === "READ_ONLY" ? <p className={s.msg} data-tone="error">מערכת השירות פתוחה אצלך לצפייה בלבד.</p>
            : failed ? <LoadError text="לא הצלחנו לטעון את ההגדרות." onRetry={() => location.reload()} /> : <Loading />}
        </div>
      </main>
    );
  }
  return (
    <SetupView back={back} draft={draft} suggestedKey={choice.suggestedKey} firstTime={!choice.chosen} busy={busy} error={error}
      onProfile={(k) => setDraft(chooseProfile(draft, k))} onTrack={(t) => setDraft(toggleTrack(draft, t))}
      onSave={async () => {
        setBusy(true); setError(null);
        try {
          await saveProfileChoice(draft.key, draft.tracks, choice.version);
          router.push("/service-desk");
        } catch (e) { setError(errorView(e).text); setBusy(false); }
      }} />
  );
}
