"use client";

/**
 * /setup — one short, skippable screen after signup, then the ordinary Home.
 *
 *   "ספרו לנו קצת על העסק"        → DESCRIPTION, in the owner's own words
 *   "מי בדרך כלל הלקוחות שלכם?"   → TARGET_AUDIENCE INDIVIDUALS / BUSINESSES / both
 *
 * Both are optional and both are saved as the owner goes (the text on blur,
 * the choice on tap), so leaving and coming back — on any device — lands on
 * this same screen with what was already said. Nothing here picks a category,
 * a goal or a first action. Finishing or skipping stamps the business once;
 * the Home then never redirects here again.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useI18n } from "@/components/i18n/I18nProvider";
import { AccessibilityTrigger } from "@/components/ui/accessibility/accessibility-trigger";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { useSessionIdentity } from "@/components/navigation/nav-signals";
import { buildClientAuthHeaders, getClientAuthToken, redirectToLogin } from "@/lib/client-session";
import { consumeFlowEntries } from "@/lib/navigation/back-nav/trail-runtime";
import { DESCRIPTION_MAX, type SetupAudience, type SetupView } from "@/lib/services/onboarding/setup-model";
import type { MessageKey } from "@/lib/i18n/translate";
import { invalidateCachedJson } from "@/lib/ui/cached-json";

import styles from "./setup.module.css";

const SETUP_URL = "/api/business/setup";
const HISTORY_URL = "/api/home/history";

const AUDIENCE_OPTIONS: Array<{ value: SetupAudience; label: MessageKey; icon: "person" | "building" | "both" }> = [
  { value: "INDIVIDUALS", label: "account.setup.audience.individuals", icon: "person" },
  { value: "BUSINESSES", label: "account.setup.audience.businesses", icon: "building" },
  { value: "BOTH", label: "account.setup.audience.both", icon: "both" },
];

const AUDIENCE_SUMMARY: Record<SetupAudience, MessageKey> = {
  INDIVIDUALS: "account.setup.audienceSummary.individuals",
  BUSINESSES: "account.setup.audienceSummary.businesses",
  BOTH: "account.setup.audienceSummary.both",
};

type SaveState = "idle" | "saving" | "saved" | "error";

export default function SetupPage() {
  useHideShellChrome(true);
  const router = useRouter();
  const { t } = useI18n();
  const { businessName, userName } = useSessionIdentity(true);

  const [description, setDescription] = useState("");
  const [audience, setAudience] = useState<SetupAudience | null>(null);
  const [savedDescription, setSavedDescription] = useState("");
  const [resumed, setResumed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The owner's own edits always win over a late prefill.
  const touchedText = useRef(false);
  const touchedAudience = useRef(false);

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
        const s = (await res.json()) as SetupView;
        if (cancelled) return;
        if (!touchedText.current && s.description) {
          setDescription(s.description);
          setSavedDescription(s.description);
        }
        if (!touchedAudience.current && s.audience) setAudience(s.audience);
        if (s.needsSetup && (s.description || s.audience)) setResumed(true);
      })
      .catch(() => {
        // The screen still works without a prefill: every answer is optional.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const post = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
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
        setError(data?.error ?? t("account.setup.saveFailed"));
        return false;
      }
      setError("");
      return true;
    } catch {
      setError(t("account.setup.offline"));
      return false;
    }
  }, [t]);

  const saveText = useCallback(async () => {
    const text = description.trim();
    if (!text || text === savedDescription.trim()) return;
    setSaveState("saving");
    const ok = await post({ step: "about", description: text });
    if (ok) setSavedDescription(text);
    setSaveState(ok ? "saved" : "error");
  }, [description, savedDescription, post]);

  const chooseAudience = useCallback(
    async (value: SetupAudience) => {
      touchedAudience.current = true;
      setAudience(value);
      await post({ step: "about", audience: value });
    },
    [post]
  );

  const leave = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      const ok = await post(body);
      setBusy(false);
      if (!ok) return;
      invalidateCachedJson(SETUP_URL);
      invalidateCachedJson(HISTORY_URL);
      // The screen is done: it leaves the back-nav trail so Back from Home
      // never re-enters it. A client replace keeps that trail live.
      consumeFlowEntries((url) => new URL(url, window.location.origin).pathname === "/setup");
      router.replace("/app");
    },
    [post, router]
  );

  const onContinue = () => {
    const text = description.trim();
    void leave({
      step: "complete",
      ...(text && text !== savedDescription.trim() ? { description: text } : {}),
      ...(audience ? { audience } : {}),
    });
  };

  const name = businessName ?? t("account.setup.businessFallback");
  const firstName = userName?.split(/\s+/)[0] ?? null;
  const hasText = description.trim().length > 0;

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <div className={styles.logo}>
          <span className={styles.logoMark} aria-hidden="true">d</span>
          <span className={styles.logoWord} dir="ltr">dubiz</span>
        </div>
        <AccessibilityTrigger className={styles.iconBtn} label={t("account.setup.a11ySettings")} />
      </header>

      <main className={styles.main}>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            onContinue();
          }}
          aria-labelledby="setup-title"
        >
          {resumed ? (
            <div className={styles.resume} role="status">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" />
              </svg>
              <span>
                <b>{t("account.setup.resumedLead")}</b> {t("account.setup.resumedRest")}
              </span>
            </div>
          ) : (
            <p className={styles.eyebrow}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M8 12.5l2.6 2.5L16 9.5" />
              </svg>
              {firstName ? t("account.setup.openedNamed", { name: firstName }) : t("account.setup.opened")}
            </p>
          )}

          <div className={styles.head}>
            <h1 id="setup-title" className={styles.title}>
              {t("account.setup.title", { name })}
            </h1>
            <p className={styles.sub}>{t("account.setup.sub")}</p>
          </div>

          <div className={styles.field}>
            <label htmlFor="setup-description" className={styles.label}>
              {t("account.setup.descriptionLabel")}
            </label>
            <textarea
              id="setup-description"
              className={styles.textarea}
              maxLength={DESCRIPTION_MAX}
              placeholder={t("account.setup.descriptionPlaceholder")}
              value={description}
              onChange={(e) => {
                touchedText.current = true;
                setDescription(e.target.value);
                if (saveState !== "idle") setSaveState("idle");
              }}
              onBlur={() => void saveText()}
              aria-describedby="setup-description-meta"
            />
            <div id="setup-description-meta" className={styles.meta}>
              <span aria-live="polite">
                {saveState === "saving" ? (
                  t("account.setup.saving")
                ) : saveState === "saved" ? (
                  <span className={styles.saved}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                    {t("account.setup.saved")}
                  </span>
                ) : null}
              </span>
              <span className={styles.count}>
                {description.length}/{DESCRIPTION_MAX}
              </span>
            </div>
          </div>

          <fieldset className={styles.fieldset}>
            <legend className={styles.label}>{t("account.setup.audienceLegend")}</legend>
            <div className={styles.options}>
              {AUDIENCE_OPTIONS.map((o) => {
                const on = audience === o.value;
                return (
                  <label key={o.value} className={`${styles.option} ${on ? styles.optionOn : ""}`}>
                    <input
                      type="radio"
                      name="setup-audience"
                      value={o.value}
                      checked={on}
                      onChange={() => void chooseAudience(o.value)}
                    />
                    <span className={styles.optionIcon} aria-hidden="true">
                      <AudienceIcon kind={o.icon} />
                    </span>
                    <span className={styles.optionLabel}>{t(o.label)}</span>
                    <span className={styles.mark} aria-hidden="true">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12.5l4.5 4.5L19 7.5" />
                      </svg>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}

          <div className={styles.actions}>
            <button type="submit" className={styles.primary} disabled={busy}>
              {t("account.setup.continue")}
            </button>
            <button type="button" className={styles.ghost} disabled={busy} onClick={() => void leave({ step: "skip" })}>
              {t("account.setup.skip")}
            </button>
          </div>
        </form>

        <aside className={styles.card} aria-label={t("account.setup.card.ariaLabel", { name })}>
          <div className={styles.cardHead}>
            <span className={styles.cardMark} aria-hidden="true">
              {name.trim().charAt(0)}
            </span>
            <span className={styles.cardName}>{name}</span>
          </div>
          <div className={styles.cardSection}>
            <span className={styles.cardEyebrow}>{t("account.setup.card.told")}</span>
            <div className={styles.cardRow}>
              <span className={styles.cardKey}>{t("account.setup.card.about")}</span>
              {hasText ? <span className={styles.chipOwn}>{t("account.setup.card.byYou")}</span> : null}
            </div>
            {hasText ? <p className={styles.cardQuote}>{t("account.setup.card.quote", { text: description.trim() })}</p> : <p className={styles.cardEmpty}>{t("account.setup.card.notWritten")}</p>}
            <div className={`${styles.cardRow} ${styles.cardRowSplit}`}>
              <span className={styles.cardKey}>{t("account.setup.card.customers")}</span>
              <span className={styles.cardValue}>
                {audience ? t(AUDIENCE_SUMMARY[audience]) : <span className={styles.cardEmpty}>{t("account.setup.card.notChosen")}</span>}
                {audience ? <span className={styles.chipOwn}>{t("account.setup.card.byYou")}</span> : null}
              </span>
            </div>
          </div>
          <div className={`${styles.cardSection} ${styles.cardLearn}`}>
            <span className={styles.cardEyebrow}>{t("account.setup.card.learnTitle")}</span>
            <LearnRow title={t("account.setup.card.learnSellTitle")} sub={t("account.setup.card.learnSellSub")} badge={t("account.setup.card.learnBadge")} />
            <LearnRow title={t("account.setup.card.learnLeadsTitle")} sub={t("account.setup.card.learnLeadsSub")} badge={t("account.setup.card.learnBadge")} />
            <LearnRow title={t("account.setup.card.learnMoneyTitle")} sub={t("account.setup.card.learnMoneySub")} badge={t("account.setup.card.learnBadge")} />
          </div>
          <p className={styles.private}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
              <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
            </svg>
            {t("account.setup.card.private")}
          </p>
        </aside>
      </main>
    </div>
  );
}

function LearnRow({ title, sub, badge }: { title: string; sub: string; badge: string }) {
  return (
    <div className={styles.learn}>
      <span className={styles.learnText}>
        <span className={styles.learnTitle}>{title}</span>
        <span className={styles.learnSub}>{sub}</span>
      </span>
      <span className={styles.chipLearn}>{badge}</span>
    </div>
  );
}

function AudienceIcon({ kind }: { kind: "person" | "building" | "both" }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (kind === "person") {
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="3.6" />
        <path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" />
      </svg>
    );
  }
  if (kind === "building") {
    return (
      <svg {...common}>
        <path d="M4 20V6.5L12 4v16M12 9h8v11M4 20h16M7.5 9.5h1M7.5 13h1M7.5 16.5h1M15.5 12.5h1M15.5 16h1" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="8" cy="9" r="3" />
      <path d="M2.8 19c.6-3 2.6-4.6 5.2-4.6 1.3 0 2.4.4 3.2 1.1M13 20v-9.5l4-1.3V20M17 12h4v8M12 20h10" />
    </svg>
  );
}
