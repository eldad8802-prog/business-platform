import { Component, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { TaskForm } from "@/features/tasks/task-form";
import { useFeatureEnabled } from "@/lib/ui/use-feature-enabled";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TOKEN } from "@/lib/design/tokens";
import BackButton from "@/components/ui/back-button";
import type {
  CreateObligationInput,
  ObligationApi,
  RecurrenceCadence,
  UpdateObligationInput,
} from "@/lib/obligations/secretary-client";
import styles from "./secretary.module.css";
import {
  ConfirmDialog,
  Money,
  Notice,
  ObligationRow,
  RowList,
  StatusChip,
  ButtonLink,
  hebrewErrorMessage,
} from "@/components/finance-ui";
import { useAccessibleDialog } from "@/components/ui/use-accessible-dialog";
import type { HomeRow } from "./secretary-home-model";

export type TodayState = "critical" | "busy" | "calm";

export type SecretaryLoopMode = "met" | "snooze" | "release" | "created";

export type SecretaryScreenName =
  | "bank"
  | "all"
  | "detail"
  | "update"
  | "capture"
  | "loops"
  | "remind"
  | "watching";

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
  { value: "BIMONTHLY", label: "כל חודשיים" },
  { value: "QUARTERLY", label: "כל רבעון" },
  { value: "SEMIANNUAL", label: "כל חצי שנה" },
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
  /** The server's decimal string (remaining when ledger-backed). */
  amount: string;
  amountCaption?: string;
  currency?: string;
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
  /** Every other item that needs the owner, after the focus. */
  others?: HomeRow[];
  watching: {
    line: string;
    subline: string;
  };
  showCapture?: boolean;
};

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
 * Back to the screen the user actually came from (verified navigation trail —
 * a detail reached from "today" returns to "today"). Only when there is no
 * verified origin (deep link, new tab) does it open the declared secretary
 * fallback, labelled with its destination.
 */
function BackControl({ fallbackHref }: { fallbackHref: string }) {
  return <BackButton fallback={fallbackHref} fallbackLabel={secretaryFallbackLabel(fallbackHref)} />;
}

function secretaryFallbackLabel(href: string): string {
  if (href.includes("screen=detail")) return "לפרטי ההתחייבות";
  if (href.includes("screen=all")) return "לכל ההתחייבויות";
  return "למזכירה";
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
      <div className={styles.focusAmount}>
        <Money amount={focus.amount} currency={focus.currency} />
        {focus.amountCaption ? <small style={{ fontSize: 13, fontWeight: 500, marginInlineStart: 8 }}>{focus.amountCaption}</small> : null}
      </div>
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
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={styles.actions}>
      <button
        className={`${styles.button} ${styles.primary}`}
        type="button"
        disabled={busy}
        onClick={async () => {
          if (!onComplete || busy) return;
          setBusy(true);
          setError(null);
          try {
            await onComplete();
          } catch (e) {
            setError(hebrewErrorMessage(e, "לא הצלחנו לסמן שטופל. שום דבר לא השתנה, ואפשר לנסות שוב."));
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
      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
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
          למסור למזכירה תשלום נוסף
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
          {model.others && model.others.length > 0 ? (
            <section aria-labelledby="today-others" style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <h2 id="today-others" style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                {model.others.length === 1 ? "ועוד אחד שדורש טיפול" : `ועוד ${model.others.length} שדורשים טיפול`}
              </h2>
              <RowList ariaLabelledBy="today-others">
                {model.others.map((row) => (
                  <ObligationRow
                    key={row.obligation.id}
                    title={row.name}
                    href={screenHref("detail", row.obligation.id)}
                    chips={<StatusChip status={{ domain: "secretary", state: row.status }} />}
                    meta={`${row.cadence} · ${formatDateValue(row.obligation.dueAt)}`}
                    amount={{ value: row.amount, currency: row.obligation.currency, caption: row.amountCaption ?? undefined }}
                  />
                ))}
              </RowList>
            </section>
          ) : null}
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
    case "BIMONTHLY": return "כל חודשיים";
    case "QUARTERLY": return "כל רבעון";
    case "SEMIANNUAL": return "כל חצי שנה";
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
  /** The result follows a recorded payment ("שילמתי"), not a handled-only mark. */
  paidRecorded?: boolean;
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

export function SecretaryFlowScreen({ screen, obligations, selectedId, loopMode, paidRecorded = false, prefillName, obligationsLoading = false, obligationsHasMore = false, onLoadMore, onCreate, onCreateMany, onUpdate, onComplete, onSnooze, onRelease }: SecretaryFlowScreenProps) {
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
    case "loops": return <LoopsScreen obligation={selected} initialMode={loopMode ?? "met"} paidRecorded={paidRecorded} />;
    case "remind": return <RemindScreen obligation={selected} onSnooze={onSnooze} />;
    case "watching": return <WatchingScreen obligations={openItems} />;
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
      <PrimaryLink href="/secretary">סיימתי, חזרה למזכירה</PrimaryLink>
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
        <span>{done ? `טופל ב-${formatDateValue(item.metAt ?? item.updatedAt)}` : <><StatusPill tone={tone}>{shortDueLabel(item)}</StatusPill>{recurrenceText(item.recurrence)}</>}</span>
      </span>
      <b>{formatMoneyValue(item.amount, item.currency)}</b>
    </button>
  );
}

function StatusPill({ tone, children }: { tone: ObligationCard["tone"] | "purple"; children: ReactNode }) {
  const toneClass = tone === "urgent" ? styles.statusPillUrgent : tone === "soon" ? styles.statusPillSoon : tone === "calm" ? styles.statusPillCalm : tone === "purple" ? styles.statusPillPurple : styles.statusPillNeutral;
  return <em className={`${styles.statusPill} ${toneClass}`}>{children}</em>;
}

function AllObligationsScreen({ obligations, loadMore }: { obligations: ObligationApi[]; loadMore?: ReactNode }) {
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
      <div className={styles.oblDesk}>
        <div>
          {obligations.length > 0 ? (
            <>
              <TimelineGroup title={`השבוע · ${thisWeek.length} התחייבויות`} items={thisWeek} empty="אין התחייבויות לשבוע הקרוב." selectedId={selected?.id} onSelect={setPickedId} />
              <TimelineGroup title={`בהמשך · ${later.length}`} items={later} empty="אין עוד התחייבויות פתוחות בהמשך." selectedId={selected?.id} onSelect={setPickedId} />
              <TimelineGroup title={`שהושלמו החודש · ${doneThisMonth.length}`} items={doneThisMonth} empty="עוד לא סומנה התחייבות שטופלה החודש." selectedId={selected?.id} onSelect={setPickedId} />
            </>
          ) : <EmptyMemory title="אין עדיין התחייבויות פתוחות" body="היומן ריק כרגע. אפשר למסור לי התחייבות ראשונה ואשמור אותה בשבילך." />}
          <div className={styles.calendarHead}><h3>היומן שלי · {monthLabel(now)}</h3><Link href="/secretary?today=1">היום</Link></div>
          <CalendarMonth obligations={monthItems} />
          <div className={styles.calendarLegend} aria-hidden="true">
            <span><i className={styles.calendarDotUrgent} />באיחור</span>
            <span><i className={styles.calendarDotSoon} />השבוע</span>
            <span><i className={styles.calendarDotCalm} />בהמשך</span>
            <span><b className={styles.calendarTodayKey} />היום</span>
          </div>
          {loadMore}
          <PrimaryLink href={screenHref("capture")}>למסור לי עוד התחייבות</PrimaryLink>
        </div>
        <aside className={styles.oblInspect} aria-label="ההתחייבות שנבחרה">
          {selected ? (
            <>
              <DetailMemoryCard obligation={selected} />
              {selected.note ? <p className={styles.inspectNote}>{selected.note}</p> : null}
              <HistoryCard obligation={selected} obligations={obligations} />
              <p className={styles.inspectNote}>הזיכרון נשאר אצל המזכירה. רישום תשלום נמצא ב<Link href="/payables">התחייבויות</Link>. סימון כטופל אינו תשלום.</p>
              <PrimaryLink href={screenHref("detail", selected.id)}>הפעולה הבאה</PrimaryLink>
            </>
          ) : (
            <p className={styles.inspectNote}>בחרו שורה כדי לראות למי, כמה, ומתי. הטיפול עצמו נשאר במסך של ההתחייבות.</p>
          )}
        </aside>
      </div>
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
  // Items of the same series the owner marked handled. A handled mark is not a
  // payment record — payments live in Payables — so the card says "סומן".
  const history = obligations.filter((item) => item.state === "MET" && item.id !== obligation.id && ((item.recurrenceSeriesId && item.recurrenceSeriesId === obligation.recurrenceSeriesId) || item.obligeeName === obligation.obligeeName)).slice(0, 3);
  if (obligation.state === "MET") history.unshift(obligation);
  return (
    <section className={styles.historyCard}>
      <div className={styles.historyTitle}>מה שכבר סומן כטופל</div>
      {history.length > 0 ? history.map((item) => <div className={styles.historyRow} key={item.id}><span>✓</span><strong>סומן כטופל ב-{formatDateValue(item.metAt ?? item.updatedAt)}</strong><b><Money amount={item.amount} currency={item.currency} /></b></div>) : <p>עוד לא סומן כטופל אף מועד של ההתחייבות הזאת.</p>}
    </section>
  );
}

/**
 * Remove ("כבר לא רלוונטי"): always behind an explicit confirmation dialog with
 * progress, and a failure is said in Hebrew inside the dialog — never silent.
 * Reused by the detail screen and the today focus.
 */
function ReleaseControl({ onRelease, disabled }: { onRelease?: () => Promise<void> | void; disabled?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (!onRelease) return null;
  return (
    <>
      <button type="button" className={`${styles.button} ${styles.ghostWide}`} disabled={disabled} onClick={() => setConfirming(true)}>
        כבר לא רלוונטי
      </button>
      <ConfirmDialog
        open={confirming}
        title="להסיר את ההתחייבות מהמעקב?"
        body="היא לא תופיע יותר במזכירה. תשלומים שכבר נרשמו לא משתנים, ואפשר למסור אותה מחדש בכל רגע."
        confirmLabel="כן, להסיר"
        cancelLabel="לא, להשאיר"
        translateError={hebrewErrorMessage}
        errorFallback="לא הצלחנו להסיר. ההתחייבות נשארה במעקב, ואפשר לנסות שוב."
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await onRelease();
          setConfirming(false);
        }}
      />
    </>
  );
}

function DetailScreen({ obligation, obligations, onComplete, onRelease }: { obligation: ObligationApi | null; obligations: ObligationApi[]; onComplete?: FlowAction; onRelease?: FlowAction }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action?: FlowAction) {
    if (!obligation || !action || busy) return;
    setBusy(true);
    setError(null);
    try {
      await action(obligation.id);
    } catch (e) {
      setError(hebrewErrorMessage(e, "הפעולה לא הצליחה. שום דבר לא השתנה, ואפשר לנסות שוב."));
    } finally {
      setBusy(false);
    }
  }
  if (!obligation) return <SecretaryScreen title="התחייבות" backHref={screenHref("all")}><EmptyMemory title="אין התחייבות לבחור" body="ברגע שתהיה התחייבות אמיתית, הפרטים שלה יופיעו כאן." /><PrimaryLink href={screenHref("capture")}>למסור התחייבות ראשונה</PrimaryLink></SecretaryScreen>;
  const name = displayName(obligation.obligeeName);
  const tone = obligation.state === "MET" ? "calm" : isInstallmentObligation(obligation) ? "purple" : obligationTone(obligation);
  const isMet = obligation.state === "MET";
  const isInstallment = isInstallmentObligation(obligation);
  const ledger = obligation.ledger ?? null;
  const owesSomething = Boolean(ledger && Number(ledger.remaining) > 0);
  const metaText = isMet
    ? (obligation.recurrence === "NONE" ? "נסגר במזכירה" : "המועד הבא נוצר לפי " + recurrenceText(obligation.recurrence))
    : isInstallment
      ? "פריסת תשלומים במעקב"
      : "לתשלום ב-" + formatDateValue(obligation.dueAt);
  const say = isMet
    ? owesSomething
      ? "סומן כטופל, אבל בהתחייבויות לא נרשם תשלום מלא. הסכום שנותר מופיע כאן למטה."
      : "סומן כטופל. אין צורך לזכור אותו שוב."
    : isInstallment
      ? "זה תשלום אחד מתוך פריסה שאני שומרת עבורך."
      : "זה מה שאני זוכרת על ההתחייבות הזאת.";
  return (
    <SecretaryScreen title={name} backHref={screenHref("all")}>
      <div className={styles.detailDesk}>
        <div>
          <section className={[styles.detailObjectHead, isMet ? styles.detailObjectDone : ""].join(" ")}>
            <div className={styles.detailObjectTile}>{emojiForObligation(obligation)}</div>
            <div className={styles.detailObjectInfo}>
              <strong>{name}</strong>
              <b>
                <Money amount={ledger ? ledger.remaining : obligation.amount} currency={obligation.currency} />
                {ledger ? <small style={{ fontSize: 13, fontWeight: 500, marginInlineStart: 6 }}>נותר</small> : null}
              </b>
            </div>
          </section>
          <div className={styles.detailMetaLine}>
            <StatusPill tone={tone}>{isMet ? "סומן כטופל" : isInstallment ? "פריסת תשלומים" : shortDueLabel(obligation)}</StatusPill>
            <span>{metaText}</span>
          </div>
          <Say>{say}</Say>
          <DetailMemoryCard obligation={obligation} />
          {ledger ? (
            <section className={styles.memoryDetailCard} aria-label="מצב התשלום">
              <div className={styles.memoryDetailRow}><span>₪</span><small>לתשלום במועד הזה</small><strong><Money amount={obligation.amount} currency={obligation.currency} /></strong></div>
              <div className={styles.memoryDetailRow}><span>✓</span><small>שולם</small><strong><Money amount={ledger.paid} currency={obligation.currency} /></strong></div>
              <div className={styles.memoryDetailRow}><span>•</span><small>נותר</small><strong><Money amount={ledger.remaining} currency={obligation.currency} /></strong></div>
            </section>
          ) : null}
          {obligation.note ? <p className={styles.inspectNote}>{obligation.note}</p> : null}
        </div>
        <div>
          <HistoryCard obligation={obligation} obligations={obligations} />
          <p className={styles.inspectNote}>סימון כטופל סוגר את התזכורת ואינו רושם תשלום. תשלומים נרשמים בהתחייבויות.</p>
          <div className={styles.actions}>
            {!isMet ? <PrimaryButton disabled={busy} onClick={() => void run(onComplete)}>{busy ? "רגע…" : owesSomething ? "שילמתי / טופל" : "סמן שטופל"}</PrimaryButton> : null}
            <div className={styles.ghosts}>
              {ledger ? <GhostLink href={"/payables/" + ledger.commitmentId}>פתיחה בהתחייבויות</GhostLink> : null}
              {!isMet ? <GhostLink href={screenHref("remind", obligation.id)}>להזכיר לי אחר כך</GhostLink> : null}
              <GhostLink href={screenHref("update", obligation.id)}>עריכת התחייבות</GhostLink>
            </div>
            {!isMet ? <ReleaseControl disabled={busy} onRelease={onRelease ? () => onRelease(obligation.id) : undefined} /> : null}
            {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
          </div>
        </div>
      </div>
    </SecretaryScreen>
  );
}

function CaptureScreen({ obligations, onCreate, onCreateMany, prefillName }: { obligations: ObligationApi[]; onCreate?: (input: CreateObligationInput) => Promise<ObligationApi | void>; onCreateMany?: (inputs: CreateObligationInput[]) => Promise<ObligationApi[]>; prefillName?: string }) {
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
  // Closing returns to wherever the owner opened it from (home, bank, Today);
  // a deep link with no history falls back to the Secretary home.
  const router = useRouter();
  const closeSheet = () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.replace("/secretary");
  };
  // A real modal: focus moves in and is trapped, Escape closes, and the page
  // behind is scroll-locked (the shared accessible-dialog contract).
  const sheetRef = useAccessibleDialog<HTMLElement>({ isOpen: true, onClose: closeSheet });
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
      {/* A plain dimmed ground. The old blurred copy of the bank screen held
          real links behind an aria-hidden layer; nothing interactive sits here. */}
      <div className={styles.captureDim} aria-hidden="true" onClick={closeSheet} style={{ pointerEvents: "auto" }} />
      <section ref={sheetRef} className={styles.captureSheet} role="dialog" aria-modal="true" aria-label="מסירה למזכירה" tabIndex={-1}>
        <div className={styles.sheetGrip} />
        <button type="button" onClick={closeSheet} className={styles.captureClose} aria-label="סגירה">×</button>
        {taskMode ? (
          taskSaved ? (
            <section style={{ display: "flex", flexDirection: "column", gap: 12, padding: "8px 4px" }}>
              <Say>רשמתי. המשימה מחכה לך ב&quot;היום שלי&quot;.</Say>
              <div className={styles.loopFoot}>
                <PrimaryLink href="/secretary?today=1">להיום שלי</PrimaryLink>
                <GhostLink href="/tasks">כל המשימות</GhostLink>
              </div>
            </section>
          ) : (
            <div style={{ padding: "8px 4px 16px" }}>
              <TaskForm origin="SECRETARY" onDone={() => setTaskSaved(true)} onCancel={() => setTaskMode(false)} />
            </div>
          )
        ) : created ? (
          <LoopResult mode="created" obligation={created} />
        ) : <>
        <div className={styles.topbar}>
          <div className={styles.topSpacer} />
          <div className={styles.topTitle}>{selectedKind.title}</div>
          <div className={styles.topSpacer} />
        </div>
        <Say>{captureSayForKind(kind)}</Say>
        <div className={styles.captureTypeList} aria-label="סוג התחייבות">
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
                <strong>משימה</strong>
                <small>משהו לעשות, בלי סכום — נכנס לסדר היום</small>
              </span>
            </button>
          ) : null}
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
            <CaptureDateInput label="מתי לתשלום" value={dueAt} fallback="בחר תאריך" onChange={setDueAt} />
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
            <CaptureDateInput label="תאריך ראשון" value={dueAt} fallback="בחר תשלום ראשון" onChange={setDueAt} />
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
            <CaptureDateInput label="תאריך פירעון" value={dueAt} fallback="בחר פירעון" onChange={setDueAt} />
            <div className={styles.captureCalmNote}>הצ׳ק יופיע ב&quot;דורש טיפול&quot; שבוע לפני תאריך הפירעון, כדי שיהיה זמן לוודא שהחשבון מכוסה. לא נשלחת התראה.</div>
          </> : null}

          {kind === "net-terms" ? <>
            <CaptureField label="סכום">
              <input className={styles.captureInput} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0 ₪" />
            </CaptureField>
            <CaptureDateInput label="תאריך חשבונית" value={invoiceDate} fallback="בחר תאריך חשבונית" onChange={setInvoiceDate} />
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
            <div className={styles.captureCalmNote}>{netDueDate ? "חישבתי: שוטף+" + termsDays + " יוצא לתשלום ב-" + netDueDate + ". הוא יופיע ב\"דורש טיפול\" שבוע לפני." : "אחרי בחירת תאריך החשבונית אחשב את מועד התשלום בפועל."}</div>
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

function CaptureDateInput({ label, value, fallback, onChange }: { label: string; value: string; fallback: string; onChange: (value: string) => void }) {
  // The native date input sits as a full-size transparent overlay above the
  // styled display, so a tap on the field opens the OS date picker natively
  // (the reliable, cross-browser behaviour used elsewhere in the app) instead
  // of depending on showPicker() against a hidden input.
  return (
    <CaptureField label={label}>
      <div className={styles.captureDateField}>
        <div className={[styles.captureInput, styles.captureDateButton].join(" ")} aria-hidden="true">
          <span>{dateLabel(value, fallback)}</span>
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
      return "אפשר למסור לי את פרטי הצ'ק, ואציג אותו לפני יום הפירעון.";
    case "net-terms":
      return "אחרי מועד החשבונית אחשב את מועד התשלום.";
    case "regular":
    default:
      return "אפשר למסור לי את הפרטים ואני אזכור.";
  }
}


function UpdateScreen({ obligation, onUpdate }: { obligation: ObligationApi | null; onUpdate?: (id: number, input: UpdateObligationInput) => Promise<void> | void }) {
  const [name, setName] = useState(obligation?.obligeeName ?? "");
  // The exact server value ("15.50" stays 15.50; "3500.00" shows as 3500).
  // Rounding here once turned an untouched 15.50 into a saved 16.
  const [amount, setAmount] = useState(obligation ? obligation.amount.replace(/\.00$/, "") : "");
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

function LoopsScreen({ obligation, initialMode = "met", paidRecorded = false }: { obligation: ObligationApi | null; initialMode?: SecretaryLoopMode; paidRecorded?: boolean }) {
  return <SecretaryScreen title={LOOP_TITLE[initialMode]} backHref={obligation ? screenHref("detail", obligation.id) : "/secretary"}><LoopResult mode={initialMode} obligation={obligation} paidRecorded={paidRecorded} /></SecretaryScreen>;
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
    case "BIMONTHLY":
      return formatDateValue(addMonths(base, 2).toISOString());
    case "QUARTERLY":
      return formatDateValue(addMonths(base, 3).toISOString());
    case "SEMIANNUAL":
      return formatDateValue(addMonths(base, 6).toISOString());
    case "YEARLY":
      return formatDateValue(addMonths(base, 12).toISOString());
    case "NONE":
    default:
      return null;
  }
}

/**
 * When an item enters "דורש טיפול": the briefing's attention window is 7 days
 * before the due date (obligation-core DEFAULT_ATTENTION_WINDOW_DAYS). There is
 * no notification — the item appears in the Secretary.
 */
function attentionFromLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "שבוע לפני המועד";
  date.setDate(date.getDate() - 7);
  if (date.getTime() <= Date.now()) return "כבר עכשיו";
  return "מ־" + formatDateValue(date.toISOString());
}

function LoopResult({ mode, obligation, paidRecorded = false }: { mode: "met" | "snooze" | "release" | "created"; obligation: ObligationApi | null; paidRecorded?: boolean }) {
  const name = obligation ? displayName(obligation.obligeeName) : "ההתחייבות";
  const appearsFrom = obligation ? attentionFromLabel(obligation.dueAt) : "שבוע לפני המועד";
  const nextDate = obligation ? nextOccurrenceLabel(obligation.dueAt, obligation.recurrence) : null;
  const recurring = obligation ? obligation.recurrence !== "NONE" : false;
  const config = mode === "met"
    ? {
        tone: "green",
        title: paidRecorded ? `התשלום ל${name} נרשם.` : `סימנתי ש${name} טופל.`,
        body: paidRecorded
          ? "התשלום נשמר בהתחייבויות, והתזכורת במזכירה נסגרה." + (recurring ? " המועד הבא כבר במעקב." : "")
          : "התזכורת נסגרה. לא נרשם תשלום — אם הכסף יצא, אפשר לרשום אותו בהתחייבויות." + (recurring ? " המועד הבא כבר במעקב." : ""),
        primary: "חזרה למזכירה",
        secondary: undefined as string | undefined,
      }
    : mode === "snooze"
      ? { tone: "calm", title: "נדחה.", body: "עד התאריך שבחרת זה לא יופיע ב\"דורש טיפול\".", primary: "חזרה למזכירה", secondary: undefined }
      : mode === "release"
        ? { tone: "neutral", title: "הוסר מהמעקב.", body: "ההתחייבות לא תופיע יותר במזכירה. תשלומים שכבר נרשמו לא השתנו, ואפשר למסור אותה מחדש בכל רגע.", primary: "חזרה למזכירה", secondary: undefined }
        : {
            tone: "brand",
            title: "שמרתי. היא במעקב עכשיו.",
            body: obligation
              ? `${name} תופיע ב"דורש טיפול" ${appearsFrom === "כבר עכשיו" ? "כבר עכשיו" : appearsFrom + ", שבוע לפני מועד התשלום"}. לא נשלחת התראה; את הרשימה רואים במזכירה.`
              : "ההתחייבות תופיע ב\"דורש טיפול\" שבוע לפני מועד התשלום.",
            primary: "מסירת תשלום נוסף",
            secondary: "סיימתי",
          };
  const resultClass = [styles.loopResult, mode === "created" ? styles.loopResultCreated : ""].join(" ");
  const echoClass = [styles.echoCard, mode === "created" ? styles.echoCardCreated : ""].join(" ");
  const badgeClass = [styles.loopBadge, styles[`loopBadge_${config.tone}`]].join(" ");
  const echoMeta =
    mode === "created" ? `ב"דורש טיפול": ${appearsFrom}` :
    mode === "snooze" ? "נדחה" :
    mode === "met" ? (nextDate ? `המועד הבא: ${nextDate}` : paidRecorded ? "שולם ונסגר" : "סומן כטופל") :
    recurrenceText(obligation?.recurrence ?? "NONE");
  return (
    <section className={resultClass}>
      <div className={badgeClass}>✓</div>
      <h2>{config.title}</h2>
      <p>{config.body}</p>
      {obligation && mode !== "release" ? (
        <section className={echoClass}>
          <span>{emojiForObligation(obligation)}</span>
          <div><strong>{name}</strong><small>{echoMeta}</small></div>
          <b><Money amount={obligation.amount} currency={obligation.currency} /></b>
        </section>
      ) : null}
      <div className={styles.loopFoot}>
        <PrimaryLink href={mode === "created" ? screenHref("capture") : "/secretary"}>{config.primary}</PrimaryLink>
        {config.secondary ? <GhostLink href="/secretary">{config.secondary}</GhostLink> : null}
        {mode === "met" && !paidRecorded && obligation?.ledger ? <GhostLink href={"/payables/" + obligation.ledger.commitmentId}>רישום תשלום בהתחייבויות</GhostLink> : null}
      </div>
    </section>
  );
}

/**
 * "להזכיר לי אחר כך" = snooze (followUpAt). What it really does: the item
 * leaves "דורש טיפול" until the chosen day and comes back then. No message is
 * sent. An item whose due date already arrived stays in "דורש טיפול" anyway —
 * the server never hides a today-or-overdue payment — and the screen says so.
 */
function RemindScreen({ obligation, onSnooze }: { obligation: ObligationApi | null; onSnooze?: (id: number, followUpAt: string) => Promise<void> | void }) {
  const [choiceKey, setChoiceKey] = useState<string>("week");
  const [customDate, setCustomDate] = useState<string>("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!obligation) return <SecretaryScreen title="להזכיר אחר כך" backHref={screenHref("all")}><EmptyMemory title="אין התחייבות לדחות" body="כשיהיה פריט אמיתי במעקב, אפשר יהיה לבחור מתי להחזיר אותו לרשימה." /></SecretaryScreen>;
  const obligationId = obligation.id;
  const now = new Date();
  const dueArrived = (dueDaysFromNow(obligation) ?? 1) <= 0;
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

  async function submit() {
    if (busy) return;
    const target = resolveTarget();
    if (!target || Number.isNaN(target.getTime())) {
      setError("צריך לבחור מתי להחזיר את זה לרשימה.");
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
    } catch (e) {
      setError(hebrewErrorMessage(e, "לא הצלחתי לשמור עכשיו. אפשר לנסות שוב עוד רגע."));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const target = resolveTarget() ?? now;
    return (
      <SecretaryScreen title="להזכיר אחר כך" backHref={screenHref("detail", obligation.id)}>
        <section className={styles.loopResult}>
          <div className={`${styles.loopBadge} ${styles.loopBadge_calm}`}>⏱</div>
          <h2>{dueArrived ? "נשמר." : `עד ${formatDateValue(target.toISOString())} זה לא יופיע ב"דורש טיפול".`}</h2>
          <p>
            {dueArrived
              ? "מועד התשלום כבר הגיע, ולכן הוא נשאר ב\"דורש טיפול\" עד שיטופל."
              : `ב־${formatDateValue(target.toISOString())} זה יחזור לרשימה במזכירה. לא נשלחת התראה.`}
          </p>
          <PrimaryLink href="/secretary">חזרה למזכירה</PrimaryLink>
        </section>
      </SecretaryScreen>
    );
  }

  return (
    <SecretaryScreen title="להזכיר אחר כך" backHref={screenHref("detail", obligation.id)}>
      <section className={styles.sheetStage}>
        <div className={styles.sheetGrip} />
        <Say>מתי להחזיר את זה לרשימת &quot;דורש טיפול&quot;?</Say>
        <section className={styles.contextCard}>
          <span>{emojiForObligation(obligation)}</span>
          <div><strong>{displayName(obligation.obligeeName)}</strong><small>לתשלום ב-{formatDateValue(obligation.dueAt)}</small></div>
          <b><Money amount={obligation.ledger ? obligation.ledger.remaining : obligation.amount} currency={obligation.currency} /></b>
        </section>
        {dueArrived ? (
          <Notice tone="warning">מועד התשלום כבר הגיע, ולכן הפריט יישאר ב&quot;דורש טיפול&quot; גם אחרי הדחייה. הדחייה תשפיע רק אם המועד ישתנה.</Notice>
        ) : (
          <Notice tone="neutral">עד התאריך שנבחר, הפריט לא יופיע ב&quot;דורש טיפול&quot;. באותו בוקר הוא יחזור לרשימה. לא נשלחת התראה.</Notice>
        )}
        <div className={styles.remindOptions}>
          {presets.map((option) => (
            <button key={option.key} type="button" className={`${styles.remindOption} ${choiceKey === option.key ? styles.remindOptionSelected : ""}`} aria-pressed={choiceKey === option.key} onClick={() => { setChoiceKey(option.key); setError(null); }}>
              <span>⏱</span><strong>{option.label}</strong><em>{formatDateValue(option.date.toISOString())}</em><b />
            </button>
          ))}
          <label className={`${styles.remindOption} ${choiceKey === "custom" ? styles.remindOptionSelected : ""}`}>
            <span>📅</span><strong>תאריך אחר</strong><em>{customValue ? formatDateValue(customValue.toISOString()) : "בחירת תאריך"}</em><b />
            <input
              className={styles.captureDateOverlay}
              type="date"
              min={minDate}
              value={customDate}
              onChange={(event) => { const v = event.target.value; setCustomDate(v); if (v) { setChoiceKey("custom"); setError(null); } }}
              aria-label="בחירת תאריך"
            />
          </label>
        </div>
        {error ? <div className={styles.formError} role="alert">{error}</div> : null}
        <PrimaryButton disabled={busy} onClick={() => void submit()}>{busy ? "רגע…" : "שמירה"}</PrimaryButton>
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
  return <SecretaryScreen title="מה שאני שומרת" backHref="/secretary"><Say>{allQuiet ? "הכול רגוע כרגע. כל התחייבות תופיע ב\"דורש טיפול\" שבוע לפני המועד שלה." : "הכול שמור כאן. כל התחייבות עוברת ל\"דורש טיפול\" שבוע לפני המועד שלה. לא נשלחת התראה, את הרשימה רואים במזכירה."}</Say>{allQuiet ? <section className={styles.allQuiet}><div>✓</div><h2>הכול רגוע כרגע.</h2><p>{obligations.length === 1 ? "התחייבות אחת במעקב" : `${obligations.length} התחייבויות במעקב`}, ואף אחת מהן לא בשבוע הקרוב.</p><b>כל אחת תופיע במזכירה שבוע לפני המועד</b></section> : <><section className={styles.watchPeace}><div className={styles.watchRing}><strong>{obligations.length}</strong><span>במעקב</span></div><p>אלה הדברים שאני שומרת בשבילך עכשיו, מסודרים לפי כמה שהם קרובים.</p></section><div className={styles.watchHorizons}><Horizon title="השבוע" subtitle={"כבר מופיעים ב\"דורש טיפול\""} count={String(week)} /><Horizon title="בהמשך החודש" subtitle="יופיעו שבוע לפני המועד" count={String(month)} /><Horizon title="רחוק יותר" subtitle="נשמרים במעקב עד שיתקרבו" count={String(far)} /></div></>}<section className={styles.reassurePanel}><p>אין צורך לעבור על הרשימה הזאת כל יום. מה שמתקרב מופיע בעמוד הראשי של המזכירה.</p><GhostLink href={screenHref("all")}>לכל ההתחייבויות</GhostLink></section></SecretaryScreen>;
}

function Horizon({ title, subtitle, count }: { title: string; subtitle: string; count: string }) { return <div className={styles.horizon}><EyeIcon /><span><strong>{title}</strong><em>{subtitle}</em></span><b>{count}</b></div>; }
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




