"use client";

/**
 * The companion panels: how Dubiz understands the business today (owner-provided), what Dubiz
 * learned from activity (machine proposals, owner-adoptable), and the future landing page
 * preview (approved public material only).
 */
import Link from "next/link";

import { businessCategoryLabel } from "@/lib/business/business-categories";
import type { BusinessIdentityContext } from "@/lib/services/identity/business-identity-context";
import type { LandingKnowledge } from "@/lib/services/identity/landing-knowledge";
import { WarmPill, WarmTile } from "@/components/ui/warm-surface/warm-surface";

import { CHANNEL_LABELS, CODE_LABELS, PREVIEW_ROLE_LABELS, describeSignal } from "../identity-labels";
import type { IdentityActions } from "./identity-api";
import s from "./identity-screen.module.css";

type Ctx = BusinessIdentityContext;

const codes = (ctx: Ctx, dimension: string) =>
  ctx.identity.statements.filter((st) => st.dimension === dimension && st.code).map((st) => CODE_LABELS[st.code!] ?? st.code!);

/* ── what you told us ── */
export function UnderstandingCard({ ctx }: { ctx: Ctx }) {
  const profile = (k: string) => ctx.identity.profile.find((p) => p.key === k)?.value ?? null;
  const description = ctx.identity.statements.find((st) => st.dimension === "DESCRIPTION")?.text ?? null;
  const rows: Array<[string, string]> = [];
  const category = businessCategoryLabel(profile("category"), profile("subCategory"));
  if (category) rows.push(["תחום", category]);
  if (description) rows.push(["במשפט אחד", description]);
  const audience = codes(ctx, "TARGET_AUDIENCE");
  if (audience.length) rows.push(["קהל יעד", audience.join(" · ")]);
  const positioning = codes(ctx, "POSITIONING");
  if (positioning.length) rows.push(["רוצים שיזכרו", positioning.join(" · ")]);
  const tone = codes(ctx, "TONE");
  if (tone.length) rows.push(["טון", tone.join(" · ")]);
  const primary = codes(ctx, "PRIMARY_OBJECTIVE");
  if (primary.length) rows.push(["הפעולה העיקרית", primary.join(" · ")]);

  return (
    <section className={`${s.card} ${s.area_summary}`} aria-labelledby="identity-told">
      <div className={s.cardHead}>
        <WarmTile tone="teal" icon="🗣️" />
        <div>
          <h2 id="identity-told" className={s.cardTitle}>
            מה שסיפרת לנו
          </h2>
          <p className={s.cardSub}>כך Dubiz מבין את העסק כרגע — לפי מה שאתה מסרת ואישרת.</p>
        </div>
      </div>
      {rows.length ? (
        <dl className={s.understanding}>
          {rows.map(([k, v]) => (
            <div key={k} className={s.understandingRow}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={s.emptyLine}>עדיין לא סיפרת ל-Dubiz על העסק. כל פרק שתמלא יופיע כאן.</p>
      )}
    </section>
  );
}

/* ── what Dubiz learned ── */
const DIMENSION_SHORT: Record<string, string> = {
  TARGET_AUDIENCE: "קהל יעד",
  TONE: "טון",
  POSITIONING: "במה יזכרו אתכם",
  SECONDARY_OBJECTIVE: "פעולה נוספת",
  PRIMARY_OBJECTIVE: "פעולה עיקרית",
};

export function LearnedCard({ knowledge, actions, busy }: { knowledge: LandingKnowledge; actions: IdentityActions; busy: boolean }) {
  const { suggestions, observations } = knowledge.learned;
  return (
    <section className={`${s.card} ${s.learnedCard} ${s.area_learned}`} aria-labelledby="identity-learned">
      <div className={s.cardHead}>
        <WarmTile tone="violet" icon="💡" />
        <div>
          <h2 id="identity-learned" className={s.cardTitle}>
            מה ש-Dubiz למד
          </h2>
          <p className={s.cardSub}>מתוך הפעילות האמיתית בעסק. שום דבר לא נכנס לידע של העסק בלי שתאשר.</p>
        </div>
      </div>

      {suggestions.length ? (
        <ul className={s.learnedList}>
          {suggestions.map((g) => (
            <li key={`${g.signalKey}>${g.dimension}:${g.code}`} className={s.learnedItem}>
              <p className={s.learnedText}>{describeSignal(g.kind, g.value)}</p>
              <p className={s.learnedProposal}>
                לכן אולי: <strong>{DIMENSION_SHORT[g.dimension] ?? g.dimension} — {CODE_LABELS[g.code] ?? g.code}</strong>
              </p>
              <button type="button" className={s.secondaryButton} disabled={busy} onClick={() => actions.adoptSuggestion(g.signalKey, g.dimension, g.code)}>
                אשר והוסף
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {observations.length ? (
        <div className={s.observations}>
          <p className={s.observationsTitle}>עוד דברים ש-Dubiz רואה · מידע פנימי בלבד</p>
          <ul>
            {observations.map((o) => (
              <li key={o.signalKey}>{describeSignal(o.kind, o.value)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {suggestions.length === 0 && observations.length === 0 ? (
        <p className={s.emptyLine}>
          עדיין אין מספיק פעילות כדי ללמוד משהו בביטחון. ככל שיצטברו שירותים, תורים ותוכן ב-Dubiz, יופיעו כאן תובנות לאישורך.
        </p>
      ) : (
        <p className={s.fieldHint}>אם משהו לא מדויק — פשוט אל תאשר אותו. Dubiz לא ישתמש בו בשם העסק.</p>
      )}
    </section>
  );
}

/* ── the future landing page ── */
export function PreviewCard({ ctx, knowledge }: { ctx: Ctx; knowledge: LandingKnowledge }) {
  const sections = Object.fromEntries(knowledge.preview.sections.map((sec) => [sec.role, sec]));
  const hero = sections.HERO;
  const name = hero.items.find((i) => i.key === "BUSINESS_NAME")?.text ?? null;
  const description = hero.items.find((i) => i.key === "DESCRIPTION")?.text ?? null;
  const cta = sections.CALL_TO_ACTION;
  const effective = ctx.publicUse.conversion.effectivePrimary;

  const body = (role: "ABOUT" | "DIFFERENTIATORS" | "TRUST" | "CONTACT") => {
    const sec = sections[role];
    return (
      <div className={s.previewSection} key={role}>
        <p className={s.previewSectionTitle}>{PREVIEW_ROLE_LABELS[role].title}</p>
        {sec.items.length ? (
          <ul className={s.previewItems}>
            {sec.items.map((i, n) => (
              <li key={`${i.key}-${n}`} dir="auto">
                {i.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.previewEmpty}>{PREVIEW_ROLE_LABELS[role].empty}</p>
        )}
        {sec.awaitingApproval ? <p className={s.previewAwaiting}>{sec.awaitingApproval} פריטים ממתינים לאישור שלך</p> : null}
      </div>
    );
  };

  return (
    <section className={`${s.card} ${s.area_preview}`} aria-labelledby="identity-preview">
      <div className={s.cardHead}>
        <WarmTile tone="blue" icon="🖥️" />
        <div>
          <h2 id="identity-preview" className={s.cardTitle}>
            הצצה לדף הנחיתה העתידי
          </h2>
          <p className={s.cardSub}>מה שהידע הנוכחי מאפשר. רק פריטים שאישרת להציג.</p>
          <WarmPill tone="neutral" className={s.draftPill}>
            טיוטה · לא פורסם
          </WarmPill>
        </div>
      </div>

      <div className={s.previewFrame} aria-label="תצוגה מקדימה, לא פורסמה">
        <div className={s.previewHero}>
          {name ? <p className={s.previewName}>{name}</p> : <span className={s.previewBar} aria-hidden="true" />}
          {description ? <p className={s.previewDescription}>{description}</p> : <span className={`${s.previewBar} ${s.previewBarShort}`} aria-hidden="true" />}
          {!name || !description ? <p className={s.previewEmpty}>{PREVIEW_ROLE_LABELS.HERO.empty}</p> : null}
          {cta.status === "READY" && typeof effective === "object" ? (
            <span className={s.previewCta}>
              {CODE_LABELS[effective.objective] ?? effective.objective}
              {effective.channel ? ` · ${CHANNEL_LABELS[effective.channel] ?? effective.channel}` : ""}
            </span>
          ) : (
            <span className={s.previewCtaEmpty}>{PREVIEW_ROLE_LABELS.CALL_TO_ACTION.empty}</span>
          )}
        </div>
        {(["ABOUT", "DIFFERENTIATORS", "TRUST", "CONTACT"] as const).map(body)}
      </div>
      <p className={s.fieldHint}>Dubiz עוד לא בונה או מפרסם דפי נחיתה. זו הכנה: ככל שהידע יתמלא, Dubiz יוכל להציע כמה גרסאות שונות של הדף.</p>
      <Link href="/business/landing-strategy" className={s.inlineLink}>
        לאילו כיווני דף נחיתה זה מוביל ←
      </Link>
      <Link href="/business/landing" className={s.inlineLink}>
        הגרסאות ששמרת ←
      </Link>
    </section>
  );
}
