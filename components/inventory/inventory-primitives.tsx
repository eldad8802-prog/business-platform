"use client";

/**
 * Inventory shared primitives.
 *
 * Structure follows docs/docsdesign/inventory_screens.html.txt; interaction
 * patterns follow docs/docsdesign/inventory-interaction-architecture.md.txt.
 * Colors come from --inv-* tokens only (see inventory-primitives.css.ts).
 *
 * Self-contained: imports only from inventory-tokens to avoid a cycle with
 * inventory-design.tsx (which re-exports these).
 */

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { inventoryToneStyles } from "@/components/inventory/inventory-tokens";

/* ============================================================= icons === */

/** Chevron pointing right — the back affordance at the RTL start corner. */
export function IconChevronStart() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="m9 6 6 6-6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconPlus() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconEdit() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 20h4l10-10-4-4L4 16v4ZM14 6l4 4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ============================================================ header === */

export type InventoryHeaderAction = {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
  /** Filled accent (brand) circle, e.g. the "+" new-item button. */
  accent?: boolean;
};

/**
 * The one header for every inventory screen.
 *
 * - `variant="hub"`  → large start-aligned title + optional sub + optional
 *   trailing action. **No back button** (reached via the shell bar).
 * - `variant="page"` → leading chevron-start back button + centered title +
 *   optional trailing action. Used by every screen you navigate *into*.
 *
 * Bottom Sheets are NOT pages — they close via scrim/drag, never this back.
 */
export function InventoryHeader({
  title,
  variant,
  sub,
  back,
  action,
}: {
  title: string;
  variant: "hub" | "page";
  sub?: ReactNode;
  /** Page variant only. Omit `href`+`onBack` to fall back to router.back(). */
  back?: { href?: string; onBack?: () => void; label?: string };
  action?: InventoryHeaderAction | null;
}) {
  const router = useRouter();

  const handleBack = useCallback(() => {
    if (back?.onBack) return back.onBack();
    if (back?.href) return router.push(back.href);
    router.back();
  }, [back, router]);

  const handleAction = useCallback(() => {
    if (!action) return;
    if (action.onClick) return action.onClick();
    if (action.href) router.push(action.href);
  }, [action, router]);

  const actionBtn = action ? (
    <button
      type="button"
      className={`inv-iconbtn${action.accent ? " inv-iconbtn--acc" : ""}`}
      onClick={handleAction}
      aria-label={action.label}
      title={action.label}
    >
      {action.icon}
    </button>
  ) : null;

  if (variant === "hub") {
    return (
      <>
        <div className="inv-hd inv-hd--hub">
          <h1 className="inv-hd__title-hub">{title}</h1>
          <div className="inv-hd__grow" />
          {actionBtn}
        </div>
        {sub ? <div className="inv-hd__sub">{sub}</div> : null}
      </>
    );
  }

  return (
    <header className="inv-hd inv-hd--page">
      {back?.label ? (
        // Opt-in labeled back control (chevron + text), start-aligned (right in
        // RTL). Only callers that pass a label get text; every existing caller
        // keeps the icon-only chevron below, unchanged.
        <button
          type="button"
          onClick={handleBack}
          aria-label="חזרה"
          title="חזרה"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            minHeight: 36,
            padding: "6px 12px 6px 10px",
            borderRadius: 10,
            border: "1px solid var(--inv-border)",
            background: "var(--inv-surface-2)",
            color: "var(--inv-text)",
            cursor: "pointer",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          <IconChevronStart />
          <span>{back.label}</span>
        </button>
      ) : (
        <button type="button" className="inv-iconbtn" onClick={handleBack} aria-label="חזרה" title="חזרה">
          <IconChevronStart />
        </button>
      )}
      <h1 className="inv-hd__title-page">{title}</h1>
      {actionBtn ?? <span className="inv-iconbtn inv-iconbtn--ghost" aria-hidden />}
    </header>
  );
}

/* ===================================================== segmented ctrl === */

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  style?: React.CSSProperties;
}) {
  return (
    <div className="inv-seg" role="tablist" style={style}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === value}
          className={`inv-segbtn${opt.value === value ? " is-on" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ========================================================= filter chips === */

export function FilterChipRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string; dotColor?: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inv-chips" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === value}
          className={`inv-chip${opt.value === value ? " is-on" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.dotColor ? (
            <span className="inv-chip__dot" style={{ background: opt.dotColor }} />
          ) : null}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ============================================================ steppers === */

/** Large stepper for sheets (e.g. movement quantity). Renders the raw value. */
export function Stepper({
  value,
  display,
  onDecrement,
  onIncrement,
  min,
}: {
  value: number;
  display?: string;
  onDecrement: () => void;
  onIncrement: () => void;
  min?: number;
}) {
  const atMin = typeof min === "number" && value <= min;
  return (
    <div className="inv-stepper">
      <button type="button" className="inv-stepper__btn" onClick={onDecrement} disabled={atMin} aria-label="הפחת">
        −
      </button>
      <div className="inv-stepper__val">{display ?? value}</div>
      <button type="button" className="inv-stepper__btn" onClick={onIncrement} aria-label="הוסף">
        +
      </button>
    </div>
  );
}

/** Compact inline stepper for list lines (cart, sale, receiving). */
export function MiniStepper({
  value,
  onDecrement,
  onIncrement,
  min = 0,
}: {
  value: number;
  onDecrement: () => void;
  onIncrement: () => void;
  min?: number;
}) {
  return (
    <div className="inv-ministep">
      <button type="button" onClick={onDecrement} disabled={value <= min} aria-label="הפחת">
        −
      </button>
      <span>{value}</span>
      <button type="button" onClick={onIncrement} aria-label="הוסף">
        +
      </button>
    </div>
  );
}

/* ========================================= decision card + confidence === */

export type ConfidenceLevel = "high" | "mid" | "low";

export function ConfidencePill({ level, label }: { level: ConfidenceLevel; label: string }) {
  return <span className={`inv-conf inv-conf--${level}`}>{label}</span>;
}

export function DecisionCard({ children }: { children: ReactNode }) {
  return <div className="inv-dcard">{children}</div>;
}

export type DecisionChoice = {
  label: string;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
};

export function DecisionChips({ choices }: { choices: DecisionChoice[] }) {
  return (
    <div className="inv-dchips">
      {choices.map((choice, i) => (
        <button
          key={`${choice.label}-${i}`}
          type="button"
          className={`inv-dchip${choice.primary ? " is-pri" : ""}`}
          onClick={choice.onClick}
          disabled={choice.disabled}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/* ====================================== bottom action bar / save bar === */

/** Sticky total + primary CTA (cart, sale, receiving, import). */
export function BottomActionBar({
  label,
  value,
  cta,
  onCta,
  ctaDisabled,
  secondary,
}: {
  label: ReactNode;
  value: ReactNode;
  cta: string;
  onCta?: () => void;
  ctaDisabled?: boolean;
  /** Optional left-side ghost button (e.g. "שמור טיוטה"). */
  secondary?: { label: string; onClick?: () => void };
}) {
  return (
    <div className="inv-bottombar">
      <div className="inv-bottombar__inner">
        {secondary ? (
          <button type="button" className="inv-sheet__ghost" style={{ flex: 1 }} onClick={secondary.onClick}>
            {secondary.label}
          </button>
        ) : (
          <div className="inv-bottombar__tot">
            <div className="inv-bottombar__tl">{label}</div>
            <div className="inv-bottombar__tv">{value}</div>
          </div>
        )}
        <button
          type="button"
          className="inv-bottombar__go"
          onClick={onCta}
          disabled={ctaDisabled}
          style={secondary ? { flex: 1.6 } : undefined}
        >
          {cta}
        </button>
      </div>
    </div>
  );
}

/** Sticky single full-width save button (forms). */
export function SaveBar({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="inv-savebar">
      <div className="inv-savebar__inner">
        <button type="button" className="inv-savebar__btn" onClick={onClick} disabled={disabled}>
          {label}
        </button>
      </div>
    </div>
  );
}

/* ============================================================ overlays === */

function useDismissable(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    // Focus the panel for a11y (focus trap entry point).
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return ref;
}

/**
 * Bottom Sheet — the dominant inventory pattern. Closes on scrim tap, ESC, or a
 * grab-handle tap (drag is approximated by the handle/scrim on touch). It is an
 * overlay, never a routed page: it does not own a page back button.
 */
export function BottomSheet({
  title,
  who,
  onClose,
  children,
  footer,
}: {
  title: string;
  who?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useDismissable(onClose);

  return (
    <>
      <div className="inv-scrim" onClick={onClose} aria-hidden />
      <div
        className="inv-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <button
          type="button"
          className="inv-sheet__grab"
          onClick={onClose}
          aria-label="סגירה"
          style={{ border: 0, cursor: "pointer", padding: 0 }}
        />
        <h3>{title}</h3>
        {who ? <div className="inv-sheet__who">{who}</div> : null}
        {children}
        {footer}
      </div>
    </>
  );
}

/** Standard cancel/confirm footer for a Bottom Sheet. */
export function SheetActions({
  cancelLabel = "ביטול",
  confirmLabel,
  onCancel,
  onConfirm,
  confirmDisabled,
}: {
  cancelLabel?: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm?: () => void;
  confirmDisabled?: boolean;
}) {
  return (
    <div className="inv-sheet__actions">
      <button type="button" className="inv-sheet__ghost" onClick={onCancel}>
        {cancelLabel}
      </button>
      <button type="button" className="inv-sheet__fill" onClick={onConfirm} disabled={confirmDisabled}>
        {confirmLabel}
      </button>
    </div>
  );
}

/**
 * Confirm Modal — blocking, focused. Reserved for irreversible / externally
 * consequential actions (Post receiving, send to supplier, approve-all import,
 * disconnect integration, archive item).
 */
export function ConfirmModal({
  title,
  body,
  confirmLabel,
  cancelLabel = "ביטול",
  onConfirm,
  onCancel,
  danger,
  confirmDisabled,
}: {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  confirmDisabled?: boolean;
}) {
  const ref = useDismissable(onCancel);

  return (
    <div className="inv-modal-scrim" onClick={onCancel}>
      <div
        className="inv-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{title}</h3>
        {body ? <p>{body}</p> : null}
        <div className="inv-modal__actions">
          <button type="button" className="inv-modal__ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`inv-modal__confirm${danger ? " inv-modal__confirm--danger" : ""}`}
            onClick={onConfirm}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================== steps === */

export function WizardSteps({
  steps,
  activeIndex,
}: {
  steps: string[];
  activeIndex: number;
}) {
  return (
    <div className="inv-steps">
      {steps.map((step, i) => (
        <span key={step} style={{ display: "contents" }}>
          {i > 0 ? <span className="inv-steps__arr">›</span> : null}
          <span className={`inv-steps__s${i === activeIndex ? " is-on" : ""}`}>{step}</span>
        </span>
      ))}
    </div>
  );
}

/* ================================================= product detail body === */

export type StockTone = "ok" | "critical" | "low";

/** Converged stock palette (matches StatusPill/StockBar and the mockup). */
const STOCK_PALETTE: Record<StockTone, { bg: string; ink: string; bar: string }> = {
  ok: { bg: "var(--inv-success-bg)", ink: "var(--inv-success)", bar: "var(--inv-success)" },
  critical: { bg: "var(--inv-danger-bg)", ink: "var(--inv-danger)", bar: "var(--inv-danger)" },
  low: { bg: "var(--inv-warning-bg)", ink: "var(--inv-warning-ink)", bar: "var(--inv-warning)" },
};

export function stockPalette(tone: StockTone) {
  return STOCK_PALETTE[tone];
}

/** Product hero — image, or a tinted placeholder block (emoji/glyph optional). */
export function ProductHero({
  imageUrl,
  tone,
  placeholder,
}: {
  imageUrl?: string | null;
  tone: StockTone;
  placeholder?: ReactNode;
}) {
  return (
    <div className="inv-hero" style={{ background: STOCK_PALETTE[tone].bg }}>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="" />
      ) : (
        (placeholder ?? null)
      )}
    </div>
  );
}

export function ProductTags({ tags }: { tags: Array<string | null | undefined> }) {
  const visible = tags.filter((t): t is string => Boolean(t && t.trim()));
  if (!visible.length) return null;
  return (
    <div className="inv-dtags">
      {visible.map((t, i) => (
        <span key={`${t}-${i}`} className="inv-tag">
          {t}
        </span>
      ))}
    </div>
  );
}

/** Status block: tone pill + big qty + track + caption (mockup `.statusblock`). */
export function StockStatusBlock({
  tone,
  statusLabel,
  quantityLabel,
  ratio,
  caption,
}: {
  tone: StockTone;
  statusLabel: string;
  quantityLabel: ReactNode;
  ratio: number;
  caption?: ReactNode;
}) {
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const p = STOCK_PALETTE[tone];
  return (
    <div className="inv-statusblock">
      <div className="inv-statusblock__top">
        <span
          style={{
            display: "inline-flex",
            padding: "4px 10px",
            borderRadius: 999,
            background: p.bg,
            color: p.ink,
            fontSize: 11.5,
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          {statusLabel}
        </span>
        <div className="inv-bigqty">{quantityLabel}</div>
      </div>
      <div className="inv-track" style={{ marginTop: 13 }}>
        <div className="inv-track__fill" style={{ width: `${pct}%`, background: p.bar }} />
      </div>
      {caption ? <div className="inv-barcap">{caption}</div> : null}
    </div>
  );
}

/** Two-column key/value grid (mockup `.kv`). */
export function KeyValueGrid({ pairs }: { pairs: Array<{ k: string; v: ReactNode }> }) {
  return (
    <div className="inv-kv">
      {pairs.map((pair, i) => (
        <div key={`${pair.k}-${i}`}>
          <div className="inv-kv__k">{pair.k}</div>
          <div className="inv-kv__v">{pair.v}</div>
        </div>
      ))}
    </div>
  );
}

/** Single movement-history row (mockup `.mv`). */
export function MovementRow({
  icon,
  iconBg,
  title,
  sub,
  delta,
  direction,
}: {
  icon: ReactNode;
  iconBg: string;
  title: string;
  sub: ReactNode;
  delta: ReactNode;
  direction: "up" | "down";
}) {
  return (
    <div className="inv-mv">
      <div className="inv-mv__ic" style={{ background: iconBg }}>
        {icon}
      </div>
      <div className="inv-mv__mid">
        <div className="inv-mv__r">{title}</div>
        <div className="inv-mv__s">{sub}</div>
      </div>
      <div className={`inv-delta inv-delta--${direction}`} dir="ltr">{delta}</div>
    </div>
  );
}

/* ============================================================= badge === */

export type BadgeTone = "ok" | "critical" | "low" | "info" | "neutral" | "purple";

const BADGE_TONE_KEY: Record<BadgeTone, keyof typeof inventoryToneStyles> = {
  ok: "success",
  critical: "danger",
  low: "warning",
  info: "info",
  neutral: "neutral",
  purple: "purple",
};

/** Pill badge for statuses/sources (mockup `.pill .info/.neutral/...`). */
export function InventoryBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  const s = inventoryToneStyles[BADGE_TONE_KEY[tone]];
  return (
    <span
      style={{
        display: "inline-flex",
        padding: "4px 9px",
        borderRadius: 20,
        background: s.iconBg,
        color: s.color,
        fontSize: 11.5,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/* =============================================================== row === */

/**
 * Generic list row (mockup `.row`) — thumb + title + meta + arbitrary trail.
 * Used for non-stock rows (purchase orders, sales, suppliers). For stock items
 * use {@link InventoryProductRow}. Renders a Link when `href` is set.
 */
export function InventoryRow({
  thumb,
  thumbBg,
  title,
  meta,
  trail,
  href,
  onClick,
}: {
  thumb: ReactNode;
  thumbBg?: string;
  title: ReactNode;
  meta?: ReactNode;
  trail?: ReactNode;
  href?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="inv-row__thumb" style={{ background: thumbBg ?? "var(--inv-surface)" }} aria-hidden>
        {thumb}
      </span>
      <span className="inv-row__mid">
        <span className="inv-row__nm" dir="auto">{title}</span>
        {meta ? <span className="inv-row__meta">{meta}</span> : null}
      </span>
      {trail ? <span className="inv-row__trail">{trail}</span> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} className="inv-row">
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" className="inv-row" onClick={onClick}>
        {body}
      </button>
    );
  }
  // Static row (no navigation) — e.g. a closed order whose only action is in the trail.
  return (
    <div className="inv-row" style={{ cursor: "default" }}>
      {body}
    </div>
  );
}

export function IconSearch() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.9" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export function IconScan() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Search field matching mockup `.search` (icon + input + optional scan). */
export function InventorySearch({
  value,
  onChange,
  placeholder,
  onScan,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onScan?: () => void;
}) {
  return (
    <label className="inv-search">
      <IconSearch />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {onScan ? (
        <button
          type="button"
          className="inv-search__scan"
          onClick={onScan}
          aria-label="סריקת ברקוד"
          style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", display: "flex", color: "var(--inv-accent)" }}
        >
          <IconScan />
        </button>
      ) : (
        // Decorative scan affordance (not yet wired) — shown for mockup parity; non-interactive.
        <span className="inv-search__scan" aria-hidden style={{ display: "flex", color: "var(--inv-accent)" }}>
          <IconScan />
        </span>
      )}
    </label>
  );
}

/**
 * Default thumb when a product has no image: a filled package glyph tinted in
 * the item's stock tone, so it reads as a product chip (matching the mockup's
 * tone-tinted emoji square) instead of a generic gray wireframe.
 */
function DefaultProductGlyph({ tone }: { tone: StockTone }) {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden style={{ color: STOCK_PALETTE[tone].ink }}>
      <path
        d="M12 2.6 3.7 6.9v10.2L12 21.4l8.3-4.3V6.9L12 2.6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.12"
      />
      <path
        d="M3.9 7 12 11.2 20.1 7M12 11.2V21.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Product/list row (mockup `.row`): tinted thumb, name, meta, stock track,
 * caption, trailing status pill + quantity. Renders as a Link when `href` is
 * set (soft nav, so ADR-01 interception can fire) else a button.
 */
export function InventoryProductRow({
  tone,
  imageUrl,
  thumbGlyph,
  name,
  meta,
  ratio,
  caption,
  statusLabel,
  quantity,
  unitLabel,
  href,
  onClick,
}: {
  tone: StockTone;
  imageUrl?: string | null;
  thumbGlyph?: ReactNode;
  name: string;
  meta?: ReactNode;
  ratio?: number | null;
  caption?: ReactNode;
  statusLabel: string;
  quantity: ReactNode;
  unitLabel?: string;
  href?: string;
  onClick?: () => void;
}) {
  const p = STOCK_PALETTE[tone];
  const hasBar = typeof ratio === "number" && Number.isFinite(ratio);
  const pct = hasBar ? Math.max(0, Math.min(100, (ratio as number) * 100)) : 0;

  const body = (
    <>
      <span className="inv-row__thumb" style={{ background: p.bg }} aria-hidden>
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" />
        ) : (
          thumbGlyph ?? <DefaultProductGlyph tone={tone} />
        )}
      </span>
      <span className="inv-row__mid">
        <span className="inv-row__nm" dir="auto">{name}</span>
        {meta ? <span className="inv-row__meta">{meta}</span> : null}
        {hasBar ? (
          <span className="inv-track" style={{ display: "block" }}>
            <span className="inv-track__fill" style={{ display: "block", width: `${pct}%`, background: p.bar }} />
          </span>
        ) : null}
        {caption ? <span className="inv-row__barcap">{caption}</span> : null}
      </span>
      <span className="inv-row__trail">
        <span className="inv-row__pill" style={{ background: p.bg, color: p.ink }}>
          {statusLabel}
        </span>
        <span className="inv-row__qty">
          {quantity}
          {unitLabel ? <small> {unitLabel}</small> : null}
        </span>
      </span>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={`inv-row${hasBar ? " inv-row--compact" : ""}`}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" className={`inv-row${hasBar ? " inv-row--compact" : ""}`} onClick={onClick}>
      {body}
    </button>
  );
}

/**
 * Order/cart/receiving line (mockup `.oline`) — thumb + name + sub + a trailing
 * control (MiniStepper, price, etc.). Used by sale, cart, receiving, confirm.
 */
export function InventoryOrderLine({
  thumb,
  thumbBg,
  name,
  sub,
  trailing,
  extra,
}: {
  thumb?: ReactNode;
  thumbBg?: string;
  name: ReactNode;
  sub?: ReactNode;
  trailing?: ReactNode;
  /** Full-width content below the row (e.g. remaining-decision chips). */
  extra?: ReactNode;
}) {
  return (
    <div className="inv-oline">
      {thumb !== undefined ? (
        <span
          className="inv-row__thumb"
          style={{ background: thumbBg ?? "var(--inv-surface)", width: 48, height: 48, fontSize: 22 }}
          aria-hidden
        >
          {thumb}
        </span>
      ) : null}
      <span className="inv-oline__mid">
        <span className="inv-oline__nm" dir="auto">{name}</span>
        {sub ? <span className="inv-oline__sub">{sub}</span> : null}
      </span>
      {trailing}
      {extra}
    </div>
  );
}

export type DetailAction = {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  primary?: boolean;
};

/** Detail action row: one primary + secondaries (mockup `.actions`). */
export function DetailActions({ actions }: { actions: DetailAction[] }) {
  return (
    <div className="inv-detail-actions">
      {actions.map((a, i) => (
        <button
          key={`${a.label}-${i}`}
          type="button"
          className={`inv-act${a.primary ? " inv-act--primary" : ""}`}
          onClick={a.onClick}
        >
          {a.icon}
          {a.label}
        </button>
      ))}
    </div>
  );
}
