"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { STRATEGY_TITLES } from "@/lib/services/landing/landing-strategy-explain";
import type { LandingOverview, LandingVersionSummary } from "@/lib/services/landing/persistence/landing-page.service";
import type { CurrentReadiness } from "@/lib/services/landing/persistence/landing-version-model";
import { currentBlockerLabel, snapshotMissingLabel, VERSION_BADGE } from "./landing-labels";
import {
  approveLandingDraft,
  fetchLandingOverview,
  landingErrorMessage,
  newActionKey,
  retireLandingDraft,
  rollbackToVersion,
} from "./landing-versions-api";
import styles from "./landing-versions.module.css";

/**
 * P3-E — the owner's landing page versions: the version they approved, their current draft, and the full
 * history. Approving is the owner's choice of a version; it is not publication (nothing here is shown to
 * anyone). Every action is the owner's, confirmed lightly; the server decides everything else.
 * Works with the composer off: viewing, previewing, approving and restoring never call a model.
 */

const strategyTitle = (t: string) => STRATEGY_TITLES[t as keyof typeof STRATEGY_TITLES] ?? t;
const dateHe = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" }) : "");

type Pending = { kind: "approve" | "rollback" | "retire"; version: LandingVersionSummary; key: string } | null;

function badgeClass(v: LandingVersionSummary): string {
  return v.status === "APPROVED" ? styles.badgeApproved : v.status === "DRAFT" ? styles.badgeDraft : styles.badgePast;
}

export function ReadinessNote({ readiness }: { readiness: CurrentReadiness | null }) {
  if (!readiness) return <p className={styles.warn}>לא ניתן לבדוק את הגרסה הזו כרגע.</p>;
  if (readiness.publishReady) return <p className={styles.ok}>לפי מה שמאושר היום, יש בגרסה את כל מה שצריך.</p>;
  const items = [...readiness.blockers.map(currentBlockerLabel), ...readiness.fromSnapshot.map(snapshotMissingLabel)];
  const unique = [...new Set(items)];
  return (
    <details className={styles.readiness}>
      <summary>{`חסרים ${unique.length} פרטים לפני שאפשר יהיה להציג את הדף`}</summary>
      <ul>{unique.map((m) => <li key={m}>{m}</li>)}</ul>
    </details>
  );
}

export function LandingVersionsScreen() {
  const [data, setData] = useState<(LandingOverview & { composerEnabled: boolean }) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);

  const apply = useCallback((r: Awaited<ReturnType<typeof fetchLandingOverview>>) => {
    if (r.ok) {
      setData(r.data);
      setLoadError(null);
    } else setLoadError(landingErrorMessage(r));
  }, []);
  const load = useCallback(async () => apply(await fetchLandingOverview()), [apply]);

  useEffect(() => {
    let cancelled = false;
    void fetchLandingOverview().then((r) => {
      if (!cancelled) apply(r);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const ask = (kind: NonNullable<Pending>["kind"], version: LandingVersionSummary) => {
    setNotice(null);
    setPending({ kind, version, key: newActionKey() });
  };

  const confirm = async () => {
    if (!pending || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const { kind, version, key } = pending;
    const r = kind === "approve" ? await approveLandingDraft(version.id) : kind === "rollback" ? await rollbackToVersion(version.id, key) : await retireLandingDraft(version.id);
    inFlight.current = false;
    setBusy(false);
    setPending(null);
    if (!r.ok) {
      setNotice(landingErrorMessage(r));
    } else {
      setNotice(
        kind === "approve"
          ? `גרסה ${version.versionNumber} היא עכשיו הגרסה המאושרת שלך.`
          : kind === "rollback"
            ? `נוצרה גרסה ${r.data.version.versionNumber} מתוך גרסה ${version.versionNumber}, והיא עכשיו הגרסה המאושרת.`
            : `הטיוטה (גרסה ${version.versionNumber}) בוטלה. היא נשארת בהיסטוריה.`,
      );
    }
    await load();
  };

  if (loadError) return <p className={styles.state} role="alert">{loadError}</p>;
  if (!data) return <p className={styles.state}>טוענים את הגרסאות…</p>;

  const { currentApproved, currentDraft, versions } = data;

  const confirmText = (p: NonNullable<Pending>) =>
    p.kind === "approve"
      ? `לאשר את גרסה ${p.version.versionNumber} כגרסה שבחרת?`
      : p.kind === "rollback"
        ? `ניצור גרסה חדשה המבוססת על גרסה ${p.version.versionNumber} ונגדיר אותה כגרסה המאושרת.`
        : `לבטל את הטיוטה (גרסה ${p.version.versionNumber})? היא תישאר בהיסטוריה.`;

  const confirmPanel = (v: LandingVersionSummary) =>
    pending && pending.version.id === v.id ? (
      <div className={styles.confirm} role="group" aria-label="אישור פעולה">
        <p>{confirmText(pending)}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void confirm()}>
            {busy ? "רגע…" : pending.kind === "approve" ? "כן, לאשר" : pending.kind === "rollback" ? "כן, לשחזר" : "כן, לבטל"}
          </button>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => setPending(null)}>חזרה</button>
        </div>
      </div>
    ) : null;

  const preview = (v: LandingVersionSummary) => (
    <Link className={styles.secondary} href={`/business/landing-preview?version=${v.id}`}>תצוגה מקדימה</Link>
  );

  return (
    <div className={styles.wrap}>
      <p className={styles.intro}>
        כאן נשמרות הגרסאות של דף הנחיתה. אישור גרסה הוא הבחירה שלך — הדף עדיין לא מוצג לאף אחד.
      </p>

      {notice && <p className={styles.notice} role="status">{notice}</p>}

      <section className={styles.current} aria-label="הגרסה המאושרת והטיוטה">
        <article className={styles.card}>
          <h2 className={styles.cardTitle}>הגרסה המאושרת</h2>
          {currentApproved ? (
            <>
              <div className={styles.row}>
                <span className={styles.badgeApproved}>{VERSION_BADGE.APPROVED}</span>
                <strong>{`גרסה ${currentApproved.versionNumber}`}</strong>
                <span className={styles.muted}>{strategyTitle(currentApproved.strategyType)}</span>
              </div>
              <p className={styles.muted}>
                {`אושרה ב-${dateHe(currentApproved.approvedAt)}`}
                {currentApproved.rollbackSourceVersionNumber ? ` · שוחזרה מגרסה ${currentApproved.rollbackSourceVersionNumber}` : ""}
              </p>
              <ReadinessNote readiness={currentApproved.currentReadiness} />
              <div className={styles.actions}>{preview(currentApproved)}</div>
            </>
          ) : (
            <p className={styles.muted}>עדיין לא אישרת גרסה.</p>
          )}
        </article>

        <article className={styles.card}>
          <h2 className={styles.cardTitle}>הטיוטה הנוכחית</h2>
          {currentDraft ? (
            <>
              <div className={styles.row}>
                <span className={styles.badgeDraft}>{VERSION_BADGE.DRAFT}</span>
                <strong>{`גרסה ${currentDraft.versionNumber}`}</strong>
                <span className={styles.muted}>{strategyTitle(currentDraft.strategyType)}</span>
              </div>
              <p className={styles.muted}>{`נשמרה ב-${dateHe(currentDraft.createdAt)}`}</p>
              <ReadinessNote readiness={currentDraft.currentReadiness} />
              <div className={styles.actions}>
                {preview(currentDraft)}
                <button type="button" className={styles.primary} onClick={() => ask("approve", currentDraft)}>אישור הגרסה</button>
                <button type="button" className={styles.quiet} onClick={() => ask("retire", currentDraft)}>ביטול הטיוטה</button>
              </div>
              {confirmPanel(currentDraft)}
            </>
          ) : (
            <p className={styles.muted}>אין טיוטה פתוחה.</p>
          )}
          <Link className={styles.create} href="/business/landing-strategy">יצירת גרסה חדשה ←</Link>
          {!data.composerEnabled && <p className={styles.muted}>יצירת טיוטות חדשות עדיין לא הופעלה בחשבון הזה. הגרסאות ששמרת זמינות כרגיל.</p>}
        </article>
      </section>

      <section aria-label="היסטוריית גרסאות">
        <h2 className={styles.sectionTitle}>כל הגרסאות</h2>
        {versions.length === 0 ? (
          <p className={styles.muted}>עדיין לא נשמרה אף גרסה. אפשר לבחור כיוון, לראות תצוגה מקדימה ולשמור אותה כגרסה.</p>
        ) : (
          <ol className={styles.history}>
            {versions.map((v) => (
              <li key={v.id} className={styles.item}>
                <div className={styles.row}>
                  <span className={badgeClass(v)}>{VERSION_BADGE[v.status] ?? v.status}</span>
                  <strong>{`גרסה ${v.versionNumber}`}</strong>
                  <span className={styles.muted}>{strategyTitle(v.strategyType)}</span>
                </div>
                <p className={styles.muted}>
                  {`נשמרה ב-${dateHe(v.createdAt)}`}
                  {v.approvedAt ? ` · אושרה ב-${dateHe(v.approvedAt)}` : ""}
                  {v.rollbackSourceVersionNumber ? ` · שוחזרה מגרסה ${v.rollbackSourceVersionNumber}` : ""}
                </p>
                <div className={styles.actions}>
                  {preview(v)}
                  {v.authority === "OWNER_APPROVED" && !v.isCurrentApproved && (
                    <button type="button" className={styles.secondary} onClick={() => ask("rollback", v)}>שחזור כגרסה המאושרת</button>
                  )}
                </div>
                {!v.isCurrentDraft && confirmPanel(v)}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
