"use client";

/**
 * הנוכחות הדיגיטלית של העסק — what Dubiz knows about the business, organised as four chapters,
 * on its way to a future landing page.
 *
 *   mobile   a step-by-step flow: orientation, then one chapter open at a time with "next"
 *   tablet   orientation and today's understanding first, then the chapters, then learned +
 *            preview side by side
 *   desktop  a workspace: chapters as the main column, a companion column with the future page,
 *            what Dubiz learned and what you told us
 *
 * Data: GET /api/business/identity-context (canonical), interpreted by buildLandingKnowledge.
 */
import { useMemo, useRef, useState } from "react";

import BackButton from "@/components/ui/back-button";
import { WarmPill, WarmTile, warmStyles } from "@/components/ui/warm-surface/warm-surface";
import { ChevronGlyph } from "@/components/ui/warm-surface/glyphs";
import { buildLandingKnowledge, type ChapterKey } from "@/lib/services/identity/landing-knowledge";

import { CHAPTER_COPY, CHAPTER_STATE_LABELS, NEED_LABELS } from "../identity-labels";
import { ChapterAction, ChapterAudience, ChapterWho, ChapterWhy } from "./chapters";
import { useIdentityContext } from "./identity-api";
import { LearnedCard, PreviewCard, UnderstandingCard } from "./panels";
import s from "./identity-screen.module.css";

const CHAPTER_BODY = { who: ChapterWho, audience: ChapterAudience, why: ChapterWhy, action: ChapterAction } as const;
const STATE_TONE = { COMPLETE: "mint", IN_PROGRESS: "sand", MISSING: "neutral" } as const;

export function IdentityScreen() {
  const { load, busy, error, clearError, actions } = useIdentityContext();
  const knowledge = useMemo(() => (load.state === "ready" ? buildLandingKnowledge(load.ctx) : null), [load]);
  const [open, setOpen] = useState<ChapterKey | null>(null);
  const chapterRefs = useRef<Partial<Record<ChapterKey, HTMLElement | null>>>({});

  const firstOpen = knowledge?.chapters.find((c) => c.state !== "COMPLETE")?.key ?? "who";
  const current = open ?? firstOpen;

  const openChapter = (key: ChapterKey) => {
    setOpen(key);
    requestAnimationFrame(() => chapterRefs.current[key]?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <div className={`${warmStyles.surface} ${s.page}`} dir="rtl">
      <div className={s.topBar}>
        <BackButton />
      </div>
      <header className={s.heading}>
        <h1 className={s.title}>הנוכחות הדיגיטלית של העסק</h1>
        <p className={s.subtitle}>המידע ש-Dubiz לומד על העסק שלך — ממנו ייבנה בהמשך דף הנחיתה של העסק.</p>
      </header>

      {error ? (
        <div className={s.errorBanner} role="alert">
          {error}
          <button type="button" className={s.linkButton} onClick={clearError}>
            סגירה
          </button>
        </div>
      ) : null}

      {load.state === "loading" ? <p className={s.loading} role="status">טוען את מה ש-Dubiz יודע על העסק…</p> : null}
      {load.state === "error" ? <p className={s.errorBanner} role="alert">לא הצלחנו לטעון את המידע. נסו לרענן.</p> : null}

      {load.state === "ready" && knowledge ? (
        <div className={s.layout}>
          {/* ── orientation: the destination, and how far the knowledge has come ── */}
          <section className={`${s.orient} ${s.area_orient}`} aria-labelledby="identity-orient">
            <p className={s.orientEyebrow}>דף הנחיתה העתידי שלך</p>
            <h2 id="identity-orient" className={s.orientTitle}>
              Dubiz לומד את העסק שלך כדי לבנות לו דף נחיתה מותאם
            </h2>
            <p className={s.orientText}>
              הידע מגיע משני מקורות: מה שאתה מספר ומאשר, ומה ש-Dubiz רואה בפעילות האמיתית בעסק. ככל שהידע מלא ומאומת יותר, כך הדף שיוכן יתאים יותר. שום דבר לא מוצג ללקוחות בלי אישורך.
            </p>
            <div className={s.readiness}>
              <p className={s.readinessTitle}>
                היכרות עם העסק · <strong>{knowledge.completeChapters} מתוך {knowledge.totalChapters}</strong> פרקים הושלמו
              </p>
              <ol className={s.readinessSteps}>
                {knowledge.chapters.map((c) => (
                  <li key={c.key}>
                    <button type="button" className={s.readinessStep} data-state={c.state} onClick={() => openChapter(c.key)}>
                      <span className={s.stepDot} aria-hidden="true" />
                      <span className={s.stepTitle}>{CHAPTER_COPY[c.key].title}</span>
                      <span className={s.stepState}>{CHAPTER_STATE_LABELS[c.state]}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          {/* ── the four chapters ── */}
          <div className={`${s.chapters} ${s.area_chapters}`}>
            {knowledge.chapters.map((c, index) => {
              const copy = CHAPTER_COPY[c.key];
              const Body = CHAPTER_BODY[c.key];
              const isOpen = current === c.key;
              const next = knowledge.chapters[index + 1];
              return (
                <section
                  key={c.key}
                  ref={(el) => {
                    chapterRefs.current[c.key] = el;
                  }}
                  className={isOpen ? s.chapterOpen : s.chapter}
                  aria-labelledby={`chapter-${c.key}`}
                >
                  <button
                    type="button"
                    className={s.chapterHead}
                    aria-expanded={isOpen}
                    aria-controls={`chapter-body-${c.key}`}
                    onClick={() => setOpen(isOpen ? null : c.key)}
                  >
                    <WarmTile tone={copy.tone} icon={copy.icon} />
                    <span className={s.chapterHeadText}>
                      <span className={s.chapterStep}>פרק {index + 1} מתוך {knowledge.totalChapters}</span>
                      <span id={`chapter-${c.key}`} className={s.chapterTitle}>
                        {copy.title}
                      </span>
                      <span className={s.chapterPurpose}>{copy.purpose}</span>
                      {c.needs.length ? <span className={s.chapterNeeds}>חסר: {c.needs.map((n) => NEED_LABELS[n] ?? n).join(" · ")}</span> : null}
                    </span>
                    <WarmPill tone={STATE_TONE[c.state]}>{CHAPTER_STATE_LABELS[c.state]}</WarmPill>
                    <ChevronGlyph className={isOpen ? s.chevronOpen : s.chevron} />
                  </button>
                  {isOpen ? (
                    <div id={`chapter-body-${c.key}`} className={s.chapterBody}>
                      <Body ctx={load.ctx} actions={actions} busy={busy} />
                      {next ? (
                        <button type="button" className={s.nextButton} onClick={() => openChapter(next.key)}>
                          לפרק הבא: {CHAPTER_COPY[next.key].title}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>

          {/* ── companion ── */}
          <div className={s.aside}>
            <UnderstandingCard ctx={load.ctx} />
            <PreviewCard ctx={load.ctx} knowledge={knowledge} />
            <LearnedCard knowledge={knowledge} actions={actions} busy={busy} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
