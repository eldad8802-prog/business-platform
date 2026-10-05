"use client";

import { useEffect, useState } from "react";
import { CHANNEL_LABELS } from "@/components/business/identity/identity-labels";
import { STRATEGY_TITLES } from "@/lib/services/landing/landing-strategy-explain";
import type { LandingStrategySet } from "@/lib/services/landing/landing-strategy-engine";
import { MISSING_LABELS, SECTION_LABELS, SET_CONFLICT_LABELS } from "./landing-labels";
import styles from "./landing-strategy.module.css";

/**
 * P3-B — owner preview of the strategy directions Dubiz would build a landing page on. Read-only:
 * no page, no copy, no choice is stored. It shows WHY each direction was proposed, how a visitor would
 * act, what it focuses on, and what is still missing to publish it.
 */

function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchSet(): Promise<LandingStrategySet | null> {
  try {
    const res = await fetch("/api/business/landing-strategies", { headers: authHeaders(), cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { strategySet: LandingStrategySet }).strategySet;
  } catch {
    return null;
  }
}

const label = (map: Record<string, string>, code: string) => map[code] ?? map[code.replace(/^ASSET:/, "")] ?? code;

export function LandingStrategyPreview() {
  const [set, setSet] = useState<LandingStrategySet | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    void fetchSet().then((result) => {
      if (cancelled) return;
      setSet(result);
      setState(result ? "ready" : "error");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading") return <p className={styles.muted}>טוען…</p>;
  if (state === "error" || !set) return <p className={styles.alert}>לא הצלחנו לטעון את הכיוונים כרגע.</p>;

  const { readiness } = set;
  return (
    <div className={styles.wrap}>
      <section className={styles.summary} aria-label="מוכנות">
        <div>
          <strong>בחירת כיוון</strong>
          <span className={readiness.strategy.canGenerateStrategies ? styles.ok : styles.warnText}>
            {readiness.strategy.canGenerateStrategies ? "אפשר להציע כיוונים" : "עדיין אין מספיק מידע"}
          </span>
        </div>
        <div>
          <strong>פרסום דף</strong>
          <span className={readiness.publication.publishReady ? styles.ok : styles.warnText}>
            {readiness.publication.publishReady ? "יש את כל מה שצריך" : "חסרים פרטים לפרסום"}
          </span>
        </div>
      </section>

      {set.conflicts.filter((c) => SET_CONFLICT_LABELS[c.code]).map((c) => (
        <p key={c.code} className={styles.note}>{SET_CONFLICT_LABELS[c.code]}</p>
      ))}

      {set.strategies.length === 0 ? (
        <p className={styles.alert}>
          עדיין אין כיוון שאפשר להציע בלי להמציא. {readiness.strategy.blockingReasons.map((r) => label(MISSING_LABELS, r)).join(" · ")}
        </p>
      ) : (
        <ol className={styles.grid}>
          {set.strategies.map((s, i) => {
            const conv = s.primaryConversion;
            return (
              <li key={s.id} className={styles.card}>
                <div className={styles.cardHead}>
                  <span className={styles.badge}>{i === 0 ? "מומלץ" : `חלופה ${i}`}</span>
                  <h2 className={styles.h2}>{STRATEGY_TITLES[s.strategyType]}</h2>
                </div>
                <p className={styles.why}>{s.ownerExplanation}</p>
                <dl className={styles.facts}>
                  <div>
                    <dt>פעולה ללקוח</dt>
                    <dd>{conv.kind === "ACTION" ? CHANNEL_LABELS[conv.channel] ?? conv.channel : "בלי כפתור פעולה (אין עדיין דרך פנייה מאושרת)"}</dd>
                  </div>
                  <div>
                    <dt>במרכז הדף</dt>
                    <dd>{s.offeringFocus.primary.length ? s.offeringFocus.primary.map((o) => o.name).join(" · ") : "—"}</dd>
                  </div>
                  <div>
                    <dt>מבנה</dt>
                    <dd>{s.recommendedSections.filter((x) => x.required || x.dataAvailable).map((x) => SECTION_LABELS[x.section] ?? x.section).join(" ← ")}</dd>
                  </div>
                </dl>
                {s.publication.missing.length > 0 && (
                  <div className={styles.missing}>
                    <strong>חסר כדי לפרסם</strong>
                    <ul>
                      {s.publication.missing.map((m) => (
                        <li key={m}>{label(MISSING_LABELS, m)}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className={styles.muted}>
        אלה הצעות בלבד. שום דבר לא נשמר ולא מתפרסם; דף יוצג ללקוחות רק עם פרטים שאישרת לשימוש פומבי.
      </p>
    </div>
  );
}
