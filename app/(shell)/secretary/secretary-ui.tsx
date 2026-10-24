import { Component, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { TaskForm } from "@/features/tasks/task-form";
import { useFeatureEnabled } from "@/lib/ui/use-feature-enabled";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TOKEN } from "@/lib/design/tokens";
import BackButton, { useGoBack } from "@/components/ui/back-button";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag } from "@/lib/i18n/config";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
import type {
  CreateObligationInput,
  ObligationApi,
  RecurrenceCadence,
  UpdateObligationInput,
} from "@/lib/obligations/secretary-client";
import { formatObligationTotals, obligationTotalsByCurrency } from "./obligation-totals";
import { findCategoryObligation, INSURANCE, NATIONAL_INSURANCE } from "./secretary-bank-categories";
import styles from "./secretary.module.css";

export type TodayState = "critical" | "busy" | "calm";
export type SecretaryHomeState = "due" | "calm" | "new";

export type SecretaryLoopMode = "met" | "snooze" | "release" | "created";

export type SecretaryScreenName =
  | "bank"
  | "all"
  | "detail"
  | "update"
  | "capture"
  | "loops"
  | "remind"
  | "watching"
  | "notify";

type CaptureKind = "regular" | "installments" | "postdated-check" | "net-terms";

type CaptureKindOption = {
  key: CaptureKind;
  title: MessageKey;
  description: MessageKey;
  icon: string;
  supported: boolean;
};

const RECURRENCE_KEY: Record<RecurrenceCadence, MessageKey> = {
  NONE: "tasks.secretary.recurrence.none",
  WEEKLY: "tasks.secretary.recurrence.weekly",
  MONTHLY: "tasks.secretary.recurrence.monthly",
  BIMONTHLY: "tasks.secretary.recurrence.bimonthly",
  QUARTERLY: "tasks.secretary.recurrence.quarterly",
  SEMIANNUAL: "tasks.secretary.recurrence.semiannual",
  YEARLY: "tasks.secretary.recurrence.yearly",
};

const RECURRENCE_OPTIONS: Array<{ value: RecurrenceCadence; label: MessageKey }> = (
  ["NONE", "WEEKLY", "MONTHLY", "BIMONTHLY", "QUARTERLY", "SEMIANNUAL", "YEARLY"] as const
).map((value) => ({ value, label: RECURRENCE_KEY[value] }));

const CAPTURE_KINDS: CaptureKindOption[] = [
  {
    key: "regular",
    title: "tasks.secretary.captureKinds.regular.title",
    description: "tasks.secretary.captureKinds.regular.description",
    icon: "💳",
    supported: true,
  },
  {
    key: "installments",
    title: "tasks.secretary.captureKinds.installments.title",
    description: "tasks.secretary.captureKinds.installments.description",
    icon: "🗓️",
    supported: true,
  },
  {
    key: "postdated-check",
    title: "tasks.secretary.captureKinds.postdatedCheck.title",
    description: "tasks.secretary.captureKinds.postdatedCheck.description",
    icon: "📝",
    supported: true,
  },
  {
    key: "net-terms",
    title: "tasks.secretary.captureKinds.netTerms.title",
    description: "tasks.secretary.captureKinds.netTerms.description",
    icon: "⏳",
    supported: true,
  },
];

/**
 * Creation-flow copy that says what Dubiz actually does today (owner decision
 * 23.10.2026, P3 restore). No reminder is sent: an open item waits in "במעקב
 * שקט" and rises to the top of the Secretary seven days before its due date. A
 * payment plan is saved as separate one-off payments and a post-dated cheque as
 * a one-off payment with its number in the note; neither is a payment plan or a
 * cheque-register entry. Hebrew only for now (English is a later task).
 */
const P3_COPY = {
  checkDescription: "מספר צ'ק ותאריך פירעון",
  checkSay: "אפשר למסור לי את פרטי הצ'ק, ואזכור את יום הפירעון.",
  checkNote: "הצ'ק נשמר כתשלום חד־פעמי ביום הפירעון, ומספר הצ'ק נכתב בהערה. הוא לא נרשם בפנקס הצ'קים.",
  checkSaved: "הצ'ק נשמר כתשלום חד־פעמי עם מספר הצ'ק בהערה, ולא בפנקס הצ'קים.",
  installmentsNote: (count: number) => `הפריסה נשמרת כ־${count} תשלומים נפרדים, אחד בכל חודש. כל אחד מופיע בהתחייבויות בנפרד, ולא כתוכנית תשלומים אחת.`,
  installmentsSaved: (count: number) => `הפריסה נשמרה כ־${count} תשלומים נפרדים. זה הראשון שבהם.`,
  netComputed: (days: string, date: string) => `חישבתי: שוטף+${days} יוצא לתשלום ב־${date}.`,
  createdBody: (name: string, date: string) => `שמרתי את ${name} לתשלום ב־${date}. עד אז הוא נשמר אצלי במעקב שקט, ושבוע לפני המועד הוא יעלה לראש המזכירה.`,
  createdBodyGeneric: "שמרתי. שבוע לפני המועד זה יעלה לראש המזכירה.",
  echoDue: (date: string) => `לתשלום: ${date}`,
  // The categories screen (owner, 25.10.2026): one clear way for anything outside the categories.
  otherHeading: "משהו שלא ברשימה",
  createButton: "צור התחייבות",
};

export type SecretaryHomeModel = {
  state: SecretaryHomeState;
  title: string;
  subtitle: string;
  todayHref: string;
  allHref: string;
  addHref: string;
  today: {
    label: string;
    badge?: string;
    body: string;
    amount?: string;
  };
  all?: {
    line: string;
    amount: string;
    suffix: string;
  };
  queue?: Array<{ id: number; name: string; amount: string; reason: string }>;
};

export const SECRETARY_HOME_DEMO_MODELS: Record<SecretaryHomeState, SecretaryHomeModel> = {
  due: {
    state: "due",
    title: "יש דבר אחד שכדאי\nלסגור היום.",
    subtitle: "כל השאר שמור אצלי — אזכיר לך בזמן.",
    todayHref: "/secretary?today=1",
    allHref: "/secretary?screen=all",
    addHref: "/secretary?screen=bank",
    today: {
      label: "היום שלי",
      badge: "להיום",
      body: "התחייבות לדוגמה",
      amount: "₪0",
    },
    all: {
      line: "9 במעקב החודש",
      amount: "₪0",
      suffix: "להוצאה",
    },
  },
  calm: {
    state: "calm",
    title: "הכל רגוע.\nאין מה שדורש אותך.",
    subtitle: "אני שומרת 9 התחייבויות ואזכיר לך כשמשהו יתקרב.",
    todayHref: "/secretary?today=1",
    allHref: "/secretary?screen=all",
    addHref: "/secretary?screen=bank",
    today: {
      label: "היום שלי",
      body: "אין תשלום שדורש אותך היום",
    },
    all: {
      line: "9 במעקב החודש",
      amount: "₪0",
      suffix: "להוצאה",
    },
  },
  new: {
    state: "new",
    title: "שלום, אני\nהמזכירה שלך.",
    subtitle: "מסור לי את התשלומים שהעסק צריך להוציא — ואני אזכור אותם בשבילך.",
    todayHref: "/secretary?today=1",
    allHref: "/secretary?screen=all",
    addHref: "/secretary?screen=bank",
    today: {
      label: "בוא נתחיל",
      body: "מסור לי את ההתחייבות הראשונה",
    },
  },
};
type SecretaryVars = CSSProperties & Record<`--sec-${string}`, string>;

export function secretaryVars(): SecretaryVars {
  // Dubiz Design System v1 — warm cream / teal. The secretary CSS module is
  // 100% var-driven, so mapping every --sec-* here re-skins the whole feature
  // onto the DS in one place. Values come from the token system (TOKEN.dsv1);
  // scoped to the secretary so global tokens used elsewhere stay untouched.
  const d = TOKEN.dsv1;
  return {
    "--sec-font": "var(--font-heebo), 'Heebo', 'Assistant', system-ui, sans-serif",
    "--sec-ink": d.ink,
    "--sec-muted": d.muted,
    "--sec-line": d.line,
    "--sec-canvas": d.card,
    "--sec-surface": d.canvas,
    "--sec-surface-2": d.surface2,
    "--sec-action": d.accent,
    "--sec-grad": d.gradient,
    "--sec-brand": d.accent,
    "--sec-brand-shadow": d.shadowGlow,
    "--sec-primary-shadow": d.shadowGlow,
    "--sec-focus-shadow": d.shadowCard,
    "--sec-hi": d.success,
    "--sec-hi-bg": d.successBg,
    "--sec-hi-ink": d.success,
    "--sec-md": d.warning,
    "--sec-md-bg": d.warningBg,
    "--sec-md-ink": d.warningInk,
    "--sec-lo": d.error,
    "--sec-lo-bg": d.errorBg,
    "--sec-lo-ink": d.error,
    "--sec-urgent": d.error,
    "--sec-urgent-bg": d.errorBg,
    "--sec-urgent-ink": d.error,
    "--sec-info-bg": d.infoBg,
    "--sec-info-ink": d.infoInk,
    "--sec-calm": d.info,
    "--sec-calm-bg": d.infoBg,
    "--sec-calm-ink": d.infoInk,
    // DS has no purple — fold the old purple tone onto the DS info (light teal).
    "--sec-purple": d.info,
    "--sec-purple-bg": d.infoBg,
    "--sec-purple-ink": d.infoInk,
    "--sec-neutral-text": d.muted,
    "--sec-soft-icon": d.surface2,
    "--sec-selected-border": d.accent,
    "--sec-dashed-border": d.line,
    "--sec-sheet-dim": d.backdrop,
    "--sec-active-ring": d.ring,
    "--sec-home-wash": d.homeWash,
    "--sec-home-shadow-soft": d.shadowCard,
    "--sec-home-shadow-lift": d.shadowCardHover,
    "--sec-home-go-color": d.accent,
    "--sec-action-primary-bg": d.actionPrimary,
    "--sec-action-primary-hover": d.actionPrimaryHover,
    "--sec-action-primary-active": d.actionPrimaryActive,
    "--sec-selection-bg": d.selectionBg,
    "--sec-selection-text": d.selectionText,
    "--sec-selection-border": d.selectionBorder,
    "--sec-action-primary-color": d.onAccent,
    "--sec-action-primary-border": "0",
    "--sec-action-primary-shadow": d.shadowGlow,
    "--sec-action-glass-bg": d.card,
    "--sec-action-glass-color": d.ink,
    "--sec-action-glass-border": `1px solid ${d.line}`,
    "--sec-action-glass-shadow": "0 1px 2px rgba(52, 60, 50, 0.05)",
    "--sec-radius-button": `${d.radius.button}px`,
    "--sec-font-body": `${TOKEN.font.body}px`,
    "--sec-weight-bold": `${d.weight.semibold}`,
  };
}

export type SecretaryFocus = {
  id?: number;
  tone: "urgent" | "soon" | "calm";
  tag: string;
  name: string;
  amount: string;
  meta: string;
  chip?: string;
  note?: string;
};

export type TodayModel = {
  state: TodayState;
  status: string;
  title: string;
  subtitle: string;
  focus?: SecretaryFocus;
  watching: {
    line: string;
    subline: string;
  };
  showCapture?: boolean;
};

export function SecretaryHomeScreen({ model, children }: { model: SecretaryHomeModel; children?: ReactNode }) {
  const { t } = useI18n();
  const isNew = model.state === "new";
  const isDue = model.state === "due";
  return (
    <main className={styles.homeRoot} style={secretaryVars()}>
      <section className={styles.homeShell} aria-label={t("tasks.secretary.yourSecretary")}>
        <header className={styles.homeHead}>
          <div className={styles.homeAvatar} aria-hidden="true"><PersonIcon /></div>
          <div>
            <div className={styles.homeWho}>{t("tasks.secretary.yourSecretary")}</div>
            <div className={styles.homeHello}>{t("tasks.secretary.hello")}</div>
          </div>
        </header>

        <section className={styles.homeStatus}>
          <h1>{model.title.split("\n").map((part) => <span key={part}>{part}</span>)}</h1>
          <p>{model.subtitle}</p>
        </section>

        {model.queue && model.queue.length > 0 ? (
          <ul className={styles.homeQueue}>
            {model.queue.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>
                <span>{item.reason}</span>
                <b>{item.amount}</b>
              </li>
            ))}
          </ul>
        ) : null}

        <div className={styles.homeCards}>
          {isNew ? (
            <Link href={model.addHref} className={`${styles.homeCard} ${styles.homeSetupCard}`}>
              <div className={styles.homeCardRow}>
                <div className={styles.homeIcon}><PlusIcon /></div>
                <strong>{model.today.label}</strong>
                <span className={styles.homeGo}><ChevronLeftIcon /></span>
              </div>
              <p>{model.today.body}</p>
            </Link>
          ) : (
            <>
              <Link href={model.todayHref} className={`${styles.homeCard} ${isDue ? styles.homeTodayUrgent : styles.homeTodayCalm}`}>
                <div className={styles.homeCardRow}>
                  <div className={styles.homeIcon}><SunIcon /></div>
                  <strong>{model.today.label}</strong>
                  {model.today.badge ? <span className={styles.homeBadge}>{model.today.badge}</span> : <span className={styles.homeGo}><ChevronLeftIcon /></span>}
                </div>
                <p>
                  {model.today.body}
                  {model.today.amount ? <span className={styles.homeNumber}>{model.today.amount}</span> : null}
                </p>
              </Link>

              {model.all ? (
                <Link href={model.allHref} className={`${styles.homeCard} ${styles.homeAllCard}`}>
                  <div className={styles.homeCardRow}>
                    <div className={styles.homeIcon}><CalendarIcon /></div>
                    <strong>{t("tasks.secretary.allObligations")}</strong>
                    <span className={styles.homeGo}><ChevronLeftIcon /></span>
                  </div>
                  <p>
                    {model.all.line}
                    {model.all.amount ? <span className={styles.homeNumber}>{model.all.amount} <small>{model.all.suffix}</small></span> : <span className={styles.homeSubline}>{model.all.suffix}</span>}
                  </p>
                </Link>
              ) : null}
            </>
          )}
        </div>

        {isNew ? (
          <div className={styles.homeSetNote}>
            <div className={styles.homeMiniAvatar} aria-hidden="true"><PersonIcon /></div>
            <p>{t("tasks.secretary.homeSetNote")}</p>
          </div>
        ) : (
          <Link href={model.addHref} className={styles.homeAddRow}>
            <PlusIcon />
            {t("tasks.secretary.addToTracking")}
          </Link>
        )}
        {children}
      </section>
    </main>
  );
}
/**
 * Instant home skeleton shown while the first briefing loads. Mirrors the home
 * shell layout so the transition to real content is seamless and entry feels
 * immediate — no blank screen, no blocking "checking…" page.
 */
export function SecretaryHomeSkeleton() {
  const { t } = useI18n();
  return (
    <main className={styles.homeRoot} style={secretaryVars()}>
      <section className={styles.homeShell} aria-busy="true" aria-label={t("tasks.secretary.loadingAria")}>
        <header className={styles.homeHead}>
          <div className={styles.homeAvatar} aria-hidden="true"><PersonIcon /></div>
          <div>
            <div className={styles.homeWho}>{t("tasks.secretary.yourSecretary")}</div>
            <div className={styles.homeHello}>{t("tasks.secretary.hello")}</div>
          </div>
        </header>
        <section className={styles.homeStatus}>
          <div className={`${styles.skelLine} ${styles.skelTitle}`} />
          <div className={`${styles.skelLine} ${styles.skelTitleShort}`} />
          <div className={`${styles.skelLine} ${styles.skelSub}`} />
        </section>
        <div className={styles.homeCards}>
          <div className={`${styles.homeCard} ${styles.skelCard}`} />
          <div className={`${styles.homeCard} ${styles.skelCard}`} />
        </div>
      </section>
    </main>
  );
}

export function SecretaryScreen({
  children,
  title,
  backHref = "/secretary",
  compact = false,
  backLook = "round",
}: {
  children: ReactNode;
  title?: string;
  backHref?: string;
  compact?: boolean;
  /** "p3": the "‹ חזרה" pill of the creation flow (owner-approved P3, 18.9.2026). Same navigation either way. */
  backLook?: "round" | "p3";
}) {
  return (
    <main className={styles.root} style={secretaryVars()}>
      <div className={`${styles.shell} ${compact ? styles.shellCompact : ""}`}>
        <div className={styles.topbar}>
          {backLook === "p3" ? <P3BackControl fallbackHref={backHref} /> : <BackControl fallbackHref={backHref} />}
          {title ? <div className={styles.topTitle}>{title}</div> : null}
          <div className={styles.topSpacer} />
        </div>
        {children}
      </div>
    </main>
  );
}

/**
 * Back to the screen the user actually came from (verified navigation trail —
 * a detail reached from "today" returns to "today"). Only when there is no
 * verified origin (deep link, new tab) does it open the declared secretary
 * fallback, labelled with its destination.
 */
function BackControl({ fallbackHref }: { fallbackHref: string }) {
  const { t } = useI18n();
  return <BackButton fallback={fallbackHref} fallbackLabel={secretaryFallbackLabel(fallbackHref, t)} />;
}

/**
 * The creation flow's back control as it looked in P3 (`23d528d5`, the then-shared
 * BackButton: a "‹ חזרה" pill). Only the look is P3's: navigation is today's
 * useGoBack, so it still returns to the exact screen the owner came from.
 */
function P3BackControl({ fallbackHref }: { fallbackHref: string }) {
  const goBack = useGoBack(fallbackHref);
  return (
    <button type="button" onClick={goBack} aria-label="חזרה" style={P3_BACK_STYLE}>
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden focusable="false">
        <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
      <span>חזרה</span>
    </button>
  );
}

const P3_BACK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 40,
  padding: "0 14px",
  borderRadius: 14,
  border: "1px solid var(--dz-border)",
  background: "var(--dz-surface)",
  color: "var(--dz-brand)",
  fontFamily: "inherit",
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1,
  whiteSpace: "nowrap",
  cursor: "pointer",
  flexShrink: 0,
  WebkitTapHighlightColor: "transparent",
};

function secretaryFallbackLabel(href: string, t: Translator): string {
  if (href.includes("screen=detail")) return t("tasks.secretary.back.toDetail");
  if (href.includes("screen=all")) return t("tasks.secretary.back.toAll");
  return t("tasks.secretary.back.toSecretary");
}

export function SecretaryAvatar() {
  return (
    <div className={styles.avatar} aria-hidden="true">
      <PersonIcon />
    </div>
  );
}

export function SecretaryHeader({ status, tone }: { status: string; tone: TodayState | "done" }) {
  const { t } = useI18n();
  const dotClass =
    tone === "critical"
      ? styles.dotUrgent
      : tone === "busy"
        ? styles.dotSoon
        : tone === "done"
          ? styles.dotDone
          : styles.dotCalm;

  return (
    <header className={styles.secretaryHead}>
      <SecretaryAvatar />
      <div>
        <div className={styles.who}>{t("tasks.secretary.yourSecretary")}</div>
        <div className={styles.status}>
          <span className={`${styles.dot} ${dotClass}`} />
          {status}
        </div>
      </div>
    </header>
  );
}

export function HeroText({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <section className={styles.hero}>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </section>
  );
}

export function SecretarySoftFallback({
  title,
  message,
  variant = "check",
}: {
  title?: string;
  message?: string;
  /** "render": the error boundary's wording (a render failure) instead of the check-failed wording. */
  variant?: "check" | "render";
}) {
  const { t } = useI18n();
  const render = variant === "render";
  return (
    <SecretaryScreen>
      <SecretaryHeader status={t("tasks.secretary.fallback.status")} tone="calm" />
      <section className={styles.fallbackPanel}>
        <div className={styles.fallbackIcon} aria-hidden="true">!</div>
        <h1>{title ?? t(render ? "tasks.secretary.fallback.renderTitle" : "tasks.secretary.fallback.title")}</h1>
        <p>{message ?? t(render ? "tasks.secretary.fallback.renderMessage" : "tasks.secretary.fallback.message")}</p>
      </section>
      <WatchingPill
        line={t("tasks.secretary.fallback.watchLine")}
        subline={t("tasks.secretary.fallback.watchSubline")}
      />
    </SecretaryScreen>
  );
}

type SecretaryBoundaryState = { failed: boolean };

export class SecretaryErrorBoundary extends Component<{ children: ReactNode }, SecretaryBoundaryState> {
  state: SecretaryBoundaryState = { failed: false };

  static getDerivedStateFromError(): SecretaryBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error("Secretary render error", error, info);
  }

  render() {
    if (this.state.failed) {
      return <SecretarySoftFallback variant="render" />;
    }
    return this.props.children;
  }
}

export function FocusCard({ focus, href }: { focus: SecretaryFocus; href?: string }) {
  const focusTone =
    focus.tone === "urgent" ? styles.focusUrgent : focus.tone === "soon" ? styles.focusSoon : styles.focusCalm;
  const tagTone =
    focus.tone === "urgent" ? styles.tagUrgent : focus.tone === "soon" ? styles.tagSoon : styles.tagCalm;
  const body = (
    <>
      <div className={styles.focusTop}>
        <span className={styles.focusTile} aria-hidden="true"><CalendarIcon /></span>
        <span className={`${styles.tag} ${tagTone}`}>{focus.tag}</span>
        {href ? <span className={styles.focusGo} aria-hidden="true"><ChevronLeftIcon /></span> : null}
      </div>
      <div className={styles.focusName}>{focus.name}</div>
      <div className={styles.focusAmount}>{focus.amount}</div>
      <div className={styles.focusMeta}>
        {focus.meta}
        {focus.chip ? <span className={styles.chip}>{focus.chip}</span> : null}
      </div>
      {focus.note ? <div className={styles.focusNote}>{focus.note}</div> : null}
    </>
  );
  if (href) {
    return <Link href={href} className={`${styles.focus} ${focusTone}`}>{body}</Link>;
  }
  return <section className={`${styles.focus} ${focusTone}`}>{body}</section>;
}

export function FocusActions({
  onComplete,
  onSnooze,
  onRelease,
}: {
  onComplete?: () => void | Promise<void>;
  onSnooze?: () => void;
  onRelease?: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.actions}>
      <button
        className={`${styles.button} ${styles.primary}`}
        type="button"
        disabled={busy}
        onClick={async () => {
          if (!onComplete || busy) return;
          setBusy(true);
          try {
            await onComplete();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t("tasks.secretary.moment") : t("tasks.secretary.markHandled")}
      </button>
      <div className={styles.ghosts}>
        <button className={`${styles.button} ${styles.ghost}`} type="button" onClick={onSnooze}>
          {t("tasks.secretary.remindLater")}
        </button>
      </div>
      <ReleaseControl onRelease={onRelease} />
    </div>
  );
}

export function WatchingPill({ line, subline, href }: { line: string; subline: string; href?: string }) {
  const body = (
    <>
      <EyeIcon />
      <span className={styles.watchText}>
        {line}
        <span>{subline}</span>
      </span>
    </>
  );
  if (href) {
    return <Link className={styles.watching} href={href}>{body}</Link>;
  }
  return <div className={styles.watching}>{body}</div>;
}

export function CalmCenter({
  title,
  subtitle,
  watching,
  showCapture = true,
}: {
  title: string;
  subtitle: string;
  watching: TodayModel["watching"];
  showCapture?: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      <section className={styles.calmCenter}>
        <div className={styles.calmBadge} aria-hidden="true"><CheckIcon /></div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </section>
      <WatchingPill line={watching.line} subline={watching.subline} href={screenHref("watching")} />
      {showCapture ? (
        <Link className={styles.capture} href={screenHref("capture")}>
          <PlusIcon />
          {t("tasks.secretary.anotherPayment")}
        </Link>
      ) : null}
    </>
  );
}

export function TodayScreen({
  model,
  onComplete,
  onSnooze,
  onRelease,
}: {
  model: TodayModel;
  onComplete?: () => void | Promise<void>;
  onSnooze?: () => void;
  onRelease?: () => void | Promise<void>;
}) {
  return (
    <SecretaryScreen>
      <SecretaryHeader status={model.status} tone={model.state} />
      {model.state === "calm" ? (
        <CalmCenter
          title={model.title}
          subtitle={model.subtitle}
          watching={model.watching}
          showCapture={model.showCapture !== false}
        />
      ) : (
        <>
          <HeroText title={model.title} subtitle={model.subtitle} />
          {model.focus ? <FocusCard focus={model.focus} href={screenHref("detail", model.focus.id)} /> : null}
          <FocusActions onComplete={onComplete} onSnooze={onSnooze} onRelease={onRelease} />
          <WatchingPill line={model.watching.line} subline={model.watching.subline} href={screenHref("watching")} />
        </>
      )}
    </SecretaryScreen>
  );
}

type ObligationCard = {
  id: number;
  emoji: string;
  title: string;
  amount: string;
  meta: string;
  tone?: "urgent" | "soon" | "calm" | "neutral";
};

type FlowAction = (id: number) => Promise<void> | void;

/**
 * The interface language for the secretary's formatters: `t` for words, `tag` for Intl ("he-IL" in Hebrew —
 * exactly the legacy output). Money stays in the obligation's own currency; nothing is converted.
 */
type Fmt = { t: Translator; tag: string };

function useFmt(): Fmt {
  const { t, locale } = useI18n();
  return { t, tag: intlTag(locale) };
}

function formatMoneyValue(amount: string, currency: string, f: Fmt): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  try {
    return new Intl.NumberFormat(f.tag, {
      style: "currency",
      currency: currency || "ILS",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return n.toLocaleString(f.tag) + " ₪";
  }
}

function formatDateValue(iso: string, f: Fmt): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return f.t("tasks.secretary.dateUnavailable");
  return date.toLocaleDateString(f.tag, { day: "numeric", month: "long" });
}

function recurrenceText(value: RecurrenceCadence, t: Translator): string {
  return t(RECURRENCE_KEY[value] ?? RECURRENCE_KEY.NONE);
}

function obligationTone(item: ObligationApi): ObligationCard["tone"] {
  const due = new Date(item.dueAt).getTime();
  if (!Number.isFinite(due)) return "neutral";
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.round((due - start) / 86400000);
  if (days <= 0) return "urgent";
  if (days <= 7) return "soon";
  return "calm";
}

function obligationStripeTone(item: ObligationApi): "late" | "soon" | "none" {
  const days = dueDaysFromNow(item);
  if (days == null || item.state !== "OPEN") return "none";
  if (days < 0) return "late";
  if (days <= 7) return "soon";
  return "none";
}

function calendarDotTone(items: ObligationApi[]): "late" | "soon" | "calm" | null {
  if (items.length === 0) return null;
  if (items.some((item) => obligationStripeTone(item) === "late")) return "late";
  if (items.some((item) => obligationStripeTone(item) === "soon")) return "soon";
  return "calm";
}
function obligationMeta(item: ObligationApi, f: Fmt): string {
  const base = formatDateValue(item.dueAt, f);
  const recurrence = recurrenceText(item.recurrence, f.t);
  return item.recurrence === "NONE" ? base : base + " · " + recurrence;
}

function amountNumber(item: ObligationApi): number {
  const value = Number(item.amount);
  return Number.isFinite(value) ? value : 0;
}

/** Per currency, never added across (B4): an all-ILS list renders exactly as before. */
function sumMoney(items: ObligationApi[], f: Fmt): string {
  return formatObligationTotals(obligationTotalsByCurrency(items), (amount, currency) =>
    formatMoneyValue(amount, currency, f)
  );
}

function dateValue(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthLabel(f: Fmt, date = new Date()): string {
  return date.toLocaleDateString(f.tag, { month: "long" });
}

function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function sameDay(a: Date, b: Date): boolean {
  return sameMonth(a, b) && a.getDate() === b.getDate();
}

function currentMonthItems(items: ObligationApi[], now = new Date()): ObligationApi[] {
  return items.filter((item) => {
    const due = dateValue(item.dueAt);
    const met = item.metAt ? dateValue(item.metAt) : null;
    return Boolean((due && sameMonth(due, now)) || (met && sameMonth(met, now)));
  });
}

function dueDaysFromNow(item: ObligationApi): number | null {
  const due = dateValue(item.dueAt);
  if (!due) return null;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const end = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  return Math.round((end - start) / 86400000);
}

function shortDueLabel(item: ObligationApi, f: Fmt): string {
  const days = dueDaysFromNow(item);
  if (days === null) return formatDateValue(item.dueAt, f);
  if (days < 0) return f.t("tasks.secretary.due.overdue");
  if (days === 0) return f.t("tasks.secretary.due.today");
  if (days === 1) return f.t("tasks.secretary.due.tomorrow");
  if (days === 2) return f.t("tasks.secretary.due.inTwoDays");
  if (days <= 7) return f.t("tasks.secretary.due.inDays", { count: days });
  return formatDateValue(item.dueAt, f);
}

function isInstallmentObligation(item: ObligationApi): boolean {
  const marker = `${item.source ?? ""} ${item.note ?? ""}`.toLowerCase();
  return marker.includes("installment") || marker.includes("פריסה") || marker.includes("תשלומים");
}

function addMonths(date: Date, count: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + count);
  return next;
}

function addDays(date: Date, count: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + count);
  return next;
}

/** Same calendar day, pinned to 09:00 local (the secretary's reminder hour). */
function atMorning(date: Date): Date {
  const next = new Date(date);
  next.setHours(9, 0, 0, 0);
  return next;
}

/** Local yyyy-mm-dd for a native <input type="date"> value / min. */
function toInputDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function emojiForObligation(item: ObligationApi): string {
  const text = (item.obligeeName + " " + (item.note ?? "")).toLowerCase();
  if (text.includes("שכירות") || text.includes("שכר דירה") || text.includes("משכיר")) return "🏠";
  if (text.includes("ספק") || text.includes("אריז") || text.includes("קופס") || text.includes("קרטון")) return "📦";
  if (text.includes("ריהוט") || text.includes("עץ") || text.includes("עיצוב")) return "🛋️";
  if (text.includes("ארנונה")) return "🏛️";
  if (text.includes("חשמל")) return "⚡";
  if (text.includes("מים") || text.includes("גיחון")) return "💧";
  if (text.includes("אינטרנט")) return "🌐";
  if (text.includes("טלפון")) return "☎️";
  if (text.includes("ביטוח לאומי")) return "👥";
  if (text.includes("ביטוח")) return "🛡️";
  if (text.includes("רואה חשבון")) return "📊";
  if (text.includes('מע"מ') || text.includes("מעמ")) return "🧾";
  if (text.includes("צ'ק") || text.includes("צק")) return "📝";
  return "💼";
}

function cardFromObligation(item: ObligationApi, f: Fmt): ObligationCard {
  return {
    id: item.id,
    emoji: emojiForObligation(item),
    title: displayName(item.obligeeName, f.t),
    amount: formatMoneyValue(item.amount, item.currency, f),
    meta: obligationMeta(item, f),
    tone: obligationTone(item),
  };
}

function openObligations(items: ObligationApi[]) {
  return items.filter((item) => item.state === "OPEN");
}

function screenHref(screen: SecretaryScreenName, id?: number) {
  const suffix = id ? "&id=" + id : "";
  return "/secretary?screen=" + screen + suffix;
}

/** Never render an empty or junk obligee name in the UI. */
function displayName(name: string | null | undefined, t: Translator): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length >= 2 ? trimmed : t("tasks.secretary.unnamed");
}

/** "Payments are recorded in <Payables>" — the note under a commitment (all-obligations inspector, detail). */
function PaymentsNote() {
  const { t } = useI18n();
  return <p className={styles.inspectNote}>{t("tasks.secretary.paymentsNote.before")}<Link href="/payables">{t("tasks.secretary.paymentsNote.link")}</Link>{t("tasks.secretary.paymentsNote.after")}</p>;
}

function SayRow({ children }: { children: ReactNode }) {
  return (
    <div className={styles.sayrow}>
      <SecretaryAvatar />
      <div className={styles.say}>{children}</div>
    </div>
  );
}

const Say = SayRow;

function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link className={`${styles.button} ${styles.primary} ${styles.block}`} href={href}>{children}</Link>;
}

function PrimaryButton({ children, disabled, type = "button", onClick }: { children: ReactNode; disabled?: boolean; type?: "button" | "submit"; onClick?: () => void }) {
  return <button className={`${styles.button} ${styles.primary} ${styles.block}`} type={type} disabled={disabled} onClick={onClick}>{children}</button>;
}

function GhostLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link className={`${styles.button} ${styles.ghostWide}`} href={href}>{children}</Link>;
}

function EmptyMemory({ title, body }: { title: string; body: string }) {
  return (
    <section className={styles.rememberBox}>
      <div className={styles.smallTitle}>{title}</div>
      <p className={styles.emptyText}>{body}</p>
    </section>
  );
}

/** Capture screen, optionally pre-filled with a known/recommended obligee name. */
function captureHref(name?: string): string {
  return name ? screenHref("capture") + "&name=" + encodeURIComponent(name) : screenHref("capture");
}

function BankChip({ emoji, label, obligation }: { emoji: string; label: string; obligation: ObligationApi | null }) {
  const saved = Boolean(obligation);
  // A known category opens its existing obligation; an unknown one opens the
  // form pre-filled with the recommended name — never a blank form.
  const href = obligation ? screenHref("detail", obligation.id) : captureHref(label);
  return (
    <Link className={`${styles.bankChip} ${saved ? styles.bankChipSaved : ""}`} href={href} aria-pressed={saved}>
      <span className={styles.bankChipEmoji}>{emoji}</span>
      <strong>{label}</strong>
      <em>{saved ? "✓" : "+"}</em>
    </Link>
  );
}

function RememberedObligationCard({ item }: { item: ObligationCard }) {
  const { t } = useI18n();
  return (
    <Link className={styles.rememberedCard} href={screenHref("detail", item.id)}>
      <div className={styles.rememberedHead}>{t("tasks.secretary.alreadyRemember")}</div>
      <div className={styles.rememberedBody}>
        <span className={styles.rememberedEmoji}>{item.emoji}</span>
        <strong>{item.title}</strong>
        <b>{item.amount}</b>
        <small>{item.meta}</small>
      </div>
    </Link>
  );
}

type SecretaryFlowScreenProps = {
  screen: SecretaryScreenName;
  obligations: ObligationApi[];
  selectedId?: number | null;
  loopMode?: SecretaryLoopMode | null;
  prefillName?: string;
  obligationsLoading?: boolean;
  obligationsHasMore?: boolean;
  onLoadMore?: () => void;
  onCreate?: (input: CreateObligationInput) => Promise<ObligationApi | void>;
  onCreateMany?: (inputs: CreateObligationInput[]) => Promise<ObligationApi[]>;
  onUpdate?: (id: number, input: UpdateObligationInput) => Promise<void> | void;
  onComplete?: FlowAction;
  onSnooze?: (id: number, followUpAt: string) => Promise<void> | void;
  onRelease?: FlowAction;
};

export function SecretaryFlowScreen({ screen, obligations, selectedId, loopMode, prefillName, obligationsLoading = false, obligationsHasMore = false, onLoadMore, onCreate, onCreateMany, onUpdate, onComplete, onSnooze, onRelease }: SecretaryFlowScreenProps) {
  const openItems = openObligations(obligations);
  const selected = obligations.find((item) => item.id === selectedId) ?? openItems[0] ?? obligations[0] ?? null;
  const loadMore = <LoadMoreObligations loading={obligationsLoading} hasMore={obligationsHasMore} onLoadMore={onLoadMore} />;
  switch (screen) {
    case "bank": return <BankScreen obligations={openItems} loadMore={loadMore} />;
    case "all": return <AllObligationsScreen obligations={obligations} loadMore={loadMore} />;
    case "detail": return <DetailScreen obligation={selected} obligations={obligations} onComplete={onComplete} onRelease={onRelease} />;
    // Key by the resolved id so the edit form re-seeds its fields once the
    // obligation loads (deep-link / refresh), never showing an empty form.
    case "update": return <UpdateScreen key={selected ? selected.id : "none"} obligation={selected} onUpdate={onUpdate} />;
    case "capture": return <CaptureScreen obligations={openItems} onCreate={onCreate} onCreateMany={onCreateMany} prefillName={prefillName} />;
    case "loops": return <LoopsScreen obligation={selected} initialMode={loopMode ?? "met"} />;
    case "remind": return <RemindScreen obligation={selected} onSnooze={onSnooze} />;
    case "watching": return <WatchingScreen obligations={openItems} />;
    case "notify": return <NotifyScreen obligations={openItems} />;
  }
}

function LoadMoreObligations({ loading, hasMore, onLoadMore }: { loading: boolean; hasMore: boolean; onLoadMore?: () => void }) {
  const { t } = useI18n();
  if (!hasMore && !loading) return null;
  return (
    <button type="button" className={`${styles.button} ${styles.ghostWide} ${styles.loadMoreButton}`} onClick={onLoadMore} disabled={loading || !onLoadMore}>
      {loading ? t("tasks.secretary.loadingMore") : t("tasks.secretary.showMore")}
    </button>
  );
}
/**
 * P3's first step, "נגדיר את ההתחייבויות" (owner, 25.10.2026): the categories, then one way to create anything
 * else. No "כבר אני זוכרת" card (the commitments live behind the "התחייבויות" station) and no "סיימתי" button —
 * the back control returns to where the owner came from, and after a save the result offers "הוסף עוד" and
 * "סיימתי". Saving is unchanged.
 */
function BankScreen({ obligations, loadMore }: { obligations: ObligationApi[]; loadMore?: ReactNode }) {
  const f = useFmt();
  const { t } = f;
  // The second argument of findCategoryObligation is a Hebrew keyword matched against stored obligee names — not UI text.
  return (
    <SecretaryScreen title={t("tasks.secretary.bank.title")} backHref="/secretary" backLook="p3">
      <Say>{t("tasks.secretary.bank.say")}</Say>
      <div className={styles.category}>{t("tasks.secretary.bank.monthly")}</div>
      <div className={styles.bankGrid}>
        <BankChip emoji="🏠" label={t("tasks.secretary.bank.rent")} obligation={findCategoryObligation("שכירות", obligations)} />
        <BankChip emoji="🏛️" label={t("tasks.secretary.bank.arnona")} obligation={findCategoryObligation("ארנונה", obligations)} />
        <BankChip emoji="⚡" label={t("tasks.secretary.bank.electricity")} obligation={findCategoryObligation("חשמל", obligations)} />
        <BankChip emoji="💧" label={t("tasks.secretary.bank.water")} obligation={findCategoryObligation("מים", obligations)} />
        <BankChip emoji="🌐" label={t("tasks.secretary.bank.internet")} obligation={findCategoryObligation("אינטרנט", obligations)} />
        <BankChip emoji="☎️" label={t("tasks.secretary.bank.phone")} obligation={findCategoryObligation("טלפון", obligations)} />
      </div>
      <div className={styles.category}>{t("tasks.secretary.bank.services")}</div>
      <div className={styles.bankGrid}>
        <BankChip emoji="🛡️" label={t("tasks.secretary.bank.insurance")} obligation={findCategoryObligation(INSURANCE, obligations)} />
        <BankChip emoji="📊" label={t("tasks.secretary.bank.accountant")} obligation={findCategoryObligation("רואה חשבון", obligations)} />
        <BankChip emoji="🧾" label={t("tasks.secretary.bank.vat")} obligation={findCategoryObligation('מע"מ', obligations)} />
        <BankChip emoji="👥" label={t("tasks.secretary.bank.nationalInsurance")} obligation={findCategoryObligation(NATIONAL_INSURANCE, obligations)} />
      </div>
      <div className={styles.category}>{P3_COPY.otherHeading}</div>
      <Link className={styles.createButton} href={captureHref()}><PlusIcon /> {P3_COPY.createButton}</Link>
      {/* Its own height: in the full-height shell a ghost button otherwise grows to fill the screen. */}
      <Link className={`${styles.button} ${styles.ghostWide} ${styles.ghostFixed}`} href={screenHref("all")}>{t("tasks.secretary.bank.seeAll")}</Link>
      {loadMore}
    </SecretaryScreen>
  );
}

const CALENDAR_WEEKDAYS: readonly MessageKey[] = [
  "tasks.secretary.calendarWeekdays.sun",
  "tasks.secretary.calendarWeekdays.mon",
  "tasks.secretary.calendarWeekdays.tue",
  "tasks.secretary.calendarWeekdays.wed",
  "tasks.secretary.calendarWeekdays.thu",
  "tasks.secretary.calendarWeekdays.fri",
  "tasks.secretary.calendarWeekdays.sat",
];

function CalendarMonth({ obligations }: { obligations: ObligationApi[] }) {
  const { t } = useI18n();
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const cells: Array<{ key: string; day?: number; tone?: "late" | "soon" | "calm" | null; today?: boolean }> = [];
  for (let i = 0; i < first.getDay(); i += 1) cells.push({ key: "empty-" + i });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const current = new Date(now.getFullYear(), now.getMonth(), day);
    const dayItems = obligations.filter((item) => {
      const due = dateValue(item.dueAt);
      return due ? sameDay(due, current) : false;
    });
    const dotTone = calendarDotTone(dayItems);
    cells.push({
      key: "day-" + day,
      day,
      tone: dotTone,
      today: sameDay(current, now),
    });
  }
  return (
    <section className={styles.calendarCard}>
      <div className={styles.calendarWeekdays}>{CALENDAR_WEEKDAYS.map((key) => <span key={key}>{t(key)}</span>)}</div>
      <div className={styles.calendarGrid}>
        {cells.map((cell) => (
          <div key={cell.key} className={`${styles.calendarDay} ${!cell.day ? styles.calendarEmpty : ""} ${cell.today ? styles.calendarToday : ""}`}>
            {cell.day ? <>{cell.day}{cell.tone ? <span className={`${styles.calendarDot} ${cell.tone === "late" ? styles.calendarDotUrgent : cell.tone === "soon" ? styles.calendarDotSoon : styles.calendarDotCalm}`} /> : null}</> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function TimelineGroup({ title, items, empty, selectedId, onSelect }: { title: string; items: ObligationApi[]; empty: string; selectedId?: number | null; onSelect?: (id: number) => void }) {
  return (
    <section className={styles.timelineGroup}>
      <div className={styles.timelineTitle}>{title}</div>
      {items.length > 0 ? items.map((item) => <TimelineItem key={item.id} item={item} selected={item.id === selectedId} onSelect={onSelect} />) : <div className={styles.timelineEmpty}>{empty}</div>}
    </section>
  );
}

function TimelineItem({ item, selected, onSelect }: { item: ObligationApi; selected?: boolean; onSelect?: (id: number) => void }) {
  const router = useRouter();
  const f = useFmt();
  const tone = obligationTone(item);
  const stripeTone = obligationStripeTone(item);
  const done = item.state === "MET";
  return (
    <button
      type="button"
      className={`${styles.timelineItem} ${stripeTone === "late" ? styles.timelineLate : stripeTone === "soon" ? styles.timelineSoon : ""} ${done ? styles.timelineDone : ""} ${selected ? styles.timelineSelected : ""}`}
      aria-pressed={selected || undefined}
      onClick={() => {
        if (typeof window !== "undefined" && window.matchMedia("(min-width: 1200px)").matches && onSelect) {
          onSelect(item.id);
          return;
        }
        router.push(screenHref("detail", item.id));
      }}
    >
      <span className={styles.timelineEmoji}>{emojiForObligation(item)}</span>
      <span className={styles.timelineBody}>
        <strong>{item.obligeeName}</strong>
        <span>{done ? f.t("tasks.secretary.handledOn", { date: formatDateValue(item.metAt ?? item.updatedAt, f) }) : <><StatusPill tone={tone}>{shortDueLabel(item, f)}</StatusPill>{recurrenceText(item.recurrence, f.t)}</>}</span>
      </span>
      <b>{formatMoneyValue(item.amount, item.currency, f)}</b>
    </button>
  );
}

function StatusPill({ tone, children }: { tone: ObligationCard["tone"] | "purple"; children: ReactNode }) {
  const toneClass = tone === "urgent" ? styles.statusPillUrgent : tone === "soon" ? styles.statusPillSoon : tone === "calm" ? styles.statusPillCalm : tone === "purple" ? styles.statusPillPurple : styles.statusPillNeutral;
  return <em className={`${styles.statusPill} ${toneClass}`}>{children}</em>;
}

function AllObligationsScreen({ obligations, loadMore }: { obligations: ObligationApi[]; loadMore?: ReactNode }) {
  const f = useFmt();
  const { t } = f;
  const [pickedId, setPickedId] = useState<number | null>(null);
  const now = new Date();
  // Headline count + total are computed over ALL open obligations so this
  // screen agrees exactly with the home briefing ("N במעקב · total להוצאה").
  const openAll = openObligations(obligations).slice().sort((a, b) => {
    const da = dateValue(a.dueAt)?.getTime() ?? 0;
    const db = dateValue(b.dueAt)?.getTime() ?? 0;
    return da - db;
  });
  const weekEnd = new Date(now);
  weekEnd.setDate(now.getDate() + 7);
  const thisWeek = openAll.filter((item) => {
    const due = dateValue(item.dueAt);
    return due ? due.getTime() <= weekEnd.getTime() : false;
  });
  const later = openAll.filter((item) => !thisWeek.includes(item));
  const monthItems = currentMonthItems(obligations, now);
  const monthOpen = monthItems.filter((item) => item.state === "OPEN");
  const doneThisMonth = monthItems.filter((item) => item.state === "MET");
  const selected = obligations.find((item) => item.id === pickedId) ?? openAll[0] ?? obligations[0] ?? null;
  return (
    <SecretaryScreen title={t("tasks.secretary.allObligations")} backHref="/secretary">
      <section className={styles.monthSummary}>
        <span>{t("tasks.secretary.all.summaryLabel")}</span>
        <strong>{sumMoney(openAll, f)}</strong>
        <div>
          <span><b>{openAll.length}</b><small>{t("tasks.secretary.all.totalCount")}</small></span>
          <span><b>{sumMoney(monthOpen, f)}</b><small>{t("tasks.secretary.all.thisMonth")}</small></span>
          <span><b>{sumMoney(doneThisMonth, f)}</b><small>{t("tasks.secretary.all.handledThisMonth")}</small></span>
        </div>
      </section>
      <div className={styles.oblDesk}>
        <div>
          {obligations.length > 0 ? (
            <>
              <TimelineGroup title={t("tasks.secretary.all.groupWeek", { count: thisWeek.length })} items={thisWeek} empty={t("tasks.secretary.all.emptyWeek")} selectedId={selected?.id} onSelect={setPickedId} />
              <TimelineGroup title={t("tasks.secretary.all.groupLater", { count: later.length })} items={later} empty={t("tasks.secretary.all.emptyLater")} selectedId={selected?.id} onSelect={setPickedId} />
              <TimelineGroup title={t("tasks.secretary.all.groupDone", { count: doneThisMonth.length })} items={doneThisMonth} empty={t("tasks.secretary.all.emptyDone")} selectedId={selected?.id} onSelect={setPickedId} />
            </>
          ) : <EmptyMemory title={t("tasks.secretary.all.emptyTitle")} body={t("tasks.secretary.all.emptyBody")} />}
          <div className={styles.calendarHead}><h3>{t("tasks.secretary.all.calendarTitle", { month: monthLabel(f, now) })}</h3><Link href="/secretary?today=1">{t("tasks.secretary.all.today")}</Link></div>
          <CalendarMonth obligations={monthItems} />
          <div className={styles.calendarLegend} aria-hidden="true">
            <span><i className={styles.calendarDotUrgent} />{t("tasks.secretary.all.legendOverdue")}</span>
            <span><i className={styles.calendarDotSoon} />{t("tasks.secretary.all.legendWeek")}</span>
            <span><i className={styles.calendarDotCalm} />{t("tasks.secretary.all.legendLater")}</span>
            <span><b className={styles.calendarTodayKey} />{t("tasks.secretary.all.today")}</span>
          </div>
          {loadMore}
          <PrimaryLink href={screenHref("capture")}>{t("tasks.secretary.all.handOverMore")}</PrimaryLink>
        </div>
        <aside className={styles.oblInspect} aria-label={t("tasks.secretary.all.selectedAria")}>
          {selected ? (
            <>
              <DetailMemoryCard obligation={selected} />
              {selected.note ? <p className={styles.inspectNote}>{selected.note}</p> : null}
              <HistoryCard obligation={selected} obligations={obligations} />
              <PaymentsNote />
              <PrimaryLink href={screenHref("detail", selected.id)}>{t("tasks.secretary.all.nextAction")}</PrimaryLink>
            </>
          ) : (
            <p className={styles.inspectNote}>{t("tasks.secretary.all.pickRow")}</p>
          )}
        </aside>
      </div>
    </SecretaryScreen>
  );
}

function DetailMemoryCard({ obligation }: { obligation: ObligationApi }) {
  const f = useFmt();
  const { t } = f;
  return (
    <section className={styles.memoryDetailCard} aria-label={t("tasks.secretary.memory.aria")}>
      <div className={styles.memoryDetailRow}><span>{emojiForObligation(obligation)}</span><small>{t("tasks.secretary.memory.who")}</small><strong>{displayName(obligation.obligeeName, t)}</strong></div>
      <div className={styles.memoryDetailRow}><span>💰</span><small>{t("tasks.secretary.memory.howMuch")}</small><strong>{formatMoneyValue(obligation.amount, obligation.currency, f)}</strong></div>
      <div className={styles.memoryDetailRow}><span>📅</span><small>{t("tasks.secretary.memory.when")}</small><strong>{formatDateValue(obligation.dueAt, f)}</strong></div>
      <div className={styles.memoryDetailRow}><span>🔄</span><small>{t("tasks.secretary.memory.recurrence")}</small><strong>{recurrenceText(obligation.recurrence, t)}</strong></div>
    </section>
  );
}

function HistoryCard({ obligation, obligations }: { obligation: ObligationApi; obligations: ObligationApi[] }) {
  const f = useFmt();
  const history = obligations.filter((item) => item.state === "MET" && item.id !== obligation.id && ((item.recurrenceSeriesId && item.recurrenceSeriesId === obligation.recurrenceSeriesId) || item.obligeeName === obligation.obligeeName)).slice(0, 3);
  if (obligation.state === "MET") history.unshift(obligation);
  return (
    <section className={styles.historyCard}>
      <div className={styles.historyTitle}>{f.t("tasks.secretary.history.title")}</div>
      {history.length > 0 ? history.map((item) => <div className={styles.historyRow} key={item.id}><span>✓</span><strong>{f.t("tasks.secretary.handledOn", { date: formatDateValue(item.metAt ?? item.updatedAt, f) })}</strong><b>{formatMoneyValue(item.amount, item.currency, f)}</b></div>) : <p>{f.t("tasks.secretary.history.empty")}</p>}
    </section>
  );
}


/**
 * Remove ("כבר לא רלוונטי") with a light, explicit confirm + an immediate
 * loading state — a destructive action never fires on a single tap and never
 * looks frozen while it runs. Reused by the detail screen and the today focus.
 */
export function ReleaseControl({ onRelease, disabled }: { onRelease?: () => Promise<void> | void; disabled?: boolean }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!onRelease) return null;
  if (confirming) {
    return (
      <div className={styles.confirmBox} role="group" aria-label={t("tasks.secretary.release.aria")}>
        <p className={styles.confirmText}>{t("tasks.secretary.release.question")}</p>
        <div className={styles.confirmActions}>
          <button
            type="button"
            className={`${styles.button} ${styles.primary} ${styles.block}`}
            disabled={busy}
            onClick={async () => {
              if (busy) return;
              setBusy(true);
              try {
                await onRelease();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? t("tasks.secretary.moment") : t("tasks.secretary.release.yes")}
          </button>
          <button type="button" className={`${styles.button} ${styles.ghostWide}`} disabled={busy} onClick={() => setConfirming(false)}>
            {t("tasks.secretary.release.no")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" className={`${styles.button} ${styles.ghostWide}`} disabled={disabled} onClick={() => setConfirming(true)}>
      {t("tasks.secretary.release.notRelevant")}
    </button>
  );
}

function DetailScreen({ obligation, obligations, onComplete, onRelease }: { obligation: ObligationApi | null; obligations: ObligationApi[]; onComplete?: FlowAction; onRelease?: FlowAction }) {
  const f = useFmt();
  const { t } = f;
  const [busy, setBusy] = useState(false);
  async function run(action?: FlowAction) { if (!obligation || !action || busy) return; setBusy(true); try { await action(obligation.id); } finally { setBusy(false); } }
  if (!obligation) return <SecretaryScreen title={t("tasks.secretary.detail.title")} backHref={screenHref("all")}><EmptyMemory title={t("tasks.secretary.detail.emptyTitle")} body={t("tasks.secretary.detail.emptyBody")} /><PrimaryLink href={screenHref("capture")}>{t("tasks.secretary.detail.handOverFirst")}</PrimaryLink></SecretaryScreen>;
  const name = displayName(obligation.obligeeName, t);
  const tone = obligation.state === "MET" ? "calm" : isInstallmentObligation(obligation) ? "purple" : obligationTone(obligation);
  const isMet = obligation.state === "MET";
  const isInstallment = isInstallmentObligation(obligation);
  const metaText = isMet
    ? (obligation.recurrence === "NONE" ? t("tasks.secretary.detail.closed") : t("tasks.secretary.detail.nextBy", { recurrence: recurrenceText(obligation.recurrence, t) }))
    : isInstallment
      ? t("tasks.secretary.detail.installmentsTracked")
      : t("tasks.secretary.detail.payOn", { date: formatDateValue(obligation.dueAt, f) });
  return (
    <SecretaryScreen title={name} backHref={screenHref("all")}>
      <div className={styles.detailDesk}>
        <div>
          <section className={[styles.detailObjectHead, isMet ? styles.detailObjectDone : ""].join(" ")}>
            <div className={styles.detailObjectTile}>{emojiForObligation(obligation)}</div>
            <div className={styles.detailObjectInfo}>
              <strong>{name}</strong>
              <b>{formatMoneyValue(obligation.amount, obligation.currency, f)}</b>
            </div>
          </section>
          <div className={styles.detailMetaLine}>
            <StatusPill tone={tone}>{isMet ? t("tasks.secretary.detail.handledThisMonth") : isInstallment ? t("tasks.secretary.detail.installments") : shortDueLabel(obligation, f)}</StatusPill>
            <span>{metaText}</span>
          </div>
          <Say>{isMet ? t("tasks.secretary.detail.sayMet") : isInstallment ? t("tasks.secretary.detail.sayInstallment") : t("tasks.secretary.detail.sayDefault")}</Say>
          <DetailMemoryCard obligation={obligation} />
          {obligation.note ? <p className={styles.inspectNote}>{obligation.note}</p> : null}
        </div>
        <div>
          <HistoryCard obligation={obligation} obligations={obligations} />
          <PaymentsNote />
          <div className={styles.actions}>
            {!isMet ? <PrimaryButton disabled={busy} onClick={() => void run(onComplete)}>{busy ? t("tasks.secretary.moment") : t("tasks.secretary.markHandled")}</PrimaryButton> : null}
            <div className={styles.ghosts}>
              {!isMet ? <GhostLink href={screenHref("remind", obligation.id)}>{t("tasks.secretary.remindLater")}</GhostLink> : null}
              <GhostLink href={screenHref("update", obligation.id)}>{t("tasks.secretary.detail.edit")}</GhostLink>
            </div>
            {!isMet ? <ReleaseControl disabled={busy} onRelease={onRelease ? () => onRelease(obligation.id) : undefined} /> : null}
          </div>
        </div>
      </div>
    </SecretaryScreen>
  );
}

function CaptureScreen({ obligations, onCreate, onCreateMany, prefillName }: { obligations: ObligationApi[]; onCreate?: (input: CreateObligationInput) => Promise<ObligationApi | void>; onCreateMany?: (inputs: CreateObligationInput[]) => Promise<ObligationApi[]>; prefillName?: string }) {
  const f = useFmt();
  const { t } = f;
  const [obligeeName, setObligeeName] = useState(prefillName ?? "");
  const [amount, setAmount] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [recurrence, setRecurrence] = useState<RecurrenceCadence>("NONE");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<CaptureKind>("regular");
  const [installmentCount, setInstallmentCount] = useState("3");
  const [checkNumber, setCheckNumber] = useState("");
  const [termsDays, setTermsDays] = useState<"30" | "60" | "90">("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ObligationApi | null>(null);
  // Daily Tasks: "משימה" joins the capture kinds only while daily_tasks is ON (the same form as /tasks).
  const tasksOn = useFeatureEnabled("daily_tasks");
  const [taskMode, setTaskMode] = useState(false);
  const [taskSaved, setTaskSaved] = useState(false);
  const router = useRouter();
  // "הוסף עוד": a fresh, empty panel. The link it replaces pointed at the screen already open,
  // so nothing changed and the result stayed on screen (on main and in P3 alike).
  function startAnother() {
    setCreated(null);
    setError(null);
    setObligeeName("");
    setAmount("");
    setDueAt("");
    setInvoiceDate("");
    setRecurrence("NONE");
    setNote("");
    setKind("regular");
    setInstallmentCount("3");
    setCheckNumber("");
    setTermsDays("30");
    router.replace(screenHref("capture"));
  }
  // Lock background scroll while the capture sheet is open — only the sheet
  // itself scrolls, so the page behind never moves under the modal.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  const selectedKind = CAPTURE_KINDS.find((item) => item.key === kind) ?? CAPTURE_KINDS[0];
  const installmentCountNumber = normalizeInstallmentCount(installmentCount);
  const scheduleRows = buildInstallmentRows(amount, dueAt, installmentCountNumber, f);
  const netDueDate = invoiceDate ? calculateNetTermsDueDate(invoiceDate, Number(termsDays), f) : null;
  const canSubmit = (() => {
    if (!obligeeName.trim() || !amount.trim()) return false;
    if (kind === "net-terms") return Boolean(invoiceDate.trim());
    if (kind === "postdated-check") return Boolean(dueAt.trim() && checkNumber.trim());
    if (kind === "installments") return Boolean(dueAt.trim() && installmentCountNumber > 1);
    return Boolean(dueAt.trim());
  })();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!canSubmit) {
      setError(requiredMessageForKind(kind, t));
      return;
    }
    const trimmedName = obligeeName.trim();
    const extraNote = note.trim();
    setBusy(true);
    setError(null);
    try {
      if (kind === "installments") {
        const first = new Date(dueAt.trim() + "T09:00:00");
        if (Number.isNaN(first.getTime())) throw new Error("bad-date");
        const total = Number(amount);
        if (!Number.isFinite(total) || total <= 0) throw new Error("bad-amount");
        const each = (total / installmentCountNumber).toFixed(2);
        const inputs: CreateObligationInput[] = Array.from({ length: installmentCountNumber }, (_, index) => ({
          obligeeName: trimmedName,
          amount: each,
          dueAt: addMonths(first, index).toISOString(),
          recurrence: "NONE" as RecurrenceCadence,
          note: `פריסת תשלומים ${index + 1}/${installmentCountNumber}` + (extraNote ? ` · ${extraNote}` : ""),
        }));
        const createdList = await onCreateMany?.(inputs);
        if (createdList && createdList[0]) setCreated(createdList[0]);
        return;
      }

      let dueISO: string;
      let recurrenceForKind: RecurrenceCadence = recurrence;
      let noteForKind: string | null = extraNote || null;

      if (kind === "net-terms") {
        const due = netTermsDueDateValue(invoiceDate.trim(), Number(termsDays));
        if (!due) throw new Error("bad-date");
        dueISO = due.toISOString();
        recurrenceForKind = "NONE";
        noteForKind = `שוטף+${termsDays}` + (extraNote ? ` · ${extraNote}` : "");
      } else if (kind === "postdated-check") {
        const due = new Date(dueAt.trim() + "T09:00:00");
        if (Number.isNaN(due.getTime())) throw new Error("bad-date");
        dueISO = due.toISOString();
        recurrenceForKind = "NONE";
        noteForKind = `צ'ק מס' ${checkNumber.trim()}` + (extraNote ? ` · ${extraNote}` : "");
      } else {
        const due = new Date(dueAt.trim() + "T09:00:00");
        if (Number.isNaN(due.getTime())) throw new Error("bad-date");
        dueISO = due.toISOString();
      }

      const saved = await onCreate?.({ obligeeName: trimmedName, amount, dueAt: dueISO, recurrence: recurrenceForKind, note: noteForKind });
      if (saved) setCreated(saved);
    } catch {
      setError(t("tasks.secretary.capture.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={[styles.root, styles.captureOverlayRoot].join(" ")} style={secretaryVars()}>
      <div className={styles.captureBackdrop} aria-hidden="true">
        <div className={styles.captureBackdropBlur}>
          <div className={styles.shell}>
            <div className={styles.topbar}>
              <div className={styles.topSpacer} />
              <div className={styles.topTitle}>{t("tasks.secretary.bank.title")}</div>
              <div className={styles.topSpacer} />
            </div>
            <Say>{t("tasks.secretary.bank.say")}</Say>
            {obligations[0] ? <RememberedObligationCard item={cardFromObligation(obligations[0], f)} /> : null}
            <div className={styles.category}>{t("tasks.secretary.bank.monthly")}</div>
            <div className={styles.bankGrid}>
              <BankChip emoji="🏠" label={t("tasks.secretary.bank.rent")} obligation={findCategoryObligation("שכירות", obligations)} />
              <BankChip emoji="🏛️" label={t("tasks.secretary.bank.arnona")} obligation={findCategoryObligation("ארנונה", obligations)} />
              <BankChip emoji="⚡" label={t("tasks.secretary.bank.electricity")} obligation={findCategoryObligation("חשמל", obligations)} />
              <BankChip emoji="💧" label={t("tasks.secretary.bank.water")} obligation={findCategoryObligation("מים", obligations)} />
            </div>
          </div>
        </div>
      </div>
      <div className={styles.captureDim} aria-hidden="true" />
      <section className={styles.captureSheet} aria-label={t("tasks.secretary.capture.newAria")}>
        <div className={styles.sheetGrip} />
        <Link href={screenHref("bank")} className={styles.captureClose} aria-label={t("tasks.secretary.capture.closeAria")}>×</Link>
        {taskMode ? (
          taskSaved ? (
            <section style={{ display: "flex", flexDirection: "column", gap: 12, padding: "8px 4px" }}>
              <Say>{t("tasks.secretary.capture.taskSaved")}</Say>
              <div className={styles.loopFoot}>
                <PrimaryLink href="/secretary?today=1">{t("tasks.secretary.capture.toMyDay")}</PrimaryLink>
                <GhostLink href="/tasks">{t("tasks.secretary.capture.allTasks")}</GhostLink>
              </div>
            </section>
          ) : (
            <div style={{ padding: "8px 4px 16px" }}>
              <TaskForm origin="SECRETARY" onDone={() => setTaskSaved(true)} onCancel={() => setTaskMode(false)} />
            </div>
          )
        ) : created ? (
          <LoopResult
            mode="created"
            obligation={created}
            createdNote={kind === "installments" ? P3_COPY.installmentsSaved(installmentCountNumber) : kind === "postdated-check" ? P3_COPY.checkSaved : undefined}
            onAddMore={startAnother}
          />
        ) : <>
        <div className={styles.topbar}>
          <div className={styles.topSpacer} />
          <div className={styles.topTitle}>{t(selectedKind.title)}</div>
          <div className={styles.topSpacer} />
        </div>
        <Say>{captureSayForKind(kind, t)}</Say>
        <div className={styles.captureTypeList} aria-label={t("tasks.secretary.capture.kindAria")}>
          {CAPTURE_KINDS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={[styles.captureTypeCard, item.key === kind ? styles.captureTypeSelected : ""].join(" ")}
              onClick={() => {
                setKind(item.key);
                setError(null);
              }}
              aria-pressed={item.key === kind}
            >
              <span className={styles.captureTypeIcon}>{item.icon}</span>
              <span className={styles.captureTypeBody}>
                <strong>{t(item.title)}</strong>
                <small>{item.key === "postdated-check" ? P3_COPY.checkDescription : t(item.description)}</small>
              </span>
              <i aria-hidden="true" />
            </button>
          ))}
          {/* Daily Tasks: "משימה" stays available, last in the list (owner decision 23.10.2026). */}
          {tasksOn ? (
            <button
              type="button"
              className={styles.captureTypeCard}
              onClick={() => {
                setTaskMode(true);
                setTaskSaved(false);
                setError(null);
              }}
              aria-pressed={false}
            >
              <span className={styles.captureTypeIcon}>✓</span>
              <span className={styles.captureTypeBody}>
                <strong>{t("tasks.secretary.capture.task")}</strong>
                <small>{t("tasks.secretary.capture.taskDescription")}</small>
              </span>
            </button>
          ) : null}
        </div>
        <form className={styles.captureForm} onSubmit={submit}>
          <CaptureField label={kind === "postdated-check" ? t("tasks.secretary.capture.checkTo") : t("tasks.secretary.capture.payTo")}>
            <input className={styles.captureInput} value={obligeeName} onChange={(event) => setObligeeName(event.target.value)} placeholder={t("tasks.secretary.capture.namePlaceholder")} />
          </CaptureField>

          {kind === "regular" ? <>
            <div className={styles.captureTwoRow}>
              <CaptureField label={t("tasks.secretary.capture.howMuch")}>
                <input className={styles.captureInput} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t("tasks.secretary.capture.amountPlaceholder")} />
              </CaptureField>
              <CaptureField label={t("tasks.secretary.capture.currency")}>
                <input className={styles.captureInput} value={t("tasks.secretary.capture.currencyValue")} readOnly aria-label={t("tasks.secretary.capture.currencyAria")} />
              </CaptureField>
            </div>
            <CaptureDateInput label={t("tasks.secretary.capture.whenToPay")} value={dueAt} fallback={t("tasks.secretary.capture.pickDate")} onChange={setDueAt} />
            <div className={styles.captureField}>
              <span>{t("tasks.secretary.capture.frequency")}</span>
              <div className={styles.captureSegbar} role="radiogroup" aria-label={t("tasks.secretary.capture.recurrenceAria")}>
                {RECURRENCE_OPTIONS.map((option) => (
                  <button key={option.value} type="button" role="radio" aria-checked={recurrence === option.value} className={recurrence === option.value ? styles.captureSegOn : ""} onClick={() => setRecurrence(option.value)}>
                    {t(option.label)}
                  </button>
                ))}
              </div>
            </div>
            <CaptureField label={t("tasks.secretary.capture.note")}>
              <textarea className={styles.captureInput} value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("tasks.secretary.capture.notePlaceholder")} />
            </CaptureField>
          </> : null}

          {kind === "installments" ? <>
            <div className={styles.captureTwoRow}>
              <CaptureField label={t("tasks.secretary.capture.totalAmount")}>
                <input className={styles.captureInput} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t("tasks.secretary.capture.amountPlaceholder")} />
              </CaptureField>
              <CaptureField label={t("tasks.secretary.capture.installmentCount")}>
                <input className={styles.captureInput} inputMode="numeric" value={installmentCount} onChange={(event) => setInstallmentCount(event.target.value)} placeholder="3" />
              </CaptureField>
            </div>
            <CaptureDateInput label={t("tasks.secretary.capture.firstDate")} value={dueAt} fallback={t("tasks.secretary.capture.pickFirst")} onChange={setDueAt} />
            <section className={styles.captureSchedule} aria-label={t("tasks.secretary.capture.schedule")}>
              <strong>{t("tasks.secretary.capture.schedule")}</strong>
              {scheduleRows.length > 0 ? scheduleRows.map((row) => (
                <div key={row.index} className={styles.captureScheduleRow}>
                  <span>{row.index + 1}/{installmentCountNumber}</span>
                  <b>{row.amount}</b>
                  <small>{row.date}</small>
                </div>
              )) : <p>{t("tasks.secretary.capture.scheduleHint", { count: installmentCountNumber })}</p>}
            </section>
            <div className={styles.captureCalmNote}>{P3_COPY.installmentsNote(installmentCountNumber)}</div>
          </> : null}

          {kind === "postdated-check" ? <>
            <div className={styles.captureTwoRow}>
              <CaptureField label={t("tasks.secretary.capture.amount")}>
                <input className={styles.captureInput} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t("tasks.secretary.capture.amountPlaceholder")} />
              </CaptureField>
              <CaptureField label={t("tasks.secretary.capture.checkNumber")}>
                <input className={styles.captureInput} value={checkNumber} onChange={(event) => setCheckNumber(event.target.value)} placeholder="000000" />
              </CaptureField>
            </div>
            <CaptureDateInput label={t("tasks.secretary.capture.maturityDate")} value={dueAt} fallback={t("tasks.secretary.capture.pickMaturity")} onChange={setDueAt} />
            <div className={styles.captureCalmNote}>{P3_COPY.checkNote}</div>
          </> : null}

          {kind === "net-terms" ? <>
            <CaptureField label={t("tasks.secretary.capture.amount")}>
              <input className={styles.captureInput} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t("tasks.secretary.capture.amountPlaceholder")} />
            </CaptureField>
            <CaptureDateInput label={t("tasks.secretary.capture.invoiceDate")} value={invoiceDate} fallback={t("tasks.secretary.capture.pickInvoiceDate")} onChange={setInvoiceDate} />
            <div className={styles.captureField}>
              <span>{t("tasks.secretary.capture.paymentTerms")}</span>
              <div className={styles.captureSegbar} role="radiogroup" aria-label={t("tasks.secretary.capture.paymentTerms")}>
                {(["30", "60", "90"] as const).map((value) => (
                  <button key={value} type="button" role="radio" aria-checked={termsDays === value} className={termsDays === value ? styles.captureSegOn : ""} onClick={() => setTermsDays(value)}>
                    {t("tasks.secretary.capture.netTerm", { days: value })}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.captureCalmNote}>{netDueDate ? P3_COPY.netComputed(termsDays, netDueDate) : t("tasks.secretary.capture.netPending")}</div>
          </> : null}

          {error ? <div className={styles.formError}>{error}</div> : null}
          <PrimaryButton type="submit" disabled={busy}>{busy ? t("tasks.secretary.moment") : t("tasks.secretary.capture.submit")}</PrimaryButton>
        </form>
        </>}
      </section>
    </main>
  );
}

function CaptureField({ label, children }: { label: string; children: ReactNode }) {
  return <label className={styles.captureField}><span>{label}</span>{children}</label>;
}

function CaptureDateInput({ label, value, fallback, onChange }: { label: string; value: string; fallback: string; onChange: (value: string) => void }) {
  // The native date input sits as a full-size transparent overlay above the
  // styled display, so a tap on the field opens the OS date picker natively
  // (the reliable, cross-browser behaviour used elsewhere in the app) instead
  // of depending on showPicker() against a hidden input.
  const f = useFmt();
  return (
    <CaptureField label={label}>
      <div className={styles.captureDateField}>
        <div className={[styles.captureInput, styles.captureDateButton].join(" ")} aria-hidden="true">
          <span>{dateLabel(value, fallback, f)}</span>
          <CalendarIcon />
        </div>
        <input
          className={styles.captureDateOverlay}
          type="date"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={label}
        />
      </div>
    </CaptureField>
  );
}

function dateLabel(value: string, fallback: string, f: Fmt): string {
  return value ? formatDateValue(new Date(value + "T09:00:00").toISOString(), f) : fallback;
}

function normalizeInstallmentCount(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 3;
  return Math.max(2, Math.min(24, n));
}

function buildInstallmentRows(amount: string, firstDate: string, count: number, f: Fmt): Array<{ index: number; amount: string; date: string }> {
  const total = Number(amount);
  if (!Number.isFinite(total) || total <= 0 || !firstDate) return [];
  const first = new Date(firstDate + "T09:00:00");
  if (Number.isNaN(first.getTime())) return [];
  const each = total / count;
  return Array.from({ length: count }, (_, index) => {
    const date = addMonths(first, index);
    return { index, amount: formatMoneyValue(String(each), "ILS", f), date: formatDateValue(date.toISOString(), f) };
  });
}

function netTermsDueDateValue(invoiceDate: string, days: number): Date | null {
  const invoice = new Date(invoiceDate + "T09:00:00");
  if (Number.isNaN(invoice.getTime())) return null;
  const endOfMonth = new Date(invoice.getFullYear(), invoice.getMonth() + 1, 0, 9, 0, 0);
  endOfMonth.setDate(endOfMonth.getDate() + days);
  return endOfMonth;
}

function calculateNetTermsDueDate(invoiceDate: string, days: number, f: Fmt): string | null {
  const due = netTermsDueDateValue(invoiceDate, days);
  return due ? formatDateValue(due.toISOString(), f) : null;
}

function requiredMessageForKind(kind: CaptureKind, t: Translator): string {
  switch (kind) {
    case "installments":
      return t("tasks.secretary.capture.required.installments");
    case "postdated-check":
      return t("tasks.secretary.capture.required.postdatedCheck");
    case "net-terms":
      return t("tasks.secretary.capture.required.netTerms");
    case "regular":
    default:
      return t("tasks.secretary.capture.required.regular");
  }
}

function captureSayForKind(kind: CaptureKind, t: Translator): string {
  switch (kind) {
    case "installments":
      return t("tasks.secretary.capture.say.installments");
    case "postdated-check":
      return P3_COPY.checkSay;
    case "net-terms":
      return t("tasks.secretary.capture.say.netTerms");
    case "regular":
    default:
      return t("tasks.secretary.capture.say.regular");
  }
}


function UpdateScreen({ obligation, onUpdate }: { obligation: ObligationApi | null; onUpdate?: (id: number, input: UpdateObligationInput) => Promise<void> | void }) {
  const f = useFmt();
  const { t } = f;
  const [name, setName] = useState(obligation?.obligeeName ?? "");
  const [amount, setAmount] = useState(obligation ? String(Math.round(amountNumber(obligation))) : "");
  const [date, setDate] = useState(obligation?.dueAt.slice(0, 10) ?? "");
  const [recurrence, setRecurrence] = useState<RecurrenceCadence>(obligation?.recurrence ?? "NONE");
  const [note, setNote] = useState(obligation?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!obligation) return <SecretaryScreen title={t("tasks.secretary.update.title")} backHref={screenHref("all")}><EmptyMemory title={t("tasks.secretary.update.emptyTitle")} body={t("tasks.secretary.update.emptyBody")} /></SecretaryScreen>;
  const obligationId = obligation.id;

  // Build a patch of ONLY the fields the owner actually changed, then persist.
  // The success view is shown strictly after a successful save.
  async function save() {
    if (busy) return;
    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      setError(t("tasks.secretary.update.needName"));
      return;
    }
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0) {
      setError(t("tasks.secretary.update.needAmount"));
      return;
    }
    const parsed = new Date(date + "T09:00:00");
    if (!date || Number.isNaN(parsed.getTime())) {
      setError(t("tasks.secretary.update.needDate"));
      return;
    }
    const patch: UpdateObligationInput = {};
    if (trimmedName !== obligation!.obligeeName) patch.obligeeName = trimmedName;
    if (num !== Number(obligation!.amount)) patch.amount = amount;
    if (parsed.toISOString().slice(0, 10) !== obligation!.dueAt.slice(0, 10)) patch.dueAt = parsed.toISOString();
    if (recurrence !== obligation!.recurrence) patch.recurrence = recurrence;
    const trimmedNote = note.trim() || null;
    if (trimmedNote !== (obligation!.note ?? null)) patch.note = trimmedNote;
    if (Object.keys(patch).length === 0) {
      setError(t("tasks.secretary.update.noChanges"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onUpdate?.(obligationId, patch);
      setDone(true);
    } catch {
      setError(t("tasks.secretary.capture.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    // After a successful save the obligation prop already reflects the new
    // values, so the confirmation shows exactly what was persisted.
    const savedName = displayName(obligation.obligeeName, t);
    const savedAmount = formatMoneyValue(obligation.amount, obligation.currency, f);
    return (
      <SecretaryScreen title={t("tasks.secretary.update.title")} backHref={screenHref("detail", obligationId)}>
        <section className={styles.sheetStage}>
          <div className={styles.sheetGrip} />
          <div className={styles.okHead}><span>✓</span><p>{t("tasks.secretary.update.done", { name: savedName, amount: savedAmount, date: formatDateValue(obligation.dueAt, f) })}</p></div>
          <section className={styles.echoCard}><span>{emojiForObligation(obligation)}</span><div><strong>{savedName}</strong><small>{recurrenceText(obligation.recurrence, t)}</small></div><b>{savedAmount}</b></section>
          <PrimaryLink href={screenHref("detail", obligationId)}>{t("tasks.secretary.update.close")}</PrimaryLink>
        </section>
      </SecretaryScreen>
    );
  }

  return (
    <SecretaryScreen title={t("tasks.secretary.update.title")} backHref={screenHref("detail", obligationId)}>
      <section className={styles.sheetStage}>
        <div className={styles.sheetGrip} />
        <Say>{t("tasks.secretary.update.say")}</Say>
        <FormField label={t("tasks.secretary.update.payTo")}><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("tasks.secretary.capture.namePlaceholder")} /></FormField>
        <FormField label={t("tasks.secretary.capture.amount")}><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={t("tasks.secretary.capture.amountPlaceholder")} /></FormField>
        <FormField label={t("tasks.secretary.update.chargeDate")}><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></FormField>
        <div className={styles.formField}>
          <span>{t("tasks.secretary.update.recurrence")}</span>
          <div className={styles.captureSegbar} role="radiogroup" aria-label={t("tasks.secretary.update.recurrence")}>
            {RECURRENCE_OPTIONS.map((option) => (
              <button key={option.value} type="button" role="radio" aria-checked={recurrence === option.value} className={recurrence === option.value ? styles.captureSegOn : ""} onClick={() => setRecurrence(option.value)}>
                {t(option.label)}
              </button>
            ))}
          </div>
        </div>
        <FormField label={t("tasks.secretary.capture.note")}><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("tasks.secretary.capture.notePlaceholder")} /></FormField>
        {error ? <div className={styles.formError}>{error}</div> : null}
        <div className={styles.actions}>
          <PrimaryButton disabled={busy} onClick={() => void save()}>{busy ? t("tasks.secretary.moment") : t("tasks.secretary.update.saveChanges")}</PrimaryButton>
          <GhostLink href={screenHref("detail", obligationId)}>{t("tasks.common.cancel")}</GhostLink>
        </div>
      </section>
    </SecretaryScreen>
  );
}

function FormField({ label, children }: { label: string; children: ReactNode }) { return <label className={styles.formField}><span>{label}</span>{children}</label>; }

const LOOP_TITLE: Record<SecretaryLoopMode, MessageKey> = {
  met: "tasks.secretary.loopTitle.met",
  snooze: "tasks.secretary.loopTitle.snooze",
  release: "tasks.secretary.loopTitle.release",
  created: "tasks.secretary.loopTitle.created",
};

function LoopsScreen({ obligation, initialMode = "met" }: { obligation: ObligationApi | null; initialMode?: SecretaryLoopMode }) {
  const { t } = useI18n();
  return <SecretaryScreen title={t(LOOP_TITLE[initialMode])} backHref={obligation ? screenHref("detail", obligation.id) : "/secretary"}><LoopResult mode={initialMode} obligation={obligation} /></SecretaryScreen>;
}

/** The due date of the next occurrence of a recurring obligation, or null. */
function nextOccurrenceLabel(iso: string, cadence: RecurrenceCadence, f: Fmt): string | null {
  const base = dateValue(iso);
  if (!base) return null;
  switch (cadence) {
    case "WEEKLY": {
      const next = new Date(base);
      next.setDate(next.getDate() + 7);
      return formatDateValue(next.toISOString(), f);
    }
    case "MONTHLY":
      return formatDateValue(addMonths(base, 1).toISOString(), f);
    case "BIMONTHLY":
      return formatDateValue(addMonths(base, 2).toISOString(), f);
    case "QUARTERLY":
      return formatDateValue(addMonths(base, 3).toISOString(), f);
    case "SEMIANNUAL":
      return formatDateValue(addMonths(base, 6).toISOString(), f);
    case "YEARLY":
      return formatDateValue(addMonths(base, 12).toISOString(), f);
    case "NONE":
    default:
      return null;
  }
}

function LoopResult({ mode, obligation, createdNote, onAddMore }: { mode: "met" | "snooze" | "release" | "created"; obligation: ObligationApi | null; createdNote?: string; onAddMore?: () => void }) {
  const f = useFmt();
  const { t } = f;
  const name = obligation ? displayName(obligation.obligeeName, t) : t("tasks.secretary.loop.theObligation");
  const amount = obligation ? formatMoneyValue(obligation.amount, obligation.currency, f) : "";
  // "created" says what Dubiz really does (no reminder is sent): the due date, and when it rises in the Secretary.
  const dueDate = obligation ? formatDateValue(obligation.dueAt, f) : "";
  const createdBody = (obligation ? P3_COPY.createdBody(name, dueDate) : P3_COPY.createdBodyGeneric) + (createdNote ? " " + createdNote : "");
  const nextDate = obligation ? nextOccurrenceLabel(obligation.dueAt, obligation.recurrence, f) : null;
  const config = mode === "met"
    ? { tone: "green", title: t("tasks.secretary.loop.metTitle", { name }), body: obligation?.recurrence === "NONE" ? t("tasks.secretary.loop.metBodyOnce") : t("tasks.secretary.loop.metBodyRecurring"), primary: t("tasks.secretary.loop.next"), secondary: t("tasks.secretary.loop.close") }
    : mode === "snooze"
      ? { tone: "calm", title: t("tasks.secretary.loop.snoozeTitle"), body: t("tasks.secretary.loop.snoozeBody"), primary: t("tasks.secretary.loop.close"), secondary: undefined }
      : mode === "release"
        ? { tone: "neutral", title: t("tasks.secretary.loop.releaseTitle"), body: t("tasks.secretary.loop.releaseBody"), primary: t("tasks.secretary.loop.close"), secondary: undefined }
        : { tone: "brand", title: t("tasks.secretary.loop.createdTitle"), body: createdBody, primary: t("tasks.secretary.loop.addMore"), secondary: t("tasks.secretary.loop.finished") };
  const resultClass = [styles.loopResult, mode === "created" ? styles.loopResultCreated : ""].join(" ");
  const echoClass = [styles.echoCard, mode === "created" ? styles.echoCardCreated : ""].join(" ");
  const badgeClass = [styles.loopBadge, styles[`loopBadge_${config.tone}`]].join(" ");
  const echoMeta =
    mode === "created" ? P3_COPY.echoDue(dueDate) :
    mode === "snooze" ? t("tasks.secretary.loop.echoSnooze") :
    mode === "met" ? (nextDate ? t("tasks.secretary.loop.echoNext", { date: nextDate }) : t("tasks.secretary.loop.echoClosed")) :
    recurrenceText(obligation?.recurrence ?? "NONE", t);
  return <section className={resultClass}><div className={badgeClass}>✓</div><h2>{config.title}</h2><p>{config.body}</p>{obligation && mode !== "release" ? <section className={echoClass}><span>{emojiForObligation(obligation)}</span><div><strong>{name}</strong><small>{echoMeta}</small></div><b>{amount}</b></section> : null}<div className={styles.loopFoot}>{mode === "created" && onAddMore ? <PrimaryButton onClick={onAddMore}>{config.primary}</PrimaryButton> : <PrimaryLink href={mode === "created" ? screenHref("capture") : "/secretary?today=1"}>{config.primary}</PrimaryLink>}{config.secondary ? <GhostLink href="/secretary">{config.secondary}</GhostLink> : null}</div></section>;
}

function RemindScreen({ obligation, onSnooze }: { obligation: ObligationApi | null; onSnooze?: (id: number, followUpAt: string) => Promise<void> | void }) {
  const f = useFmt();
  const { t } = f;
  const [choiceKey, setChoiceKey] = useState<string>("week");
  const [customDate, setCustomDate] = useState<string>("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!obligation) return <SecretaryScreen title={t("tasks.secretary.remind.title")} backHref={screenHref("all")}><EmptyMemory title={t("tasks.secretary.remind.emptyTitle")} body={t("tasks.secretary.remind.emptyBody")} /></SecretaryScreen>;
  const obligationId = obligation.id;
  const now = new Date();
  const presets = [
    { key: "tomorrow", label: t("tasks.secretary.remind.tomorrowMorning"), date: atMorning(addDays(now, 1)) },
    { key: "week", label: t("tasks.secretary.remind.inAWeek"), date: atMorning(addDays(now, 7)) },
    { key: "month", label: t("tasks.secretary.remind.inAMonth"), date: atMorning(addMonths(now, 1)) },
  ];
  const customValue = customDate ? atMorning(new Date(customDate + "T09:00:00")) : null;
  const minDate = toInputDate(addDays(now, 1));

  function resolveTarget(): Date | null {
    if (choiceKey === "custom") return customValue;
    const preset = presets.find((option) => option.key === choiceKey);
    return preset ? preset.date : null;
  }

  async function submit() {
    if (busy) return;
    const target = resolveTarget();
    if (!target || Number.isNaN(target.getTime())) {
      setError(t("tasks.secretary.remind.needChoice"));
      return;
    }
    if (target.getTime() <= now.getTime()) {
      setError(t("tasks.secretary.remind.needFuture"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSnooze?.(obligationId, target.toISOString());
      setDone(true);
    } catch {
      setError(t("tasks.secretary.capture.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const target = resolveTarget() ?? now;
    return <SecretaryScreen title={t("tasks.secretary.remind.title")} backHref={screenHref("detail", obligation.id)}><section className={styles.loopResult}><div className={`${styles.loopBadge} ${styles.loopBadge_calm}`}>⏱</div><h2>{t("tasks.secretary.remind.doneTitle", { date: formatDateValue(target.toISOString(), f) })}</h2><p>{t("tasks.secretary.remind.doneBody")}</p><PrimaryLink href="/secretary?today=1">{t("tasks.secretary.loop.close")}</PrimaryLink></section></SecretaryScreen>;
  }

  return (
    <SecretaryScreen title={t("tasks.secretary.remind.title")} backHref={screenHref("detail", obligation.id)}>
      <section className={styles.sheetStage}>
        <div className={styles.sheetGrip} />
        <Say>{t("tasks.secretary.remind.say")}</Say>
        <section className={styles.contextCard}>
          <span>{emojiForObligation(obligation)}</span>
          <div><strong>{displayName(obligation.obligeeName, t)}</strong><small>{t("tasks.secretary.detail.payOn", { date: formatDateValue(obligation.dueAt, f) })}</small></div>
          <b>{formatMoneyValue(obligation.amount, obligation.currency, f)}</b>
        </section>
        <div className={styles.remindOptions}>
          {presets.map((option) => (
            <button key={option.key} type="button" className={`${styles.remindOption} ${choiceKey === option.key ? styles.remindOptionSelected : ""}`} onClick={() => { setChoiceKey(option.key); setError(null); }}>
              <span>⏱</span><strong>{option.label}</strong><em>{formatDateValue(option.date.toISOString(), f)}</em><b />
            </button>
          ))}
          <label className={`${styles.remindOption} ${choiceKey === "custom" ? styles.remindOptionSelected : ""}`}>
            <span>🔔</span><strong>{t("tasks.secretary.remind.otherDate")}</strong><em>{customValue ? formatDateValue(customValue.toISOString(), f) : t("tasks.secretary.remind.pickDate")}</em><b />
            <input
              className={styles.captureDateOverlay}
              type="date"
              min={minDate}
              value={customDate}
              onChange={(event) => { const v = event.target.value; setCustomDate(v); if (v) { setChoiceKey("custom"); setError(null); } }}
              aria-label={t("tasks.secretary.remind.pickAria")}
            />
          </label>
        </div>
        {error ? <div className={styles.formError}>{error}</div> : null}
        <PrimaryButton disabled={busy} onClick={() => void submit()}>{busy ? t("tasks.secretary.moment") : t("tasks.secretary.remind.submit")}</PrimaryButton>
      </section>
    </SecretaryScreen>
  );
}

function WatchingScreen({ obligations }: { obligations: ObligationApi[] }) {
  const { t } = useI18n();
  const now = new Date();
  const weekEnd = new Date(now); weekEnd.setDate(now.getDate() + 7);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const week = obligations.filter((item) => { const due = dateValue(item.dueAt); return due && due <= weekEnd; }).length;
  const month = obligations.filter((item) => { const due = dateValue(item.dueAt); return due && due > weekEnd && due <= monthEnd; }).length;
  const far = Math.max(0, obligations.length - week - month);
  const allQuiet = obligations.length === 0 || week === 0;
  return <SecretaryScreen title={t("tasks.secretary.watching.title")} backHref="/secretary"><Say>{allQuiet ? t("tasks.secretary.watching.sayQuiet") : t("tasks.secretary.watching.sayBusy")}</Say>{allQuiet ? <section className={styles.allQuiet}><div>✓</div><h2>{t("tasks.secretary.watching.quietTitle")}</h2><p>{t("tasks.secretary.watching.quietBody", { count: obligations.length })}</p><b>{t("tasks.secretary.watching.quietFoot")}</b></section> : <><section className={styles.watchPeace}><div className={styles.watchRing}><strong>{obligations.length}</strong><span>{t("tasks.secretary.watching.tracking")}</span></div><p>{t("tasks.secretary.watching.peace")}</p></section><div className={styles.watchHorizons}><Horizon title={t("tasks.secretary.watching.weekTitle")} subtitle={t("tasks.secretary.watching.weekSubtitle")} count={String(week)} /><Horizon title={t("tasks.secretary.watching.monthTitle")} subtitle={t("tasks.secretary.watching.monthSubtitle")} count={String(month)} /><Horizon title={t("tasks.secretary.watching.farTitle")} subtitle={t("tasks.secretary.watching.farSubtitle")} count={String(far)} /></div></>}<section className={styles.reassurePanel}><p>{t("tasks.secretary.watching.reassure")}</p><GhostLink href={screenHref("all")}>{t("tasks.secretary.watching.seeAll")}</GhostLink></section></SecretaryScreen>;
}

function NotifyScreen({ obligations }: { obligations: ObligationApi[] }) {
  const f = useFmt();
  const { t } = f;
  const [enabled, setEnabled] = useState(true);
  const [morning, setMorning] = useState(true);
  const [quiet, setQuiet] = useState(false);
  const sample = obligations[0] ?? null;
  return <SecretaryScreen title={t("tasks.secretary.notify.title")} backHref="/secretary"><section className={styles.notifyLock}><div className={styles.lockTime}>09:41</div><div className={styles.notificationCard}><span><PersonIcon /></span><div><strong>{t("tasks.secretary.yourSecretary")}</strong><p>{sample ? t("tasks.secretary.notify.sample", { name: sample.obligeeName }) : t("tasks.secretary.notify.noSample")}</p></div></div><div className={styles.notificationCardFaded} /></section><Say>{t("tasks.secretary.notify.say")}</Say><section className={styles.settingsGroup}><SettingRow title={t("tasks.secretary.notify.enabledTitle")} detail={t("tasks.secretary.notify.enabledDetail")} on={enabled} onClick={() => setEnabled((value) => !value)} /><SettingRow title={t("tasks.secretary.notify.morningTitle")} detail={t("tasks.secretary.notify.morningDetail")} on={morning} onClick={() => setMorning((value) => !value)} /><SettingRow title={t("tasks.secretary.notify.quietTitle")} detail={t("tasks.secretary.notify.quietDetail")} on={quiet} onClick={() => setQuiet((value) => !value)} /></section><section className={styles.feedCard}><div className={styles.smallTitle}>{t("tasks.secretary.notify.feedTitle")}</div>{obligations.slice(0, 3).map((item) => <div className={styles.feedRow} key={item.id}><span>{emojiForObligation(item)}</span><div><strong>{item.obligeeName}</strong><em>{t("tasks.secretary.notify.remindBefore", { date: formatDateValue(item.dueAt, f) })}</em></div><small>{t("tasks.secretary.notify.inTime")}</small></div>)}{obligations.length === 0 ? <p className={styles.emptyText}>{t("tasks.secretary.notify.empty")}</p> : null}</section></SecretaryScreen>;
}

function Horizon({ title, subtitle, count }: { title: string; subtitle: string; count: string }) { return <div className={styles.horizon}><EyeIcon /><span><strong>{title}</strong><em>{subtitle}</em></span><b>{count}</b></div>; }
function SettingRow({ title, detail, on, onClick }: { title: string; detail: string; on?: boolean; onClick?: () => void }) { return <button type="button" className={styles.settingRow} onClick={onClick}><BellIcon /><span><strong>{title}</strong><em>{detail}</em></span><b className={on ? styles.toggleOn : ""} /></button>; }

export const TODAY_DEMO_MODELS: Record<TodayState, TodayModel> = {
  critical: {
    state: "critical",
    status: "בדקתי את היום שלך",
    title: "יש דבר אחד שכדאי לסגור היום.",
    subtitle: "בוא נטפל בו קודם — אני כבר שומרת את כל השאר.",
    focus: {
      tone: "urgent",
      tag: "להיום",
      name: "התחייבות לדוגמה",
      amount: "₪0",
      meta: "לתשלום היום",
      chip: "כל חודש",
      note: "העברה בנקאית לחשבון שמסתיים ב-4471",
    },
    watching: {
      line: "אני שומרת עוד 4 דברים לימים הקרובים",
      subline: "אין מה לעשות בהם עכשיו — אזכיר בזמן.",
    },
  },
  busy: {
    state: "busy",
    status: "עברתי על השבוע שלך",
    title: "יש כמה דברים השבוע. בוא נתחיל מהחשוב.",
    subtitle: "נסגור אחד-אחד. אני כאן לאורך כל הדרך.",
    focus: { tone: "soon", tag: "קרוב", name: "התחייבות לדוגמה", amount: "₪0", meta: "לתצוגת מצב בלבד" },
    watching: {
      line: "ועוד 2 דברים אחרי זה השבוע",
      subline: "אמשיך להזכיר לך כל אחד בזמנו.",
    },
  },
  calm: {
    state: "calm",
    status: "הכל תחת מעקב",
    title: "אין משהו שדורש אותך עכשיו.",
    subtitle: "עברתי על הכל. אני ממשיכה לעקוב, וברגע שמשהו יתקרב — אני כבר אגיד לך.",
    watching: {
      line: "אני שומרת 6 התחייבויות לחודש הקרוב",
      subline: "הכל רגוע — אזכיר כשמשהו יתקרב.",
    },
  },
};

export function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.3" />
      <path d="M5.4 19c0-3.7 3-6.2 6.6-6.2s6.6 2.5 6.6 6.2" />
    </svg>
  );
}

export function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-6.6 10-6.6S22 12 22 12s-3.6 6.6-10 6.6S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.2 4.2L19 7" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  );
}

/** Drawn pointing left — "forward" in RTL; mirrored in LTR by .fwdIcon:dir(ltr). */
function ChevronLeftIcon() {
  return (
    <svg className={styles.fwdIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}
function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}



