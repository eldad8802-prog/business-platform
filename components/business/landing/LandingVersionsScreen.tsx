"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { LandingOverview, LandingVersionSummary } from "@/lib/services/landing/persistence/landing-page.service";
import type { CurrentReadiness } from "@/lib/services/landing/persistence/landing-version-model";
import { useLandingLabels } from "./landing-labels";
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

/** Hebrew: "he-IL" exactly as before; other languages use their own Intl tag. */
const dateIn = (locale: Locale, iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(intlTag(locale), { day: "numeric", month: "long", year: "numeric" }) : "";

type Pending = { kind: "approve" | "rollback" | "retire"; version: LandingVersionSummary; key: string } | null;

function badgeClass(v: LandingVersionSummary): string {
  return v.status === "APPROVED" ? styles.badgeApproved : v.status === "DRAFT" ? styles.badgeDraft : styles.badgePast;
}

export function ReadinessNote({ readiness }: { readiness: CurrentReadiness | null }) {
  const { t } = useI18n();
  const { currentBlockerLabel, snapshotMissingLabel } = useLandingLabels();
  if (!readiness) return <p className={styles.warn}>{t("content.identity.versions.readinessUnknown")}</p>;
  if (readiness.publishReady) return <p className={styles.ok}>{t("content.identity.versions.readinessOk")}</p>;
  const items = [...readiness.blockers.map(currentBlockerLabel), ...readiness.fromSnapshot.map(snapshotMissingLabel)];
  const unique = [...new Set(items)];
  return (
    <details className={styles.readiness}>
      <summary>{t("content.identity.versions.readinessMissing", { count: unique.length })}</summary>
      <ul>{unique.map((m) => <li key={m}>{m}</li>)}</ul>
    </details>
  );
}

export function LandingVersionsScreen() {
  const { t, locale } = useI18n();
  const { VERSION_BADGE, strategyTitle } = useLandingLabels();
  const dateHe = (iso: string | null) => dateIn(locale, iso);
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
    } else setLoadError(landingErrorMessage(t, r));
  }, [t]);
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
      setNotice(landingErrorMessage(t, r));
    } else {
      setNotice(
        kind === "approve"
          ? t("content.identity.versions.noticeApproved", { n: version.versionNumber })
          : kind === "rollback"
            ? t("content.identity.versions.noticeRestored", { created: r.data.version.versionNumber, n: version.versionNumber })
            : t("content.identity.versions.noticeRetired", { n: version.versionNumber }),
      );
    }
    await load();
  };

  if (loadError) return <p className={styles.state} role="alert">{loadError}</p>;
  if (!data) return <p className={styles.state}>{t("content.identity.versions.loading")}</p>;

  const { currentApproved, currentDraft, versions } = data;

  // Hebrew stays literal here: landing-persistence.verify (P29) pins this wording in the screen's source.
  const confirmText = (p: NonNullable<Pending>) =>
    locale !== "he"
      ? p.kind === "approve"
        ? t("content.identity.versions.confirmApprove", { n: p.version.versionNumber })
        : p.kind === "rollback"
          ? t("content.identity.versions.confirmRollback", { n: p.version.versionNumber })
          : t("content.identity.versions.confirmRetire", { n: p.version.versionNumber })
      : p.kind === "approve"
        ? `לאשר את גרסה ${p.version.versionNumber} כגרסה שבחרת?`
        : p.kind === "rollback"
          ? `ניצור גרסה חדשה המבוססת על גרסה ${p.version.versionNumber} ונגדיר אותה כגרסה המאושרת.`
          : `לבטל את הטיוטה (גרסה ${p.version.versionNumber})? היא תישאר בהיסטוריה.`;

  const confirmPanel = (v: LandingVersionSummary) =>
    pending && pending.version.id === v.id ? (
      <div className={styles.confirm} role="group" aria-label={t("content.identity.versions.confirmAria")}>
        <p>{confirmText(pending)}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void confirm()}>
            {busy ? t("content.identity.versions.wait") : pending.kind === "approve" ? t("content.identity.versions.yesApprove") : pending.kind === "rollback" ? t("content.identity.versions.yesRestore") : t("content.identity.versions.yesRetire")}
          </button>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => setPending(null)}>{t("content.identity.versions.cancel")}</button>
        </div>
      </div>
    ) : null;

  const preview = (v: LandingVersionSummary) => (
    <Link className={styles.secondary} href={`/business/landing-preview?version=${v.id}`}>{t("content.identity.versions.preview")}</Link>
  );

  return (
    <div className={styles.wrap}>
      <p className={styles.intro}>
        {t("content.identity.versions.intro")}
      </p>

      {notice && <p className={styles.notice} role="status">{notice}</p>}

      <section className={styles.current} aria-label={t("content.identity.versions.currentAria")}>
        <article className={styles.card}>
          <h2 className={styles.cardTitle}>{t("content.identity.versions.approvedTitle")}</h2>
          {currentApproved ? (
            <>
              <div className={styles.row}>
                <span className={styles.badgeApproved}>{VERSION_BADGE.APPROVED}</span>
                <strong>{t("content.identity.versions.versionN", { n: currentApproved.versionNumber })}</strong>
                <span className={styles.muted}>{strategyTitle(currentApproved.strategyType)}</span>
              </div>
              <p className={styles.muted}>
                {t("content.identity.versions.approvedOn", { date: dateHe(currentApproved.approvedAt) })}
                {currentApproved.rollbackSourceVersionNumber ? t("content.identity.versions.restoredFromSuffix", { n: currentApproved.rollbackSourceVersionNumber }) : ""}
              </p>
              <ReadinessNote readiness={currentApproved.currentReadiness} />
              <div className={styles.actions}>{preview(currentApproved)}</div>
            </>
          ) : (
            <p className={styles.muted}>{t("content.identity.versions.noApproved")}</p>
          )}
        </article>

        <article className={styles.card}>
          <h2 className={styles.cardTitle}>{t("content.identity.versions.draftTitle")}</h2>
          {currentDraft ? (
            <>
              <div className={styles.row}>
                <span className={styles.badgeDraft}>{VERSION_BADGE.DRAFT}</span>
                <strong>{t("content.identity.versions.versionN", { n: currentDraft.versionNumber })}</strong>
                <span className={styles.muted}>{strategyTitle(currentDraft.strategyType)}</span>
              </div>
              <p className={styles.muted}>{t("content.identity.versions.savedOn", { date: dateHe(currentDraft.createdAt) })}</p>
              <ReadinessNote readiness={currentDraft.currentReadiness} />
              <div className={styles.actions}>
                {preview(currentDraft)}
                <button type="button" className={styles.primary} onClick={() => ask("approve", currentDraft)}>{t("content.identity.versions.approve")}</button>
                <button type="button" className={styles.quiet} onClick={() => ask("retire", currentDraft)}>{t("content.identity.versions.retire")}</button>
              </div>
              {confirmPanel(currentDraft)}
            </>
          ) : (
            <p className={styles.muted}>{t("content.identity.versions.noDraft")}</p>
          )}
          <Link className={styles.create} href="/business/landing-strategy">{t("content.identity.versions.createNew")}</Link>
          {!data.composerEnabled && <p className={styles.muted}>{t("content.identity.versions.composerOff")}</p>}
        </article>
      </section>

      <section aria-label={t("content.identity.versions.historyAria")}>
        <h2 className={styles.sectionTitle}>{t("content.identity.versions.allVersions")}</h2>
        {versions.length === 0 ? (
          <p className={styles.muted}>{t("content.identity.versions.noVersions")}</p>
        ) : (
          <ol className={styles.history}>
            {versions.map((v) => (
              <li key={v.id} className={styles.item}>
                <div className={styles.row}>
                  <span className={badgeClass(v)}>{VERSION_BADGE[v.status] ?? v.status}</span>
                  <strong>{t("content.identity.versions.versionN", { n: v.versionNumber })}</strong>
                  <span className={styles.muted}>{strategyTitle(v.strategyType)}</span>
                </div>
                <p className={styles.muted}>
                  {t("content.identity.versions.savedOn", { date: dateHe(v.createdAt) })}
                  {v.approvedAt ? t("content.identity.versions.approvedOnSuffix", { date: dateHe(v.approvedAt) }) : ""}
                  {v.rollbackSourceVersionNumber ? t("content.identity.versions.restoredFromSuffix", { n: v.rollbackSourceVersionNumber }) : ""}
                </p>
                <div className={styles.actions}>
                  {preview(v)}
                  {v.authority === "OWNER_APPROVED" && !v.isCurrentApproved && (
                    <button type="button" className={styles.secondary} onClick={() => ask("rollback", v)}>{t("content.identity.versions.restore")}</button>
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
