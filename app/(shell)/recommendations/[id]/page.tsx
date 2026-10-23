"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState, type ReactNode } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { IconSparkle } from "@/components/navigation/nav-icons";
import type { MessageKey } from "@/lib/i18n/translate";
import BackButton from "@/components/ui/back-button";
import { PageContainer } from "@/components/ui/page-container";
import { RecommendationIcon, StageBadge } from "@/features/recommendations/recommendation-parts";
import {
  decide,
  loadRecommendation,
  newIdempotencyKey,
  type DecideInput,
  type DecisionKind,
  type RecommendationPayload,
} from "@/features/recommendations/recommendations-client";
import styles from "@/features/recommendations/recommendations.module.css";

/**
 * One Dubiz recommendation: WHAT, WHY (from the evidence captured when it was made), EVIDENCE, WHAT CAN I DO,
 * and — once there is something — what happened after, in time order only.
 *
 * ACCEPT records the owner's answer and continues in the real flow (the payment form, the document review).
 * Nothing on this screen marks anything as done: that is what the ledger shows afterwards.
 */
type Panel = null | "MODIFY" | "NOT_NOW" | "REJECT";

const ERRORS: Record<string, MessageKey> = {
  VERSION_MISMATCH: "home.recommendations.errors.VERSION_MISMATCH",
  NOT_ACTIVE: "home.recommendations.errors.NOT_ACTIVE",
  NOT_FOUND: "home.recommendations.errors.NOT_FOUND",
  FEATURE_DISABLED: "home.recommendations.errors.FEATURE_DISABLED",
  FAILED: "home.recommendations.errors.FAILED",
};

export default function RecommendationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const recommendationId = Number(id);
  const router = useRouter();
  const { t } = useI18n();

  const [data, setData] = useState<RecommendationPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [panel, setPanel] = useState<Panel>(null);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [deferDays, setDeferDays] = useState<number | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  // One key per answer kind for this screen visit: a double tap repeats the SAME decision.
  const [keys, setKeys] = useState<Partial<Record<DecisionKind, string>>>({});

  useEffect(() => {
    let cancelled = false;
    loadRecommendation(recommendationId).then(
      (p) => { if (!cancelled) { setData(p); setLoadError(null); } },
      (e: Error) => { if (!cancelled) setLoadError(e.message === "NOT_FOUND" ? t("home.recommendations.notFound") : t("home.recommendations.loadOneFailed")); },
    );
    return () => { cancelled = true; };
  }, [recommendationId, reloadToken, t]);

  const keyFor = useCallback((kind: DecisionKind, version: number) => {
    const existing = keys[kind];
    if (existing) return existing;
    const k = newIdempotencyKey(recommendationId, version, kind);
    setKeys((prev) => ({ ...prev, [kind]: k }));
    return k;
  }, [keys, recommendationId]);

  if (!Number.isInteger(recommendationId) || recommendationId <= 0) {
    return <Shell><p className={`${styles.message} ${styles.messageError}`}>{t("home.recommendations.badLink")}</p></Shell>;
  }
  if (loadError) return <Shell><p className={`${styles.message} ${styles.messageError}`} role="alert">{loadError}</p></Shell>;
  if (data === null) return <Shell><p className={styles.lead} aria-live="polite">{t("home.recommendations.loading")}</p></Shell>;
  if (!data.enabled) return <Shell><div className={styles.empty}>{t("home.recommendations.disabled")}</div></Shell>;

  const v = data.item;
  const accept = v.options.find((o) => o.decision === "ACCEPT");
  const canModify = v.options.some((o) => o.decision === "MODIFY") && v.selectable.length > 1;
  const showOptions = v.decidable && (!v.decision || changing);

  async function submit(kind: DecisionKind, input: Omit<DecideInput, "decision" | "recommendationVersion">, next: string | null) {
    setBusy(true);
    setError(null);
    setSaved(null);
    const result = await decide(recommendationId, { decision: kind, recommendationVersion: v.version, ...input }, keyFor(kind, v.version));
    setBusy(false);
    if (!result.ok) {
      setError(t(ERRORS[result.code] ?? ERRORS.FAILED));
      if (result.code === "VERSION_MISMATCH" || result.code === "NOT_ACTIVE") setReloadToken((n) => n + 1);
      return;
    }
    setPanel(null);
    setChanging(false);
    setKeys({});
    if (next) {
      router.push(next);
      return;
    }
    setSaved(t("home.recommendations.saved"));
    setReloadToken((n) => n + 1);
  }

  const modifyHref = selected.length > 0 ? `/documents/review/${[...selected].sort((a, b) => a - b)[0]}` : null;

  return (
    <Shell>
      <section className={styles.hero} aria-labelledby="rec-what">
        <RecommendationIcon type={v.type} large />
        <div className={styles.heroText}>
          <span className={styles.eyebrow}>
            <IconSparkle size={14} strokeWidth={2} />
            {t("home.recommendations.eyebrow")}
          </span>
          <h1 id="rec-what" className={styles.what}>{v.what}</h1>
          <p className={styles.summary}>{v.summary}</p>
          <StageBadge view={v} />
        </div>
      </section>

      <div className={styles.twoCol}>
        <section className={styles.card} aria-labelledby="rec-why">
          <h2 id="rec-why" className={styles.sectionTitle}>{t("home.recommendations.why")}</h2>
          <ul className={styles.bullets}>
            {v.why.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </section>
        <section className={styles.card} aria-labelledby="rec-evidence">
          <h2 id="rec-evidence" className={styles.sectionTitle}>{t("home.recommendations.evidence")}</h2>
          <ul className={styles.facts}>
            {v.evidence.lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p className={styles.note}>{v.evidence.capturedNote}</p>
          {!v.evidence.intact ? <p className={styles.warn}>{t("home.recommendations.notIntact")}</p> : null}
        </section>
      </div>

      {v.after.length > 0 ? (
        <section className={styles.card} aria-labelledby="rec-after">
          <h2 id="rec-after" className={styles.sectionTitle}>{t("home.recommendations.after")}</h2>
          <ul className={styles.bullets}>
            {v.after.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {v.handoff && v.stage === "in_progress" ? (
            <div className={styles.actions} style={{ marginTop: 14 }}>
              <Link href={v.handoff} className={`${styles.button} ${styles.primary}`}>{t("home.recommendations.continue")}</Link>
            </div>
          ) : null}
        </section>
      ) : null}

      {error ? <p className={`${styles.message} ${styles.messageError}`} role="alert">{error}</p> : null}
      {saved ? <p className={`${styles.message} ${styles.messageOk}`} role="status">{saved}</p> : null}

      {v.decidable && v.decision && !changing ? (
        <div className={styles.actions}>
          <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={() => setChanging(true)}>
            {t("home.recommendations.change")}
          </button>
        </div>
      ) : null}

      {showOptions ? (
        <section className={styles.card} aria-labelledby="rec-do">
          <h2 id="rec-do" className={styles.sectionTitle}>{t("home.recommendations.whatCanIDo")}</h2>
          <div className={styles.actions}>
            {accept ? (
              <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy}
                onClick={() => submit("ACCEPT", {}, accept.href)}>
                {accept.label}
              </button>
            ) : null}
            {canModify ? (
              <button type="button" className={styles.button} disabled={busy} aria-expanded={panel === "MODIFY"}
                onClick={() => setPanel(panel === "MODIFY" ? null : "MODIFY")}>
                {t("home.recommendations.partial")}
              </button>
            ) : null}
            <button type="button" className={styles.button} disabled={busy} aria-expanded={panel === "NOT_NOW"}
              onClick={() => setPanel(panel === "NOT_NOW" ? null : "NOT_NOW")}>
              {t("home.recommendations.notNow")}
            </button>
            <button type="button" className={styles.button} disabled={busy} aria-expanded={panel === "REJECT"}
              onClick={() => setPanel(panel === "REJECT" ? null : "REJECT")}>
              {t("home.recommendations.reject")}
            </button>
          </div>

          {panel === "MODIFY" ? (
            <div className={styles.panel}>
              <p className={styles.panelTitle}>{t("home.recommendations.whichDocs")}</p>
              <ul className={styles.checks}>
                {v.selectable.map((s) => (
                  <li key={s.id}>
                    <label className={styles.check}>
                      <input type="checkbox" checked={selected.includes(s.id)}
                        onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))} />
                      <span>{s.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className={styles.actions}>
                <button type="button" className={`${styles.button} ${styles.primary}`}
                  disabled={busy || selected.length === 0 || selected.length >= v.selectable.length}
                  onClick={() => submit("MODIFY", { targets: selected }, modifyHref)}>
                  {selected.length > 0
                    ? t("home.recommendations.reviewSelected", { count: selected.length })
                    : t("home.recommendations.reviewSelectedNone")}
                </button>
              </div>
            </div>
          ) : null}

          {panel === "NOT_NOW" ? (
            <div className={styles.panel}>
              <p className={styles.panelTitle}>{t("home.recommendations.whenBack")}</p>
              <div className={styles.chips} role="group" aria-label={t("home.recommendations.whenBack")}>
                {data.notNow.map((c) => (
                  <button key={c.days} type="button" className={styles.chip} aria-pressed={deferDays === c.days} onClick={() => setDeferDays(c.days)}>
                    {c.label}
                  </button>
                ))}
              </div>
              <div className={styles.actions}>
                <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy || deferDays == null}
                  onClick={() => submit("NOT_NOW", { deferDays: deferDays ?? undefined }, null)}>
                  {t("home.recommendations.save")}
                </button>
              </div>
            </div>
          ) : null}

          {panel === "REJECT" ? (
            <div className={styles.panel}>
              <p className={styles.panelTitle}>{t("home.recommendations.whyNot")}</p>
              <div className={styles.chips} role="group" aria-label={t("home.recommendations.reasonAria")}>
                {data.reasons.map((r) => (
                  <button key={r.code} type="button" className={styles.chip} aria-pressed={reason === r.code}
                    onClick={() => setReason(reason === r.code ? null : r.code)}>
                    {r.label}
                  </button>
                ))}
              </div>
              <div className={styles.actions}>
                <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy}
                  onClick={() => submit("REJECT", { reasonCode: reason }, null)}>
                  {t("home.recommendations.save")}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <p className={styles.footnote}>
        {t("home.recommendations.footnote")}
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <PageContainer intent="standard">
      <div className={styles.page}>
        <div className={styles.topRow}>
          <BackButton />
        </div>
        {children}
      </div>
    </PageContainer>
  );
}
