import { Component, useEffect, useRef, useState, type CSSProperties, type FormEvent, type MutableRefObject, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TOKEN } from "@/lib/design/tokens";
import type {
  CreateObligationInput,
  ObligationApi,
  RecurrenceCadence,
  UpdateObligationInput,
} from "@/lib/obligations/secretary-client";
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
  title: string;
  description: string;
  icon: string;
  supported: boolean;
};

const RECURRENCE_OPTIONS: Array<{ value: RecurrenceCadence; label: string }> = [
  { value: "NONE", label: "חד-פעמי" },
  { value: "WEEKLY", label: "כל שבוע" },
  { value: "MONTHLY", label: "כל חודש" },
  { value: "YEARLY", label: "כל שנה" },
];

const CAPTURE_KINDS: CaptureKindOption[] = [
  {
    key: "regular",
    title: "תשלום רגיל",
    description: "למי, כמה ומתי לשלם",
    icon: "💳",
    supported: true,
  },
  {
    key: "installments",
    title: "פריסת תשלומים",
    description: "לוח תשלומים למעקב",
    icon: "🗓️",
    supported: true,
  },
  {
    key: "postdated-check",
    title: "צ'ק דחוי",
    description: "פירעון ותזכורת לפני",
    icon: "📝",
    supported: true,
  },
  {
    key: "net-terms",
    title: "שוטף+",
    description: "חישוב מועד תשלום",
    icon: "⏳",
    supported: true,
  },
];

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
  const t = TOKEN.secretary;
  return {
    "--sec-ink": t.ink,
    "--sec-muted": t.muted,
    "--sec-line": t.line,
    "--sec-canvas": t.canvas,
    "--sec-surface": t.surface,
    "--sec-surface-2": t.surface2,
    "--sec-action": t.action,
    // Align the secretary's hero + primary gradient to the canonical Dubiz
    // brand line (same gradient the Documents hub uses) for cross-feature
    // consistency, instead of a slightly-off local navy.
    "--sec-grad": TOKEN.brand.gradient,
    "--sec-brand": t.brand,
    "--sec-brand-shadow": t.brandShadow,
    "--sec-primary-shadow": t.primaryShadow,
    "--sec-focus-shadow": t.focusShadow,
    "--sec-hi": t.hi,
    "--sec-hi-bg": t.hiBg,
    "--sec-hi-ink": t.hiInk,
    "--sec-md": t.md,
    "--sec-md-bg": t.mdBg,
    "--sec-md-ink": t.mdInk,
    "--sec-lo": t.lo,
    "--sec-lo-bg": t.loBg,
    "--sec-lo-ink": t.loInk,
    "--sec-urgent": TOKEN.semantic.urgent.border,
    "--sec-urgent-bg": TOKEN.semantic.urgent.bg,
    "--sec-urgent-ink": TOKEN.semantic.urgent.ink,
    "--sec-info-bg": t.infoBg,
    "--sec-info-ink": t.infoInk,
    "--sec-calm": t.calm,
    "--sec-calm-bg": t.calmBg,
    "--sec-calm-ink": t.calmInk,
    "--sec-purple": t.purple,
    "--sec-purple-bg": t.purpleBg,
    "--sec-purple-ink": t.purpleInk,
    "--sec-neutral-text": t.neutralText,
    "--sec-soft-icon": t.softIcon,
    "--sec-selected-border": t.selectedBorder,
    "--sec-dashed-border": t.dashedBorder,
    "--sec-sheet-dim": t.sheetDim,
    "--sec-active-ring": t.activeRing,
    "--sec-home-wash": t.homeWash,
    "--sec-home-shadow-soft": t.homeShadowSoft,
    "--sec-home-shadow-lift": t.homeShadowLift,
    "--sec-home-go-color": t.homeGoColor,
    "--sec-action-primary-bg": TOKEN.brand.gradient,
    "--sec-action-primary-color": t.canvas,
    "--sec-action-primary-border": "0",
    "--sec-action-primary-shadow": t.primaryShadow,
    "--sec-action-glass-bg": TOKEN.action.glass.background,
    "--sec-action-glass-color": TOKEN.action.glass.color,
    "--sec-action-glass-border": TOKEN.action.glass.border,
    "--sec-action-glass-shadow": TOKEN.action.glass.shadow,
    "--sec-radius-button": `${TOKEN.radius.button}px`,
    "--sec-font-body": `${TOKEN.font.body}px`,
    "--sec-weight-bold": `${TOKEN.weight.bold}`,
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

export function SecretaryHomeScreen({ model }: { model: SecretaryHomeModel }) {
  const isNew = model.state === "new";
  const isDue = model.state === "due";
  return (
    <main className={styles.homeRoot} style={secretaryVars()}>
      <section className={styles.homeShell} aria-label="המזכירה שלך">
        <header className={styles.homeHead}>
          <div className={styles.homeAvatar} aria-hidden="true"><PersonIcon /></div>
          <div>
            <div className={styles.homeWho}>המזכירה שלך</div>
            <div className={styles.homeHello}>שלום 👋</div>
          </div>
        </header>

        <section className={styles.homeStatus}>
          <h1>{model.title.split("\n").map((part) => <span key={part}>{part}</span>)}</h1>
          <p>{model.subtitle}</p>
        </section>

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
                    <strong>כל ההתחייבויות</strong>
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
            <p>ברגע שיהיה לי מה לזכור, היום שלי וכל ההתחייבויות יופיעו כאן.</p>
          </div>
        ) : (
          <Link href={model.addHref} className={styles.homeAddRow}>
            <PlusIcon />
            הוספה למעקב
          </Link>
        )}
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
  return (
    <main className={styles.homeRoot} style={secretaryVars()}>
      <section className={styles.homeShell} aria-busy="true" aria-label="טוען את המזכירה">
        <header className={styles.homeHead}>
          <div className={styles.homeAvatar} aria-hidden="true"><PersonIcon /></div>
          <div>
            <div className={styles.homeWho}>המזכירה שלך</div>
            <div className={styles.homeHello}>שלום 👋</div>
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
}: {
  children: ReactNode;
  title?: string;
  backHref?: string;
  compact?: boolean;
}) {
  return (
    <main className={styles.root} style={secretaryVars()}>
      <div className={`${styles.shell} ${compact ? styles.shellCompact : ""}`}>
        <div className={styles.topbar}>
          <BackControl fallbackHref={backHref} />
          {title ? <div className={styles.topTitle}>{title}</div> : null}
          <div className={styles.topSpacer} />
        </div>
        {children}
      </div>
    </main>
  );
}

/**
 * Back to the real previous screen. Uses in-app history when it exists (so a
 * detail reached from "today" returns to "today", not a fixed target), and
 * falls back to a safe secretary href on a fresh deep link / refresh so we
 * never dead-end or leave a blank screen.
 */
function BackControl({ fallbackHref }: { fallbackHref: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className={styles.backButton}
      aria-label="חזרה למסך הקודם"
      onClick={() => {
        if (typeof window !== "undefined" && window.history.length > 1) {
          router.back();
        } else {
          router.push(fallbackHref);
        }
      }}
    >
      חזרה
    </button>
  );
}

export function SecretaryAvatar() {
  return (
    <div className={styles.avatar} aria-hidden="true">
      <PersonIcon />
    </div>
  );
}

export function SecretaryHeader({ status, tone }: { status: string; tone: TodayState | "done" }) {
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
        <div className={styles.who}>המזכירה שלך</div>
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
  title = "רגע, אני לא מצליחה לבדוק את היום שלך.",
  message = "אני עדיין כאן. לא אציג לך מסקנה עד שהבדיקה תחזור לעבוד, ובינתיים אין צורך לעשות פעולה מתוך המסך הזה.",
}: {
  title?: string;
  message?: string;
}) {
  return (
    <SecretaryScreen>
      <SecretaryHeader status="אני שומרת על זה בשקט" tone="calm" />
      <section className={styles.fallbackPanel}>
        <div className={styles.fallbackIcon} aria-hidden="true">!</div>
        <h1>{title}</h1>
        <p>{message}</p>
      </section>
      <WatchingPill
        line="מה שאני שומרת נשאר אצלי עד שהבדיקה תחזור"
        subline="לא אציג סכומים או פעולות כשאין לי תמונת מצב אמינה."
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
      return (
        <SecretarySoftFallback
          title="רגע, משהו בבדיקה נתקע."
          message="אני לא רוצה להציג לך תמונת מצב חלקית. אני שומרת את המסך רגוע עד שהבדיקה תחזור לעבוד."
        />
      );
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
        {busy ? "רגע…" : "סמן שטופל"}
      </button>
      <div className={styles.ghosts}>
        <button className={`${styles.button} ${styles.ghost}`} type="button" onClick={onSnooze}>
          להזכיר לי אחר כך
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
          יש עוד תשלום שאזכור בשבילך?
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

function formatMoneyValue(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: currency || "ILS",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return n.toLocaleString("he-IL") + " ₪";
  }
}

function formatDateValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "תאריך לא זמין";
  return date.toLocaleDateString("he-IL", { day: "numeric", month: "long" });
}

function recurrenceText(value: RecurrenceCadence): string {
  switch (value) {
    case "WEEKLY": return "כל שבוע";
    case "MONTHLY": return "כל חודש";
    case "YEARLY": return "כל שנה";
    case "NONE":
    default: return "חד-פעמי";
  }
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
function obligationMeta(item: ObligationApi): string {
  const base = formatDateValue(item.dueAt);
  const recurrence = recurrenceText(item.recurrence);
  return item.recurrence === "NONE" ? base : base + " · " + recurrence;
}

function amountNumber(item: ObligationApi): number {
  const value = Number(item.amount);
  return Number.isFinite(value) ? value : 0;
}

function sumMoney(items: ObligationApi[]): string {
  const currency = items[0]?.currency ?? "ILS";
  const total = items.reduce((sum, item) => sum + amountNumber(item), 0);
  return formatMoneyValue(String(total), currency);
}

function dateValue(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthLabel(date = new Date()): string {
  return date.toLocaleDateString("he-IL", { month: "long" });
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

function shortDueLabel(item: ObligationApi): string {
  const days = dueDaysFromNow(item);
  if (days === null) return formatDateValue(item.dueAt);
  if (days < 0) return "באיחור";
  if (days === 0) return "להיום";
  if (days === 1) return "מחר";
  if (days === 2) return "עוד יומיים";
  if (days <= 7) return `עוד ${days} ימים`;
  return formatDateValue(item.dueAt);
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

function cardFromObligation(item: ObligationApi): ObligationCard {
  return {
    id: item.id,
    emoji: emojiForObligation(item),
    title: displayName(item.obligeeName),
    amount: formatMoneyValue(item.amount, item.currency),
    meta: obligationMeta(item),
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
function displayName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length >= 2 ? trimmed : "התחייבות ללא שם";
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

function findCategoryObligation(label: string, obligations: ObligationApi[]): ObligationApi | null {
  return obligations.find((item) => item.obligeeName.includes(label)) ?? null;
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
  return (
    <Link className={styles.rememberedCard} href={screenHref("detail", item.id)}>
      <div className={styles.rememberedHead}>כבר אני זוכרת</div>
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
  if (!hasMore && !loading) return null;
  return (
    <button type="button" className={`${styles.button} ${styles.ghostWide} ${styles.loadMoreButton}`} onClick={onLoadMore} disabled={loading || !onLoadMore}>
      {loading ? "טוען..." : "הצג עוד"}
    </button>
  );
}
function BankScreen({ obligations, loadMore }: { obligations: ObligationApi[]; loadMore?: ReactNode }) {
  const cards = obligations.map(cardFromObligation);
  const firstCard = cards[0] ?? null;
  return (
    <SecretaryScreen title="נגדיר את ההתחייבויות" backHref="/secretary">
      <Say>אפשר ללחוץ על כל הוצאה שיש לך, ואמלא איתך את הפרטים.</Say>
      {firstCard ? <RememberedObligationCard item={firstCard} /> : null}
      <div className={styles.category}>קבועות חודשיות</div>
      <div className={styles.bankGrid}>
        <BankChip emoji="🏠" label="שכירות" obligation={findCategoryObligation("שכירות", obligations)} />
        <BankChip emoji="🏛️" label="ארנונה" obligation={findCategoryObligation("ארנונה", obligations)} />
        <BankChip emoji="⚡" label="חשמל" obligation={findCategoryObligation("חשמל", obligations)} />
        <BankChip emoji="💧" label="מים" obligation={findCategoryObligation("מים", obligations)} />
        <BankChip emoji="🌐" label="אינטרנט" obligation={findCategoryObligation("אינטרנט", obligations)} />
        <BankChip emoji="☎️" label="טלפון" obligation={findCategoryObligation("טלפון", obligations)} />
      </div>
      <div className={styles.category}>שירותים ומסים</div>
      <div className={styles.bankGrid}>
        <BankChip emoji="🛡️" label="ביטוחים" obligation={findCategoryObligation("ביטוח", obligations)} />
        <BankChip emoji="📊" label="רואה חשבון" obligation={findCategoryObligation("רואה חשבון", obligations)} />
        <BankChip emoji="🧾" label={'מע"מ'} obligation={findCategoryObligation('מע"מ', obligations)} />
        <BankChip emoji="👥" label="ביטוח לאומי" obligation={findCategoryObligation("ביטוח לאומי", obligations)} />
      </div>
      <Link className={styles.otherButton} href={captureHref()}><PlusIcon /> התחייבות אחרת</Link>
      <GhostLink href={screenHref("all")}>לראות את כל ההתחייבויות</GhostLink>
      {loadMore}
      <PrimaryLink href="/secretary">סיימתי, חזרה ליום שלי</PrimaryLink>
    </SecretaryScreen>
  );
}

function CalendarMonth({ obligations }: { obligations: ObligationApi[] }) {
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
      <div className={styles.calendarWeekdays}><span>א</span><span>ב</span><span>ג</span><span>ד</span><span>ה</span><span>ו</span><span>ש</span></div>
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

function TimelineGroup({ title, items, empty }: { title: string; items: ObligationApi[]; empty: string }) {
  return (
    <section className={styles.timelineGroup}>
      <div className={styles.timelineTitle}>{title}</div>
      {items.length > 0 ? items.map((item) => <TimelineItem key={item.id} item={item} />) : <div className={styles.timelineEmpty}>{empty}</div>}
    </section>
  );
}

function TimelineItem({ item }: { item: ObligationApi }) {
  const tone = obligationTone(item);
  const stripeTone = obligationStripeTone(item);
  const done = item.state === "MET";
  return (
    <Link className={`${styles.timelineItem} ${stripeTone === "late" ? styles.timelineLate : stripeTone === "soon" ? styles.timelineSoon : ""} ${done ? styles.timelineDone : ""}`} href={screenHref("detail", item.id)}>
      <span className={styles.timelineEmoji}>{emojiForObligation(item)}</span>
      <span className={styles.timelineBody}>
        <strong>{item.obligeeName}</strong>
        <span>{done ? `טופל ב-${formatDateValue(item.metAt ?? item.updatedAt)}` : <><StatusPill tone={tone}>{shortDueLabel(item)}</StatusPill>{recurrenceText(item.recurrence)}</>}</span>
      </span>
      <b>{formatMoneyValue(item.amount, item.currency)}</b>
    </Link>
  );
}

function StatusPill({ tone, children }: { tone: ObligationCard["tone"] | "purple"; children: ReactNode }) {
  const toneClass = tone === "urgent" ? styles.statusPillUrgent : tone === "soon" ? styles.statusPillSoon : tone === "calm" ? styles.statusPillCalm : tone === "purple" ? styles.statusPillPurple : styles.statusPillNeutral;
  return <em className={`${styles.statusPill} ${toneClass}`}>{children}</em>;
}

function AllObligationsScreen({ obligations, loadMore }: { obligations: ObligationApi[]; loadMore?: ReactNode }) {
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
  return (
    <SecretaryScreen title="כל ההתחייבויות" backHref="/secretary">
      <section className={styles.monthSummary}>
        <span>סך הכל במעקב · להוצאה</span>
        <strong>{sumMoney(openAll)}</strong>
        <div>
          <span><b>{openAll.length}</b><small>התחייבויות בסך הכל</small></span>
          <span><b>{sumMoney(monthOpen)}</b><small>החודש</small></span>
          <span><b>{sumMoney(doneThisMonth)}</b><small>טופל החודש</small></span>
        </div>
      </section>
      <div className={styles.calendarHead}><h3>היומן שלי · {monthLabel(now)}</h3><Link href="/secretary?today=1">היום</Link></div>
      <CalendarMonth obligations={monthItems} />
      <div className={styles.calendarLegend} aria-hidden="true">
        <span><i className={styles.calendarDotUrgent} />באיחור</span>
        <span><i className={styles.calendarDotSoon} />השבוע</span>
        <span><i className={styles.calendarDotCalm} />בהמשך</span>
        <span><b className={styles.calendarTodayKey} />היום</span>
      </div>
      {obligations.length > 0 ? (
        <>
          <TimelineGroup title={`השבוע · ${thisWeek.length} התחייבויות`} items={thisWeek} empty="אין התחייבויות לשבוע הקרוב." />
          <TimelineGroup title={`בהמשך · ${later.length}`} items={later} empty="אין עוד התחייבויות פתוחות בהמשך." />
          <TimelineGroup title={`שהושלמו החודש · ${doneThisMonth.length}`} items={doneThisMonth} empty="עוד לא סומנה התחייבות שטופלה החודש." />
        </>
      ) : <EmptyMemory title="אין עדיין התחייבויות פתוחות" body="היומן ריק כרגע. אפשר למסור לי התחייבות ראשונה ואשמור אותה בשבילך." />}
      {loadMore}
      <PrimaryLink href={screenHref("capture")}>למסור לי עוד התחייבות</PrimaryLink>
    </SecretaryScreen>
  );
}

function DetailMemoryCard({ obligation }: { obligation: ObligationApi }) {
  return (
    <section className={styles.memoryDetailCard} aria-label="מה שאני זוכרת">
      <div className={styles.memoryDetailRow}><span>{emojiForObligation(obligation)}</span><small>למי</small><strong>{displayName(obligation.obligeeName)}</strong></div>
      <div className={styles.memoryDetailRow}><span>💰</span><small>כמה</small><strong>{formatMoneyValue(obligation.amount, obligation.currency)}</strong></div>
      <div className={styles.memoryDetailRow}><span>📅</span><small>מתי</small><strong>{formatDateValue(obligation.dueAt)}</strong></div>
      <div className={styles.memoryDetailRow}><span>🔄</span><small>חזרתיות</small><strong>{recurrenceText(obligation.recurrence)}</strong></div>
    </section>
  );
}

function HistoryCard({ obligation, obligations }: { obligation: ObligationApi; obligations: ObligationApi[] }) {
  const history = obligations.filter((item) => item.state === "MET" && item.id !== obligation.id && ((item.recurrenceSeriesId && item.recurrenceSeriesId === obligation.recurrenceSeriesId) || item.obligeeName === obligation.obligeeName)).slice(0, 3);
  if (obligation.state === "MET") history.unshift(obligation);
  return (
    <section className={styles.historyCard}>
      <div className={styles.historyTitle}>מה שכבר טופל</div>
      {history.length > 0 ? history.map((item) => <div className={styles.historyRow} key={item.id}><span>✓</span><strong>טופל ב-{formatDateValue(item.metAt ?? item.updatedAt)}</strong><b>{formatMoneyValue(item.amount, item.currency)}</b></div>) : <p>אין לי עדיין היסטוריית תשלומים על ההתחייבות הזאת.</p>}
    </section>
  );
}


/**
 * Remove ("כבר לא רלוונטי") with a light, explicit confirm + an immediate
 * loading state — a destructive action never fires on a single tap and never
 * looks frozen while it runs. Reused by the detail screen and the today focus.
 */
function ReleaseControl({ onRelease, disabled }: { onRelease?: () => Promise<void> | void; disabled?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!onRelease) return null;
  if (confirming) {
    return (
      <div className={styles.confirmBox} role="group" aria-label="אישור הסרה">
        <p className={styles.confirmText}>להסיר את ההתחייבות הזאת?</p>
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
            {busy ? "רגע…" : "כן, להסיר"}
          </button>
          <button type="button" className={`${styles.button} ${styles.ghostWide}`} disabled={busy} onClick={() => setConfirming(false)}>
            לא, להשאיר
          </button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" className={`${styles.button} ${styles.ghostWide}`} disabled={disabled} onClick={() => setConfirming(true)}>
      כבר לא רלוונטי
    </button>
  );
}

function DetailScreen({ obligation, obligations, onComplete, onRelease }: { obligation: ObligationApi | null; obligations: ObligationApi[]; onComplete?: FlowAction; onRelease?: FlowAction }) {
  const [busy, setBusy] = useState(false);
  async function run(action?: FlowAction) { if (!obligation || !action || busy) return; setBusy(true); try { await action(obligation.id); } finally { setBusy(false); } }
  if (!obligation) return <SecretaryScreen title="התחייבות" backHref={screenHref("all")}><EmptyMemory title="אין התחייבות לבחור" body="ברגע שתהיה התחייבות אמיתית, הפרטים שלה יופיעו כאן." /><PrimaryLink href={screenHref("capture")}>למסור התחייבות ראשונה</PrimaryLink></SecretaryScreen>;
  const name = displayName(obligation.obligeeName);
  const tone = obligation.state === "MET" ? "calm" : isInstallmentObligation(obligation) ? "purple" : obligationTone(obligation);
  const isMet = obligation.state === "MET";
  const isInstallment = isInstallmentObligation(obligation);
  const metaText = isMet
    ? (obligation.recurrence === "NONE" ? "נסגר" : "התשלום הבא יחושב לפי " + recurrenceText(obligation.recurrence))
    : isInstallment
      ? "פריסת תשלומים במעקב"
      : "לתשלום ב-" + formatDateValue(obligation.dueAt);
  return (
    <SecretaryScreen title={name} backHref={screenHref("all")}>
      <section className={[styles.detailObjectHead, isMet ? styles.detailObjectDone : ""].join(" ")}>
          <div className={styles.detailObjectTile}>{emojiForObligation(obligation)}</div>
          <div className={styles.detailObjectInfo}>
            <strong>{name}</strong>
            <b>{formatMoneyValue(obligation.amount, obligation.currency)}</b>
          </div>
        </section>
        <div className={styles.detailMetaLine}>
          <StatusPill tone={tone}>{isMet ? "טופל החודש" : isInstallment ? "פריסת תשלומים" : shortDueLabel(obligation)}</StatusPill>
          <span>{metaText}</span>
        </div>
        <Say>{isMet ? "כבר טיפלת בזה החודש. אני שומרת את הזיכרון כדי שלא תצטרך לזכור שוב." : isInstallment ? "זה תשלום אחד מתוך פריסה שאני שומרת עבורך." : "זה מה שאני זוכרת על ההתחייבות הזאת."}</Say>
        <DetailMemoryCard obligation={obligation} />
        <HistoryCard obligation={obligation} obligations={obligations} />
        <div className={styles.actions}>
          {!isMet ? <PrimaryButton disabled={busy} onClick={() => void run(onComplete)}>{busy ? "רגע…" : "סמן שטופל"}</PrimaryButton> : null}
          <div className={styles.ghosts}>
            {!isMet ? <GhostLink href={screenHref("remind", obligation.id)}>להזכיר לי אחר כך</GhostLink> : null}
            <GhostLink href={screenHref("update", obligation.id)}>עריכת התחייבות</GhostLink>
          </div>
          {!isMet ? <ReleaseControl disabled={busy} onRelease={onRelease ? () => onRelease(obligation.id) : undefined} /> : null}
        </div>
    </SecretaryScreen>
  );
}

function CaptureScreen({ obligations, onCreate, onCreateMany, prefillName }: { obligations: ObligationApi[]; onCreate?: (input: CreateObligationInput) => Promise<ObligationApi | void>; onCreateMany?: (inputs: CreateObligationInput[]) => Promise<ObligationApi[]>; prefillName?: string }) {
  const [obligeeName, setObligeeName] = useState(prefillName ?? "");
  const [amount, setAmount] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const invoiceDateInputRef = useRef<HTMLInputElement | null>(null);
  const [recurrence, setRecurrence] = useState<RecurrenceCadence>("NONE");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<CaptureKind>("regular");
  const [installmentCount, setInstallmentCount] = useState("3");
  const [checkNumber, setCheckNumber] = useState("");
  const [termsDays, setTermsDays] = useState<"30" | "60" | "90">("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ObligationApi | null>(null);
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
  const scheduleRows = buildInstallmentRows(amount, dueAt, installmentCountNumber);
  const netDueDate = invoiceDate ? calculateNetTermsDueDate(invoiceDate, Number(termsDays)) : null;
  const canSubmit = (() => {
    if (!obligeeName.trim() || !amount.trim()) return false;
    if (kind === "net-terms") return Boolean(invoiceDate.trim());
    if (kind === "postdated-check") return Boolean(dueAt.trim() && checkNumber.trim());
    if (kind === "installments") return Boolean(dueAt.trim() && installmentCountNumber > 1);
    return Boolean(dueAt.trim());
  })();

  function openDatePicker(ref: MutableRefObject<HTMLInputElement | null>) {
    const picker = ref.current as (HTMLInputElement & { showPicker?: () => void }) | null;
    if (!picker) return;
    if (typeof picker.showPicker === "function") picker.showPicker();
    else picker.click();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!canSubmit) {
      setError(requiredMessageForKind(kind));
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
      setError("לא הצלחתי לשמור עכשיו. אפשר לנסות שוב עוד רגע.");
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
              <div className={styles.topTitle}>נגדיר את ההתחייבויות</div>
              <div className={styles.topSpacer} />
            </div>
            <Say>אפשר ללחוץ על כל הוצאה שיש לך, ואמלא איתך את הפרטים.</Say>
            {obligations[0] ? <RememberedObligationCard item={cardFromObligation(obligations[0])} /> : null}
            <div className={styles.category}>קבועות חודשיות</div>
            <div className={styles.bankGrid}>
              <BankChip emoji="🏠" label="שכירות" obligation={findCategoryObligation("שכירות", obligations)} />
              <BankChip emoji="🏛️" label="ארנונה" obligation={findCategoryObligation("ארנונה", obligations)} />
              <BankChip emoji="⚡" label="חשמל" obligation={findCategoryObligation("חשמל", obligations)} />
              <BankChip emoji="💧" label="מים" obligation={findCategoryObligation("מים", obligations)} />
            </div>
          </div>
        </div>
      </div>
      <div className={styles.captureDim} aria-hidden="true" />
      <section className={styles.captureSheet} aria-label="התחייבות חדשה">
        <div className={styles.sheetGrip} />
        <Link href={screenHref("bank")} className={styles.captureClose} aria-label="סגירת החלונית">×</Link>
        {created ? (
          <LoopResult mode="created" obligation={created} />
        ) : <>
        <div className={styles.topbar}>
          <div className={styles.topSpacer} />
          <div className={styles.topTitle}>{selectedKind.title}</div>
          <div className={styles.topSpacer} />
        </div>
        <Say>{captureSayForKind(kind)}</Say>
        <div className={styles.captureTypeList} aria-label="סוג התחייבות">
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
                <strong>{item.title}</strong>
                <small>{item.description}</small>
              </span>
              <i aria-hidden="true" />
            </button>
          ))}
        </div>
        <form className={styles.captureForm} onSubmit={submit}>
          <CaptureField label={kind === "postdated-check" ? "למי נמסר הצ'ק?" : "למי משלמים?"}>
            <input className={styles.captureInput} value={obligeeName} onChange={(event) => setObligeeName(event.target.value)} placeholder="שם הספק או הגורם" />
          </CaptureField>

          {kind === "regular" ? <>
            <div className={styles.captureTwoRow}>
              <CaptureField label="כמה">
                <input className={styles.captureInput} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0 ₪" />
              </CaptureField>
              <CaptureField label="מטבע">
                <input className={styles.captureInput} value="₪ שקל" readOnly aria-label="מטבע שקל" />
              </CaptureField>
            </div>
            <CaptureDateInput label="מתי לתשלום" value={dueAt} fallback="בחר תאריך" inputRef={dateInputRef} onOpen={() => openDatePicker(dateInputRef)} onChange={setDueAt} />
            <div className={styles.captureField}>
              <span>תדירות</span>
              <div className={styles.captureSegbar} role="radiogroup" aria-label="חזרתיות">
                {RECURRENCE_OPTIONS.map((option) => (
                  <button key={option.value} type="button" role="radio" aria-checked={recurrence === option.value} className={recurrence === option.value ? styles.captureSegOn : ""} onClick={() => setRecurrence(option.value)}>
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <CaptureField label="הערה">
              <textarea className={styles.captureInput} value={note} onChange={(event) => setNote(event.target.value)} placeholder="משהו שכדאי שאזכור?" />
            </CaptureField>
          </> : null}

          {kind === "installments" ? <>
            <div className={styles.captureTwoRow}>
              <CaptureField label="סכום כולל">
                <input className={styles.captureInput} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0 ₪" />
              </CaptureField>
              <CaptureField label="מספר תשלומים">
                <input className={styles.captureInput} inputMode="numeric" value={installmentCount} onChange={(event) => setInstallmentCount(event.target.value)} placeholder="3" />
              </CaptureField>
            </div>
            <CaptureDateInput label="תאריך ראשון" value={dueAt} fallback="בחר תשלום ראשון" inputRef={dateInputRef} onOpen={() => openDatePicker(dateInputRef)} onChange={setDueAt} />
            <section className={styles.captureSchedule} aria-label="לוח התשלומים">
              <strong>לוח התשלומים</strong>
              {scheduleRows.length > 0 ? scheduleRows.map((row) => (
                <div key={row.index} className={styles.captureScheduleRow}>
                  <span>{row.index + 1}/{installmentCountNumber}</span>
                  <b>{row.amount}</b>
                  <small>{row.date}</small>
                </div>
              )) : <p>אחרי סכום ותאריך ראשון אראה כאן את 1/{installmentCountNumber}, 2/{installmentCountNumber} וכן הלאה.</p>}
            </section>
          </> : null}

          {kind === "postdated-check" ? <>
            <div className={styles.captureTwoRow}>
              <CaptureField label="סכום">
                <input className={styles.captureInput} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0 ₪" />
              </CaptureField>
              <CaptureField label="מספר צ'ק">
                <input className={styles.captureInput} value={checkNumber} onChange={(event) => setCheckNumber(event.target.value)} placeholder="000000" />
              </CaptureField>
            </div>
            <CaptureDateInput label="תאריך פירעון" value={dueAt} fallback="בחר פירעון" inputRef={dateInputRef} onOpen={() => openDatePicker(dateInputRef)} onChange={setDueAt} />
            <div className={styles.captureCalmNote}>אזכיר לך יומיים לפני הפירעון לוודא שהחשבון מכוסה, כדי שיהיה לך זמן לטפל בזה ברוגע.</div>
          </> : null}

          {kind === "net-terms" ? <>
            <CaptureField label="סכום">
              <input className={styles.captureInput} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0 ₪" />
            </CaptureField>
            <CaptureDateInput label="תאריך חשבונית" value={invoiceDate} fallback="בחר תאריך חשבונית" inputRef={invoiceDateInputRef} onOpen={() => openDatePicker(invoiceDateInputRef)} onChange={setInvoiceDate} />
            <div className={styles.captureField}>
              <span>תנאי תשלום</span>
              <div className={styles.captureSegbar} role="radiogroup" aria-label="תנאי תשלום">
                {(["30", "60", "90"] as const).map((value) => (
                  <button key={value} type="button" role="radio" aria-checked={termsDays === value} className={termsDays === value ? styles.captureSegOn : ""} onClick={() => setTermsDays(value)}>
                    שוטף+{value}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.captureCalmNote}>{netDueDate ? "חישבתי: שוטף+" + termsDays + " יוצא לתשלום ב-" + netDueDate + ". אזכיר לך כמה ימים לפני." : "אחרי בחירת תאריך החשבונית אחשב את מועד התשלום בפועל."}</div>
          </> : null}

          {error ? <div className={styles.formError}>{error}</div> : null}
          <PrimaryButton type="submit" disabled={busy}>{busy ? "רגע…" : "מסור למזכירה"}</PrimaryButton>
        </form>
        </>}
      </section>
    </main>
  );
}

function CaptureField({ label, children }: { label: string; children: ReactNode }) {
  return <label className={styles.captureField}><span>{label}</span>{children}</label>;
}

function CaptureDateInput({ label, value, fallback, inputRef, onOpen, onChange }: { label: string; value: string; fallback: string; inputRef: MutableRefObject<HTMLInputElement | null>; onOpen: () => void; onChange: (value: string) => void }) {
  return (
    <CaptureField label={label}>
      <button type="button" className={[styles.captureInput, styles.captureDateButton].join(" ")} onClick={onOpen}>
        <span>{dateLabel(value, fallback)}</span>
        <CalendarIcon />
      </button>
      <input
        ref={inputRef}
        className={styles.captureDateNative}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        tabIndex={-1}
      />
    </CaptureField>
  );
}

function dateLabel(value: string, fallback: string): string {
  return value ? formatDateValue(new Date(value + "T09:00:00").toISOString()) : fallback;
}

function normalizeInstallmentCount(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 3;
  return Math.max(2, Math.min(24, n));
}

function buildInstallmentRows(amount: string, firstDate: string, count: number): Array<{ index: number; amount: string; date: string }> {
  const total = Number(amount);
  if (!Number.isFinite(total) || total <= 0 || !firstDate) return [];
  const first = new Date(firstDate + "T09:00:00");
  if (Number.isNaN(first.getTime())) return [];
  const each = total / count;
  return Array.from({ length: count }, (_, index) => {
    const date = addMonths(first, index);
    return { index, amount: formatMoneyValue(String(each), "ILS"), date: formatDateValue(date.toISOString()) };
  });
}

function netTermsDueDateValue(invoiceDate: string, days: number): Date | null {
  const invoice = new Date(invoiceDate + "T09:00:00");
  if (Number.isNaN(invoice.getTime())) return null;
  const endOfMonth = new Date(invoice.getFullYear(), invoice.getMonth() + 1, 0, 9, 0, 0);
  endOfMonth.setDate(endOfMonth.getDate() + days);
  return endOfMonth;
}

function calculateNetTermsDueDate(invoiceDate: string, days: number): string | null {
  const due = netTermsDueDateValue(invoiceDate, days);
  return due ? formatDateValue(due.toISOString()) : null;
}

function requiredMessageForKind(kind: CaptureKind): string {
  switch (kind) {
    case "installments":
      return "חסרים לי שם, סכום כולל, מספר תשלומים ותאריך ראשון כדי להציג פריסה מסודרת.";
    case "postdated-check":
      return "חסרים לי שם, סכום, מספר צ'ק ותאריך פירעון כדי לזכור את הצ'ק נכון.";
    case "net-terms":
      return "חסרים לי שם, סכום ותאריך חשבונית כדי לחשב את השוטף+.";
    case "regular":
    default:
      return "חסרים לי כמה פרטים כדי לזכור את ההתחייבות: למי, כמה ומתי.";
  }
}

function captureSayForKind(kind: CaptureKind): string {
  switch (kind) {
    case "installments":
      return "כמה תשלומים, ואני אראה את הלוח לפני שאזכור אותו.";
    case "postdated-check":
      return "אפשר למסור לי את פרטי הצ'ק, ואזכיר לך לפני יום הפירעון.";
    case "net-terms":
      return "אחרי מועד החשבונית אחשב את מועד התשלום.";
    case "regular":
    default:
      return "אפשר למסור לי את הפרטים ואני אזכור.";
  }
}


function UpdateScreen({ obligation, onUpdate }: { obligation: ObligationApi | null; onUpdate?: (id: number, input: UpdateObligationInput) => Promise<void> | void }) {
  const [name, setName] = useState(obligation?.obligeeName ?? "");
  const [amount, setAmount] = useState(obligation ? String(Math.round(amountNumber(obligation))) : "");
  const [date, setDate] = useState(obligation?.dueAt.slice(0, 10) ?? "");
  const [recurrence, setRecurrence] = useState<RecurrenceCadence>(obligation?.recurrence ?? "NONE");
  const [note, setNote] = useState(obligation?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!obligation) return <SecretaryScreen title="עריכת התחייבות" backHref={screenHref("all")}><EmptyMemory title="אין התחייבות לעריכה" body="עריכה תופיע רק אחרי שתהיה התחייבות אמיתית בזיכרון." /></SecretaryScreen>;
  const obligationId = obligation.id;

  // Build a patch of ONLY the fields the owner actually changed, then persist.
  // The success view is shown strictly after a successful save.
  async function save() {
    if (busy) return;
    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      setError("צריך שם כדי שאדע למי לשלם.");
      return;
    }
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0) {
      setError("צריך סכום חוקי כדי שאוכל לזכור אותו נכון.");
      return;
    }
    const parsed = new Date(date + "T09:00:00");
    if (!date || Number.isNaN(parsed.getTime())) {
      setError("צריך תאריך חוקי כדי שאוכל לזכור אותו נכון.");
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
      setError("עוד לא שינית שום פרט.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onUpdate?.(obligationId, patch);
      setDone(true);
    } catch {
      setError("לא הצלחתי לשמור עכשיו. אפשר לנסות שוב עוד רגע.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    // After a successful save the obligation prop already reflects the new
    // values, so the confirmation shows exactly what was persisted.
    const savedName = displayName(obligation.obligeeName);
    const savedAmount = formatMoneyValue(obligation.amount, obligation.currency);
    return (
      <SecretaryScreen title="עריכת התחייבות" backHref={screenHref("detail", obligationId)}>
        <section className={styles.sheetStage}>
          <div className={styles.sheetGrip} />
          <div className={styles.okHead}><span>✓</span><p>עדכנתי. מעכשיו אני זוכרת את {savedName}: {savedAmount} לתאריך {formatDateValue(obligation.dueAt)}.</p></div>
          <section className={styles.echoCard}><span>{emojiForObligation(obligation)}</span><div><strong>{savedName}</strong><small>{recurrenceText(obligation.recurrence)}</small></div><b>{savedAmount}</b></section>
          <PrimaryLink href={screenHref("detail", obligationId)}>סגור</PrimaryLink>
        </section>
      </SecretaryScreen>
    );
  }

  return (
    <SecretaryScreen title="עריכת התחייבות" backHref={screenHref("detail", obligationId)}>
      <section className={styles.sheetStage}>
        <div className={styles.sheetGrip} />
        <Say>אפשר לעדכן כל פרט — שם, סכום, תאריך חיוב או מחזוריות.</Say>
        <FormField label="למי משלמים"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="שם הספק או הגורם" /></FormField>
        <FormField label="סכום"><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0 ₪" /></FormField>
        <FormField label="תאריך חיוב"><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></FormField>
        <div className={styles.formField}>
          <span>מחזוריות</span>
          <div className={styles.captureSegbar} role="radiogroup" aria-label="מחזוריות">
            {RECURRENCE_OPTIONS.map((option) => (
              <button key={option.value} type="button" role="radio" aria-checked={recurrence === option.value} className={recurrence === option.value ? styles.captureSegOn : ""} onClick={() => setRecurrence(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <FormField label="הערה"><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="משהו שכדאי שאזכור?" /></FormField>
        {error ? <div className={styles.formError}>{error}</div> : null}
        <div className={styles.actions}>
          <PrimaryButton disabled={busy} onClick={() => void save()}>{busy ? "רגע…" : "שמירת שינויים"}</PrimaryButton>
          <GhostLink href={screenHref("detail", obligationId)}>ביטול</GhostLink>
        </div>
      </section>
    </SecretaryScreen>
  );
}

function FormField({ label, children }: { label: string; children: ReactNode }) { return <label className={styles.formField}><span>{label}</span>{children}</label>; }

const LOOP_TITLE: Record<SecretaryLoopMode, string> = {
  met: "טיפלנו בזה",
  snooze: "תזכורת",
  release: "הוסר",
  created: "נשמר",
};

function LoopsScreen({ obligation, initialMode = "met" }: { obligation: ObligationApi | null; initialMode?: SecretaryLoopMode }) {
  return <SecretaryScreen title={LOOP_TITLE[initialMode]} backHref={obligation ? screenHref("detail", obligation.id) : "/secretary"}><LoopResult mode={initialMode} obligation={obligation} /></SecretaryScreen>;
}

/** The due date of the next occurrence of a recurring obligation, or null. */
function nextOccurrenceLabel(iso: string, cadence: RecurrenceCadence): string | null {
  const base = dateValue(iso);
  if (!base) return null;
  switch (cadence) {
    case "WEEKLY": {
      const next = new Date(base);
      next.setDate(next.getDate() + 7);
      return formatDateValue(next.toISOString());
    }
    case "MONTHLY":
      return formatDateValue(addMonths(base, 1).toISOString());
    case "YEARLY":
      return formatDateValue(addMonths(base, 12).toISOString());
    case "NONE":
    default:
      return null;
  }
}

function reminderLeadDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "בזמן";
  date.setDate(date.getDate() - 2);
  return formatDateValue(date.toISOString());
}

function LoopResult({ mode, obligation }: { mode: "met" | "snooze" | "release" | "created"; obligation: ObligationApi | null }) {
  const name = obligation ? displayName(obligation.obligeeName) : "ההתחייבות";
  const amount = obligation ? formatMoneyValue(obligation.amount, obligation.currency) : "";
  const reminder = obligation ? reminderLeadDate(obligation.dueAt) : "בזמן";
  const nextDate = obligation ? nextOccurrenceLabel(obligation.dueAt, obligation.recurrence) : null;
  const config = mode === "met"
    ? { tone: "green", title: `סימנתי ש${name} טופל.`, body: obligation?.recurrence === "NONE" ? "סגרתי את זה ולא אזכיר שוב." : "רשמתי את התשלום הבא לפי החזרתיות. אין צורך לזכור אותו.", primary: "המשך לדבר הבא", secondary: "סגור" }
    : mode === "snooze"
      ? { tone: "calm", title: "בסדר, אזכיר לך שוב.", body: "עד אז זה יישאר במעקב שקט ולא ידרוש אותך.", primary: "סגור", secondary: undefined }
      : mode === "release"
        ? { tone: "neutral", title: "הבנתי. הסרתי את זה.", body: "לא אזכיר לך יותר על ההתחייבות הזאת. אפשר להוסיף אותה מחדש בכל רגע.", primary: "סגור", secondary: undefined }
        : { tone: "brand", title: "מצוין, אני זוכרת את זה עכשיו.", body: obligation ? `אזכיר לך על ${name} ב-${reminder} — יומיים לפני מועד התשלום.` : "אזכיר לך בזמן, בלי צורך לעקוב לבד.", primary: "הוסף עוד", secondary: "סיימתי" };
  const resultClass = [styles.loopResult, mode === "created" ? styles.loopResultCreated : ""].join(" ");
  const echoClass = [styles.echoCard, mode === "created" ? styles.echoCardCreated : ""].join(" ");
  const badgeClass = [styles.loopBadge, styles[`loopBadge_${config.tone}`]].join(" ");
  const echoMeta =
    mode === "created" ? `אזכיר: ${reminder}` :
    mode === "snooze" ? "אזכיר שוב בקרוב" :
    mode === "met" ? (nextDate ? `התשלום הבא: ${nextDate}` : "שולם ונסגר") :
    recurrenceText(obligation?.recurrence ?? "NONE");
  return <section className={resultClass}><div className={badgeClass}>✓</div><h2>{config.title}</h2><p>{config.body}</p>{obligation && mode !== "release" ? <section className={echoClass}><span>{emojiForObligation(obligation)}</span><div><strong>{name}</strong><small>{echoMeta}</small></div><b>{amount}</b></section> : null}<div className={styles.loopFoot}><PrimaryLink href={mode === "created" ? screenHref("capture") : "/secretary?today=1"}>{config.primary}</PrimaryLink>{config.secondary ? <GhostLink href="/secretary">{config.secondary}</GhostLink> : null}</div></section>;
}

function RemindScreen({ obligation, onSnooze }: { obligation: ObligationApi | null; onSnooze?: (id: number, followUpAt: string) => Promise<void> | void }) {
  const [choiceKey, setChoiceKey] = useState<string>("week");
  const [customDate, setCustomDate] = useState<string>("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateRef = useRef<HTMLInputElement | null>(null);
  if (!obligation) return <SecretaryScreen title="תזכורת" backHref={screenHref("all")}><EmptyMemory title="אין התחייבות לדחות" body="כשיהיה פריט אמיתי במעקב, אפשר יהיה לבחור מתי להזכיר שוב." /></SecretaryScreen>;
  const obligationId = obligation.id;
  const now = new Date();
  const presets = [
    { key: "tomorrow", label: "מחר בבוקר", date: atMorning(addDays(now, 1)) },
    { key: "week", label: "בעוד שבוע", date: atMorning(addDays(now, 7)) },
    { key: "month", label: "בעוד חודש", date: atMorning(addMonths(now, 1)) },
  ];
  const customValue = customDate ? atMorning(new Date(customDate + "T09:00:00")) : null;
  const minDate = toInputDate(addDays(now, 1));

  function resolveTarget(): Date | null {
    if (choiceKey === "custom") return customValue;
    const preset = presets.find((option) => option.key === choiceKey);
    return preset ? preset.date : null;
  }

  function openPicker() {
    const el = dateRef.current as (HTMLInputElement & { showPicker?: () => void }) | null;
    if (!el) return;
    if (typeof el.showPicker === "function") el.showPicker();
    else el.click();
  }

  async function submit() {
    if (busy) return;
    const target = resolveTarget();
    if (!target || Number.isNaN(target.getTime())) {
      setError("צריך לבחור מתי להזכיר.");
      return;
    }
    if (target.getTime() <= now.getTime()) {
      setError("צריך לבחור תאריך עתידי.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSnooze?.(obligationId, target.toISOString());
      setDone(true);
    } catch {
      setError("לא הצלחתי לשמור עכשיו. אפשר לנסות שוב עוד רגע.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const target = resolveTarget() ?? now;
    return <SecretaryScreen title="תזכורת" backHref={screenHref("detail", obligation.id)}><section className={styles.loopResult}><div className={`${styles.loopBadge} ${styles.loopBadge_calm}`}>⏱</div><h2>אזכיר לך ב-{formatDateValue(target.toISOString())} בבוקר.</h2><p>עד אז זה יישאר אצלי במעקב שקט. אין צורך לחשוב על זה - אני אחזור אליך.</p><PrimaryLink href="/secretary?today=1">סגור</PrimaryLink></section></SecretaryScreen>;
  }

  return (
    <SecretaryScreen title="תזכורת" backHref={screenHref("detail", obligation.id)}>
      <section className={styles.sheetStage}>
        <div className={styles.sheetGrip} />
        <Say>מתי שאזכיר לך שוב?</Say>
        <section className={styles.contextCard}>
          <span>{emojiForObligation(obligation)}</span>
          <div><strong>{displayName(obligation.obligeeName)}</strong><small>לתשלום ב-{formatDateValue(obligation.dueAt)}</small></div>
          <b>{formatMoneyValue(obligation.amount, obligation.currency)}</b>
        </section>
        <div className={styles.remindOptions}>
          {presets.map((option) => (
            <button key={option.key} type="button" className={`${styles.remindOption} ${choiceKey === option.key ? styles.remindOptionSelected : ""}`} onClick={() => { setChoiceKey(option.key); setError(null); }}>
              <span>⏱</span><strong>{option.label}</strong><em>{formatDateValue(option.date.toISOString())}</em><b />
            </button>
          ))}
          <button type="button" className={`${styles.remindOption} ${choiceKey === "custom" ? styles.remindOptionSelected : ""}`} onClick={openPicker}>
            <span>🔔</span><strong>בחר תאריך אחר</strong><em>{customValue ? formatDateValue(customValue.toISOString()) : "בחירת תאריך"}</em><b />
          </button>
          <input
            ref={dateRef}
            className={styles.captureDateNative}
            type="date"
            min={minDate}
            value={customDate}
            onChange={(event) => { const v = event.target.value; setCustomDate(v); if (v) { setChoiceKey("custom"); setError(null); } }}
            aria-label="בחירת תאריך לתזכורת"
            tabIndex={-1}
          />
        </div>
        {error ? <div className={styles.formError}>{error}</div> : null}
        <PrimaryButton disabled={busy} onClick={() => void submit()}>{busy ? "רגע…" : "אזכיר לי אז"}</PrimaryButton>
      </section>
    </SecretaryScreen>
  );
}

function WatchingScreen({ obligations }: { obligations: ObligationApi[] }) {
  const now = new Date();
  const weekEnd = new Date(now); weekEnd.setDate(now.getDate() + 7);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const week = obligations.filter((item) => { const due = dateValue(item.dueAt); return due && due <= weekEnd; }).length;
  const month = obligations.filter((item) => { const due = dateValue(item.dueAt); return due && due > weekEnd && due <= monthEnd; }).length;
  const far = Math.max(0, obligations.length - week - month);
  const allQuiet = obligations.length === 0 || week === 0;
  return <SecretaryScreen title="מה שאני שומרת" backHref="/secretary"><Say>{allQuiet ? "הכל רגוע כרגע. אני שומרת את הדברים הרחוקים ואחזיר אותם בזמן." : "הכל כאן, אצלי. שום דבר לא ידרוש אותך לפני הזמן - אני אזכיר לך בדיוק כשצריך."}</Say>{allQuiet ? <section className={styles.allQuiet}><div>✓</div><h2>הכל רגוע כרגע.</h2><p>אני שומרת {obligations.length} דברים - אף אחד מהם לא דחוף. תוכל לחזור לעיסוקים שלך.</p><b>כולם רחוקים · אזכיר לך לפני כל אחד</b></section> : <><section className={styles.watchPeace}><div className={styles.watchRing}><strong>{obligations.length}</strong><span>במעקב</span></div><p>אלה הדברים שאני שומרת בשבילך עכשיו, מסודרים לפי כמה שהם קרובים.</p></section><div className={styles.watchHorizons}><Horizon title="השבוע" subtitle="כולם עם תזכורת - אזכיר לך בזמן" count={String(week)} /><Horizon title="בהמשך החודש" subtitle="עוד רחוקים, אין מה לעשות עכשיו" count={String(month)} /><Horizon title="רחוק יותר" subtitle="אשמור אותם עד שיתקרבו" count={String(far)} /></div></>}<section className={styles.reassurePanel}><p>אתה לא צריך לעבור על זה. אני עושה את זה בשבילך.</p><GhostLink href={screenHref("all")}>לראות את הכל בפירוט</GhostLink></section></SecretaryScreen>;
}

function NotifyScreen({ obligations }: { obligations: ObligationApi[] }) {
  const [enabled, setEnabled] = useState(true);
  const [morning, setMorning] = useState(true);
  const [quiet, setQuiet] = useState(false);
  const sample = obligations[0] ?? null;
  return <SecretaryScreen title="התראות" backHref="/secretary"><section className={styles.notifyLock}><div className={styles.lockTime}>09:41</div><div className={styles.notificationCard}><span><PersonIcon /></span><div><strong>המזכירה שלך</strong><p>{sample ? `יש לי תזכורת על ${sample.obligeeName}.` : "אני אזכיר רק כשיש משהו שדורש אותך."}</p></div></div><div className={styles.notificationCardFaded} /></section><Say>כך אני אדבר איתך כשמשהו מתקרב. ההתראות נשארות תזכורת שקטה, לא רשימת משימות.</Say><section className={styles.settingsGroup}><SettingRow title="התראות מהמזכירה" detail="כשמשהו מתקרב או חוזר מתזכורת" on={enabled} onClick={() => setEnabled((value) => !value)} /><SettingRow title="סיכום בוקר" detail="רק אם יש משהו שדורש אותך" on={morning} onClick={() => setMorning((value) => !value)} /><SettingRow title="שעות שקטות" detail="לא להפריע בערב" on={quiet} onClick={() => setQuiet((value) => !value)} /></section><section className={styles.feedCard}><div className={styles.smallTitle}>מה תקבלי ממני</div>{obligations.slice(0, 3).map((item) => <div className={styles.feedRow} key={item.id}><span>{emojiForObligation(item)}</span><div><strong>{item.obligeeName}</strong><em>אזכיר לפני {formatDateValue(item.dueAt)}</em></div><small>בזמן</small></div>)}{obligations.length === 0 ? <p className={styles.emptyText}>אין כרגע התחייבויות להתראות. כשיהיו, אציג כאן דוגמאות מהזיכרון האמיתי.</p> : null}</section></SecretaryScreen>;
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

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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



