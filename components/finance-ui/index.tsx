"use client";

/**
 * finance-ui — the shared components of the Secretary ("המזכירה שלי") and
 * Payables ("התחייבויות"). Both areas render the same row, chip, amount,
 * summary, dialog and action menu, so the same fact looks the same everywhere.
 *
 * Presentation only. Nothing here fetches, derives a status, or computes a
 * money figure: callers pass the server's values and this module draws them.
 */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import { formatAmount } from "./format";
import { statusLabel, statusTone, type StatusKey, type StatusTone } from "./status";
import s from "./finance-ui.module.css";

export * from "./format";
export * from "./status";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/* ─────────────────────────────── Button ──────────────────────────────────── */

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

type ButtonLook = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  iconOnly?: boolean;
  className?: string;
};

function buttonClass({ variant = "secondary", size = "md", block, iconOnly, className }: ButtonLook) {
  return cx(s.btn, s[variant], size !== "md" && s[size], block && s.block, iconOnly && s.iconOnly, className);
}

export function Button({
  children,
  onClick,
  type = "button",
  disabled,
  busy,
  busyLabel = "רגע…",
  ariaLabel,
  ...look
}: ButtonLook & {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type={type}
      className={buttonClass(look)}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
    >
      {busy ? busyLabel : children}
    </button>
  );
}

export function ButtonLink({
  href,
  children,
  ariaLabel,
  ...look
}: ButtonLook & { href: string; children: ReactNode; ariaLabel?: string }) {
  return (
    <Link href={href} className={buttonClass(look)} aria-label={ariaLabel}>
      {children}
    </Link>
  );
}

/* ─────────────────────────────── Money ───────────────────────────────────── */

export function Money({ amount, currency = "ILS", className }: { amount: string | number; currency?: string; className?: string }) {
  return <bdi className={cx(s.money, className)}>{formatAmount(amount, currency)}</bdi>;
}

/* ─────────────────────────────── Status ──────────────────────────────────── */

export function StatusChip({ status, label, tone }: { status?: StatusKey; label?: string; tone?: StatusTone }) {
  const t = tone ?? (status ? statusTone(status) : "neutral");
  const text = label ?? (status ? statusLabel(status) : "");
  return <span className={cx(s.chip, s[`tone_${t}`])}>{text}</span>;
}

/** A quiet, non-status tag ("מתחדש", "נמסר דרך המזכירה"). */
export function Tag({ children }: { children: ReactNode }) {
  return <span className={cx(s.chip, s.chipQuiet)}>{children}</span>;
}

/* ──────────────────────────── Card / section ─────────────────────────────── */

export function Card({
  title,
  meta,
  action,
  children,
  as: As = "section",
  labelledBy,
  className,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  as?: "section" | "div" | "aside";
  labelledBy?: string;
  className?: string;
}) {
  const autoId = useId();
  const headingId = labelledBy ?? (title ? autoId : undefined);
  return (
    <As className={cx(s.card, className)} aria-labelledby={headingId}>
      {title || action ? (
        <div className={s.cardHead}>
          {title ? (
            <h2 id={headingId} className={s.cardTitle}>
              {title}
            </h2>
          ) : (
            <span />
          )}
          {meta ? <span className={s.cardMeta}>{meta}</span> : null}
          {action}
        </div>
      ) : null}
      {children}
    </As>
  );
}

export function SectionHeading({
  children,
  count,
  tone,
  aside,
  id,
}: {
  children: ReactNode;
  count?: number;
  tone?: StatusTone;
  aside?: ReactNode;
  id?: string;
}) {
  return (
    <h3 className={s.sectionHead} id={id}>
      {tone ? <span className={cx(s.dot, s[`dot_${tone}`])} aria-hidden="true" /> : null}
      <span>{children}</span>
      {count !== undefined ? <span className={s.count}>· {count.toLocaleString("he-IL")}</span> : null}
      {aside ? <span className={s.aside}>{aside}</span> : null}
    </h3>
  );
}

/* ──────────────────────────── Summary strip ──────────────────────────────── */

export type SummaryFigureProps = {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "danger" | "muted";
};

export function SummaryStrip({
  figures,
  footnote,
  ariaLabel,
}: {
  figures: SummaryFigureProps[];
  footnote?: ReactNode;
  ariaLabel: string;
}) {
  const style = { "--strip-cols": String(figures.length) } as CSSProperties;
  return (
    <section className={s.strip} aria-label={ariaLabel}>
      <dl className={s.stripGrid} style={{ ...style, margin: 0 }}>
        {figures.map((f) => (
          <div key={f.label} className={cx(s.figure, f.tone && f.tone !== "default" && s[`figure_${f.tone}`])}>
            <dt className={s.figureLabel}>{f.label}</dt>
            <dd className={s.figureValue} style={{ margin: 0 }}>
              {f.value}
            </dd>
            {f.hint ? <dd className={s.figureHint} style={{ margin: 0 }}>{f.hint}</dd> : null}
          </div>
        ))}
      </dl>
      {footnote ? <p className={s.stripFoot} style={{ margin: 0 }}>{footnote}</p> : null}
    </section>
  );
}

/* ──────────────────────────── Obligation row ─────────────────────────────── */

export function RowList({ children, ariaLabel, ariaLabelledBy }: { children: ReactNode; ariaLabel?: string; ariaLabelledBy?: string }) {
  return (
    <ul className={s.rows} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {children}
    </ul>
  );
}

export type ObligationRowProps = {
  title: string;
  /** One line under the title: cadence · due date · relative day. */
  meta?: ReactNode;
  chips?: ReactNode;
  amount?: { value: string; currency?: string; caption?: ReactNode };
  /** Paid out of total, both straight from the server. */
  progress?: { paid: string; total: string; currency?: string };
  actions?: ReactNode;
  href?: string;
  onSelect?: () => void;
  selected?: boolean;
  markLabel?: string;
};

/**
 * One obligation, the same on both screens. The title is the row's link (or
 * selection button); its ::after stretches over the whole row, so the row is
 * one big target while the action buttons above it stay separate tab stops.
 */
export function ObligationRow({ title, meta, chips, amount, progress, actions, href, onSelect, selected, markLabel }: ObligationRowProps) {
  const interactive = Boolean(href || onSelect);
  const titleNode = href ? (
    <Link href={href} className={s.stretch} aria-current={selected ? "true" : undefined}>
      {title}
    </Link>
  ) : onSelect ? (
    <button type="button" onClick={onSelect} className={s.stretch} aria-pressed={selected ?? false}>
      {title}
    </button>
  ) : (
    title
  );
  return (
    <li className={cx(s.row, interactive && s.rowInteractive, selected && s.rowSelected)}>
      <span className={s.mark} aria-hidden="true">
        {(markLabel ?? title).trim().charAt(0) || "·"}
      </span>
      <span className={s.main}>
        <span className={s.rowTitle}>
          <span className={s.rowTitleText}>{titleNode}</span>
          {chips}
        </span>
        {meta || progress ? (
          <span className={s.rowMeta}>
            {meta}
            {progress ? <PaidProgress {...progress} /> : null}
          </span>
        ) : null}
      </span>
      {amount ? (
        <span className={s.amount}>
          <Money amount={amount.value} currency={amount.currency} className={s.amountValue} />
          {amount.caption ? <span className={s.amountCaption}>{amount.caption}</span> : null}
        </span>
      ) : (
        <span />
      )}
      {actions ? <span className={s.rowActions}>{actions}</span> : null}
    </li>
  );
}

export function PaidProgress({ paid, total, currency = "ILS" }: { paid: string; total: string; currency?: string }) {
  const p = Number(paid);
  const t = Number(total);
  // A visual ratio only; the figures shown are the server's.
  const ratio = Number.isFinite(p) && Number.isFinite(t) && t > 0 ? Math.min(1, Math.max(0, p / t)) : 0;
  return (
    <span className={s.progress}>
      <span>
        שולמו <Money amount={paid} currency={currency} /> מתוך <Money amount={total} currency={currency} />
      </span>
      <span className={s.progressTrack} aria-hidden="true">
        <span className={s.progressFill} style={{ inlineSize: `${Math.round(ratio * 100)}%` }} />
      </span>
    </span>
  );
}

/* ─────────────────────────── Notice / toast ──────────────────────────────── */

export function Notice({ tone = "info", children, role }: { tone?: "info" | "warning" | "danger" | "success" | "neutral"; children: ReactNode; role?: "status" | "alert" }) {
  return (
    <div className={cx(s.notice, s[`notice_${tone}`])} role={role}>
      {children}
    </div>
  );
}

export type ToastMessage = { text: string; tone: "success" | "danger" };

/** A short-lived confirmation ("התשלום נרשם") or failure, announced politely. */
export function useToast(timeoutMs = 3600): [ReactNode, (text: string, tone?: ToastMessage["tone"]) => void] {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const timer = useRef<number | null>(null);
  const show = useCallback(
    (text: string, tone: ToastMessage["tone"] = "success") => {
      if (timer.current) window.clearTimeout(timer.current);
      setMessage({ text, tone });
      timer.current = window.setTimeout(() => setMessage(null), timeoutMs);
    },
    [timeoutMs],
  );
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  const node = (
    <div aria-live="polite" aria-atomic="true">
      {message ? (
        <div className={cx(s.toast, s[`toast_${message.tone}`])} role={message.tone === "danger" ? "alert" : "status"}>
          {message.text}
        </div>
      ) : null}
    </div>
  );
  return [node, show];
}

/* ─────────────────────── Empty / error / loading ─────────────────────────── */

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.empty}>
      <p className={s.emptyTitle}>{title}</p>
      {body ? <p className={s.emptyBody}>{body}</p> : null}
      {action ? <div className={s.emptyAction}>{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title = "לא הצלחנו לטעון את המידע", body, onRetry, retryLabel = "לנסות שוב" }: { title?: string; body?: ReactNode; onRetry?: () => void | Promise<void>; retryLabel?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className={s.empty} role="alert">
      <p className={s.emptyTitle}>{title}</p>
      {body ? <p className={s.emptyBody}>{body}</p> : null}
      {onRetry ? (
        <div className={s.emptyAction}>
          <Button
            variant="secondary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onRetry();
              } finally {
                setBusy(false);
              }
            }}
          >
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function SkeletonRows({ count = 3, label = "טוען" }: { count?: number; label?: string }) {
  return (
    <div className={s.rows} aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={s.skeletonRow}>
          <span className={s.skel} style={{ blockSize: 36 }} />
          <span style={{ display: "grid", gap: 6 }}>
            <span className={s.skel} style={{ blockSize: 12, inlineSize: "52%" }} />
            <span className={s.skel} style={{ blockSize: 10, inlineSize: "34%" }} />
          </span>
          <span className={s.skel} style={{ blockSize: 14 }} />
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────────── Action menu ───────────────────────────────── */

export type MenuItem =
  | { kind?: "action"; label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }
  | { kind: "link"; label: string; href: string }
  | { kind: "separator" };

/**
 * The "עוד" menu. Keyboard: Enter/Space/ArrowDown opens and focuses the first
 * item, arrows move, Escape closes and returns focus to the trigger.
 */
export function ActionMenu({ items, label = "פעולות נוספות", size = "sm" }: { items: MenuItem[]; label?: string; size?: ButtonSize }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const focusItem = (index: number) => {
    const nodes = wrapRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
    if (!nodes || nodes.length === 0) return;
    nodes[(index + nodes.length) % nodes.length].focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    requestAnimationFrame(() => focusItem(0));
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const nodes = Array.from(wrapRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusItem(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusItem(at - 1);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <span className={s.menuWrap} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={buttonClass({ variant: "secondary", size, iconOnly: true })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreIcon />
      </button>
      {open ? (
        <div className={s.menu} role="menu" id={menuId} aria-label={label} onKeyDown={onMenuKey}>
          {items.map((item, i) => {
            if (item.kind === "separator") return <div key={`sep-${i}`} className={s.menuSep} role="separator" />;
            if (item.kind === "link") {
              return (
                <Link key={item.label} href={item.href} role="menuitem" className={s.menuItem} onClick={() => setOpen(false)}>
                  {item.label}
                </Link>
              );
            }
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                aria-disabled={item.disabled || undefined}
                className={cx(s.menuItem, item.danger && s.menuItemDanger)}
                onClick={() => {
                  if (item.disabled) return;
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}

/* ───────────────────────────── Dialogs ───────────────────────────────────── */

/**
 * One dialog shell for every form and question (AdaptiveOverlay: a centered
 * dialog on wide screens, a bottom sheet on phones; focus trap, Escape, scroll
 * lock). Replaces ad-hoc sheets and native window.confirm.
 */
export function DialogFrame({
  open,
  onClose,
  title,
  children,
  footer,
  variant = "form",
  closeLabel = "סגירה",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  variant?: "confirm" | "form" | "wide";
  closeLabel?: string;
}) {
  const titleId = useId();
  return (
    <AdaptiveOverlay open={open} onClose={onClose} variant={variant} labelledBy={titleId}>
      <div className={s.dialog} dir="rtl">
        <div className={s.dialogHead}>
          <h2 id={titleId} className={s.dialogTitle}>
            {title}
          </h2>
          <button type="button" className={s.close} onClick={onClose} aria-label={closeLabel}>
            <CloseIcon />
          </button>
        </div>
        {children}
        {footer ? <div className={s.dialogFoot}>{footer}</div> : null}
      </div>
    </AdaptiveOverlay>
  );
}

/**
 * "Are you sure?" for destructive or money-moving actions. The confirm button
 * shows progress, and a failure stays inside the dialog in Hebrew.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "ביטול",
  tone = "danger",
  onConfirm,
  onCancel,
  errorFallback = "הפעולה לא הצליחה. אפשר לנסות שוב.",
  translateError,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
  errorFallback?: string;
  translateError?: (e: unknown, fallback: string) => string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);
  const cancel = () => {
    if (!busy) onCancel();
  };
  return (
    <DialogFrame
      open={open}
      onClose={cancel}
      title={title}
      variant="confirm"
      footer={
        <>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (e) {
                setError(translateError ? translateError(e, errorFallback) : errorFallback);
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
          <Button variant="secondary" onClick={cancel} disabled={busy}>
            {cancelLabel}
          </Button>
        </>
      }
    >
      {body ? <div className={s.dialogBody}>{body}</div> : null}
      {error ? (
        <p className={s.formError} role="alert">
          {error}
        </p>
      ) : null}
    </DialogFrame>
  );
}

/* ───────────────────────────── Form field ────────────────────────────────── */

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <label className={s.field} htmlFor={htmlFor}>
      <span className={s.fieldLabel}>{label}</span>
      {children}
      {hint ? <span className={s.fieldHint}>{hint}</span> : null}
    </label>
  );
}

export const fieldInputClass = s.input;
export const formErrorClass = s.formError;

/* ─────────────────────────────── Icons ───────────────────────────────────── */

export function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" width="16" height="16">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}
