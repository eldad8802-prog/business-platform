"use client";

/**
 * /setup — two short, skippable questions after signup, then Home.
 *
 *   1. "מה העסק עושה?"        → category / subCategory / businessModel (owner-declared)
 *   2. "עם מה תרצה להתחיל?"   → a product preference that picks Home's first action
 *
 * Each answer is saved the moment "המשך" is pressed, so a refresh, Back, or a
 * login on another device resumes with what was already chosen. Steps are real
 * history entries (useFlowStep), so Back walks them in the order taken; on
 * finishing, the setup entries are consumed and Back never returns into them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import BackButton from "@/components/ui/back-button";
import { WarmButton } from "@/components/ui/warm/warm-primitives";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { useFlowStep } from "@/hooks/useFlowStep";
import {
  BUSINESS_CATEGORY_OPTIONS,
  BUSINESS_MODEL_OPTIONS,
  businessCategoryLabel,
} from "@/lib/business/business-categories";
import {
  buildClientAuthHeaders,
  getClientAuthToken,
  redirectToLogin,
} from "@/lib/client-session";
import { consumeFlowEntries } from "@/lib/navigation/back-nav/trail-runtime";
import {
  SETUP_GOAL_OPTIONS,
  START_ACTIONS,
  defaultGoalFor,
  suggestedModelFor,
  type SetupGoal,
} from "@/lib/services/onboarding/setup-model";
import { invalidateCachedJson } from "@/lib/ui/cached-json";

import styles from "./setup.module.css";

type Step = "business" | "start";
const STEPS: readonly Step[] = ["business", "start"];
const SETUP_URL = "/api/business/setup";

type SetupState = {
  category: string | null;
  subCategory: string | null;
  businessModel: string | null;
  storedGoal: string | null;
};

export default function SetupPage() {
  useHideShellChrome(true);
  const router = useRouter();
  const flow = useFlowStep<Step>({ steps: STEPS });

  const [category, setCategory] = useState<string | null>(null);
  const [subCategory, setSubCategory] = useState<string | null>(null);
  const [businessModel, setBusinessModel] = useState<string | null>(null);
  const [goal, setGoal] = useState<SetupGoal | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Set on the owner's first tap, so a late prefill never overwrites a choice.
  const touchedBusiness = useRef(false);
  const touchedGoal = useRef(false);

  // Resume: whatever was already saved — on this device or another — is shown.
  useEffect(() => {
    if (!getClientAuthToken()) {
      redirectToLogin();
      return;
    }
    let cancelled = false;
    fetch(SETUP_URL, { headers: buildClientAuthHeaders(), cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) {
          redirectToLogin();
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const s = (await res.json()) as SetupState;
        if (cancelled) return;
        // Saved answers fill only what the owner has not touched yet: on a slow
        // connection they may already have tapped a choice, and that wins.
        if (!touchedBusiness.current) {
          setCategory(s.category);
          setSubCategory(s.subCategory);
          setBusinessModel(s.businessModel);
        }
        const stored = s.storedGoal;
        if (!touchedGoal.current && stored && SETUP_GOAL_OPTIONS.some((o) => o.value === stored)) {
          setGoal(stored as SetupGoal);
        }
      })
      .catch(() => {
        // Setup still works without a prefill: every answer is optional.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const category0 = useMemo(
    () => BUSINESS_CATEGORY_OPTIONS.find((c) => c.value === category) ?? null,
    [category]
  );
  const businessComplete = Boolean(category && subCategory && businessModel);

  const post = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(SETUP_URL, {
        method: "POST",
        headers: buildClientAuthHeaders(),
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        redirectToLogin();
        return false;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "לא הצלחנו לשמור. נסו שוב.");
        return false;
      }
      return true;
    } catch {
      setError("אין חיבור כרגע. נסו שוב.");
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const finish = useCallback(
    async (chosen: SetupGoal | null) => {
      const ok = await post({ step: "start", goal: chosen });
      if (!ok) return;
      invalidateCachedJson(SETUP_URL);
      // Setup is done: its steps leave the trail so Back from Home never
      // re-enters a finished flow.
      consumeFlowEntries((url) => new URL(url, window.location.origin).pathname === "/setup");
      // A client replace, not a full navigation: the back-nav trail stays live
      // across it, which is what lets Back from Home skip the consumed steps.
      // (A full navigation was measured to let browser Back reopen /setup.)
      router.replace("/app");
    },
    [post, router]
  );

  const onBusinessContinue = async () => {
    if (!businessComplete) return;
    const ok = await post({ step: "business", category, subCategory, businessModel });
    if (ok) flow.go("start");
  };

  const previewGoal: SetupGoal = goal ?? defaultGoalFor(businessModel);
  const previewLabel = category ? businessCategoryLabel(category, subCategory) : null;
  const stepIndex = flow.step === "business" ? 0 : 1;

  return (
    <div className={styles.page} dir="rtl">
      <div className={styles.top}>
        <div className={styles.progress} aria-live="polite">
          <div className={styles.progressLabel}>
            שלב {stepIndex + 1} מתוך {STEPS.length} · כדקה
          </div>
          <div className={styles.bar} aria-hidden>
            {STEPS.map((s, i) => (
              <span key={s} className={`${styles.barSeg} ${i <= stepIndex ? styles.barSegOn : ""}`} />
            ))}
          </div>
        </div>
        <BackButton fallback="/app" fallbackLabel="לבית" />
      </div>

      <main className={styles.body}>
        {flow.step === "business" ? (
          <section className={styles.card} aria-labelledby="setup-business-title">
            <div>
              <h1 id="setup-business-title" className={styles.title}>
                מה העסק עושה?
              </h1>
              <p className={styles.why}>
                כך נתאים לך דוגמאות, תוכן והמלצות. אפשר לשנות את זה בכל רגע.
              </p>
            </div>

            <div>
              <p className={styles.label} id="setup-category">
                תחום
              </p>
              <div className={styles.tiles} role="radiogroup" aria-labelledby="setup-category">
                {BUSINESS_CATEGORY_OPTIONS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    role="radio"
                    aria-checked={category === c.value}
                    className={`${styles.tile} ${category === c.value ? styles.tileOn : ""}`}
                    onClick={() => {
                      touchedBusiness.current = true;
                      if (category !== c.value) {
                        setCategory(c.value);
                        setSubCategory(c.subCategories.length === 1 ? c.subCategories[0].value : null);
                        setBusinessModel((m) => m ?? suggestedModelFor(c.value));
                      }
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            {category0 && (
              <div>
                <p className={styles.label} id="setup-sub">
                  ובאופן יותר מדויק
                </p>
                <div className={styles.chips} role="radiogroup" aria-labelledby="setup-sub">
                  {category0.subCategories.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      role="radio"
                      aria-checked={subCategory === s.value}
                      className={`${styles.tile} ${subCategory === s.value ? styles.tileOn : ""}`}
                      onClick={() => {
                        touchedBusiness.current = true;
                        setSubCategory(s.value);
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {category0 && (
              <div>
                <p className={styles.label} id="setup-model">
                  העסק מוכר
                </p>
                <div className={styles.chips} role="radiogroup" aria-labelledby="setup-model">
                  {BUSINESS_MODEL_OPTIONS.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      role="radio"
                      aria-checked={businessModel === m.value}
                      className={`${styles.tile} ${businessModel === m.value ? styles.tileOn : ""}`}
                      onClick={() => {
                        touchedBusiness.current = true;
                        setBusinessModel(m.value);
                      }}
                    >
                      {m.value === "service" ? "שירותים" : m.value === "product" ? "מוצרים" : "גם וגם"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}

            <div className={styles.actions}>
              <WarmButton
                fullWidth
                disabled={!businessComplete || saving}
                onClick={onBusinessContinue}
              >
                {saving ? "שומרים…" : "המשך"}
              </WarmButton>
              <WarmButton variant="text" fullWidth disabled={saving} onClick={() => flow.go("start")}>
                אמלא אחר כך
              </WarmButton>
            </div>
          </section>
        ) : (
          <section className={styles.card} aria-labelledby="setup-start-title">
            <div>
              <h1 id="setup-start-title" className={styles.title}>
                עם מה תרצה להתחיל?
              </h1>
              <p className={styles.why}>
                נציג לך בבית את הצעד הראשון שמתאים לזה. כל השאר נשאר זמין.
              </p>
            </div>

            <div className={styles.goals} role="radiogroup" aria-labelledby="setup-start-title">
              {SETUP_GOAL_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={goal === o.value}
                  className={`${styles.goal} ${goal === o.value ? styles.goalOn : ""}`}
                  onClick={() => {
                    touchedGoal.current = true;
                    setGoal(o.value);
                  }}
                >
                  <span className={styles.goalTitle}>{o.title}</span>
                  <span className={styles.goalHint}>{o.hint}</span>
                </button>
              ))}
            </div>

            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}

            <div className={styles.actions}>
              <WarmButton fullWidth disabled={!goal || saving} onClick={() => finish(goal)}>
                {saving ? "שומרים…" : "לבית שלי"}
              </WarmButton>
              <WarmButton variant="text" fullWidth disabled={saving} onClick={() => finish(null)}>
                דלג
              </WarmButton>
            </div>
          </section>
        )}

        <aside className={styles.preview} aria-label="כך Dubiz יראה אצלך">
          <p className={styles.previewTitle}>כך Dubiz יראה אצלך</p>
          <div className={styles.previewCard}>
            <span className={styles.previewName}>{previewLabel ?? "העסק שלך"}</span>
            <span className={styles.previewMuted}>
              {previewLabel ? "הדוגמאות וההמלצות יותאמו לתחום הזה." : "בחרו תחום כדי שנתאים את הדוגמאות."}
            </span>
          </div>
          <div className={styles.previewCard}>
            <span className={styles.previewMuted}>הצעד הראשון בבית</span>
            <span className={styles.previewName}>{START_ACTIONS[previewGoal].title}</span>
            <span className={styles.previewMuted}>{START_ACTIONS[previewGoal].body}</span>
          </div>
        </aside>
      </main>
    </div>
  );
}
