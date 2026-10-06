"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState, type ReactNode } from "react";

import { IconSparkle } from "@/components/navigation/nav-icons";
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

const ERRORS: Record<string, string> = {
  VERSION_MISMATCH: "ההמלצה התעדכנה בינתיים. טענו את הגרסה העדכנית — בדוק אותה ונסה שוב.",
  NOT_ACTIVE: "ההמלצה כבר לא פעילה, ולכן אי אפשר להחליט עליה.",
  NOT_FOUND: "ההמלצה לא נמצאה.",
  FEATURE_DISABLED: "המלצות Dubiz לא פעילות כרגע בעסק שלך.",
  FAILED: "לא הצלחנו לשמור את ההחלטה. נסה שוב.",
};

export default function RecommendationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const recommendationId = Number(id);
  const router = useRouter();

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
      (e: Error) => { if (!cancelled) setLoadError(e.message === "NOT_FOUND" ? "ההמלצה לא נמצאה." : "לא הצלחנו לטעון את ההמלצה."); },
    );
    return () => { cancelled = true; };
  }, [recommendationId, reloadToken]);

  const keyFor = useCallback((kind: DecisionKind, version: number) => {
    const existing = keys[kind];
    if (existing) return existing;
    const k = newIdempotencyKey(recommendationId, version, kind);
    setKeys((prev) => ({ ...prev, [kind]: k }));
    return k;
  }, [keys, recommendationId]);

  if (!Number.isInteger(recommendationId) || recommendationId <= 0) {
    return <Shell><p className={`${styles.message} ${styles.messageError}`}>קישור לא תקין.</p></Shell>;
  }
  if (loadError) return <Shell><p className={`${styles.message} ${styles.messageError}`} role="alert">{loadError}</p></Shell>;
  if (data === null) return <Shell><p className={styles.lead} aria-live="polite">טוען…</p></Shell>;
  if (!data.enabled) return <Shell><div className={styles.empty}>המלצות Dubiz עדיין לא פעילות בעסק שלך.</div></Shell>;

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
      setError(ERRORS[result.code] ?? ERRORS.FAILED);
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
    setSaved("ההחלטה נשמרה.");
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
            Dubiz ממליץ
          </span>
          <h1 id="rec-what" className={styles.what}>{v.what}</h1>
          <p className={styles.summary}>{v.summary}</p>
          <StageBadge view={v} />
        </div>
      </section>

      <div className={styles.twoCol}>
        <section className={styles.card} aria-labelledby="rec-why">
          <h2 id="rec-why" className={styles.sectionTitle}>למה Dubiz ממליץ על זה</h2>
          <ul className={styles.bullets}>
            {v.why.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </section>
        <section className={styles.card} aria-labelledby="rec-evidence">
          <h2 id="rec-evidence" className={styles.sectionTitle}>על מה זה מבוסס</h2>
          <ul className={styles.facts}>
            {v.evidence.lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p className={styles.note}>{v.evidence.capturedNote}</p>
          {!v.evidence.intact ? <p className={styles.warn}>לא ניתן לאמת שהנתונים השמורים לא השתנו.</p> : null}
        </section>
      </div>

      {v.after.length > 0 ? (
        <section className={styles.card} aria-labelledby="rec-after">
          <h2 id="rec-after" className={styles.sectionTitle}>מה קרה מאז</h2>
          <ul className={styles.bullets}>
            {v.after.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {v.handoff && v.stage === "in_progress" ? (
            <div className={styles.actions} style={{ marginTop: 14 }}>
              <Link href={v.handoff} className={`${styles.button} ${styles.primary}`}>להמשך הטיפול</Link>
            </div>
          ) : null}
        </section>
      ) : null}

      {error ? <p className={`${styles.message} ${styles.messageError}`} role="alert">{error}</p> : null}
      {saved ? <p className={`${styles.message} ${styles.messageOk}`} role="status">{saved}</p> : null}

      {v.decidable && v.decision && !changing ? (
        <div className={styles.actions}>
          <button type="button" className={`${styles.button} ${styles.quiet}`} onClick={() => setChanging(true)}>
            לשנות את ההחלטה
          </button>
        </div>
      ) : null}

      {showOptions ? (
        <section className={styles.card} aria-labelledby="rec-do">
          <h2 id="rec-do" className={styles.sectionTitle}>מה אפשר לעשות</h2>
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
                רק חלק מהם
              </button>
            ) : null}
            <button type="button" className={styles.button} disabled={busy} aria-expanded={panel === "NOT_NOW"}
              onClick={() => setPanel(panel === "NOT_NOW" ? null : "NOT_NOW")}>
              לא עכשיו
            </button>
            <button type="button" className={styles.button} disabled={busy} aria-expanded={panel === "REJECT"}
              onClick={() => setPanel(panel === "REJECT" ? null : "REJECT")}>
              לא רלוונטי
            </button>
          </div>

          {panel === "MODIFY" ? (
            <div className={styles.panel}>
              <p className={styles.panelTitle}>באילו מסמכים תטפל עכשיו?</p>
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
                  לבדיקת {selected.length > 0 ? selected.length : ""} המסמכים שנבחרו
                </button>
              </div>
            </div>
          ) : null}

          {panel === "NOT_NOW" ? (
            <div className={styles.panel}>
              <p className={styles.panelTitle}>מתי לחזור לזה?</p>
              <div className={styles.chips} role="group" aria-label="מתי לחזור לזה">
                {data.notNow.map((c) => (
                  <button key={c.days} type="button" className={styles.chip} aria-pressed={deferDays === c.days} onClick={() => setDeferDays(c.days)}>
                    {c.label}
                  </button>
                ))}
              </div>
              <div className={styles.actions}>
                <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy || deferDays == null}
                  onClick={() => submit("NOT_NOW", { deferDays: deferDays ?? undefined }, null)}>
                  לשמור
                </button>
              </div>
            </div>
          ) : null}

          {panel === "REJECT" ? (
            <div className={styles.panel}>
              <p className={styles.panelTitle}>למה זה לא מתאים? (לא חובה)</p>
              <div className={styles.chips} role="group" aria-label="סיבה">
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
                  לשמור
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <p className={styles.footnote}>
        Dubiz לא מבצע פעולות בשמך. תשלום או בדיקת מסמך נרשמים רק כשאתה עושה אותם במסך המתאים, ו־Dubiz רואה אותם משם.
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
