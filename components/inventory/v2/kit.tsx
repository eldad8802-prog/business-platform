"use client";

/**
 * Inventory v2 kit — the components of the owner-approved redesign (2026-11-03).
 * Presentation only: no data access, no business rules. Screens keep their own
 * loading, saving and validation logic and render through these parts.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useBackDestination, useGoBack } from "@/components/ui/back-button";
import { useI18n } from "@/components/i18n/I18nProvider";
import { keyboardSheetInset, type SheetViewportInset } from "@/lib/inventory/sheet-viewport";
import { inv2Css } from "./kit.css";

/* ================================================================= icons === */
const sv = (d: ReactNode, size = 22) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);
export const I2 = {
  chevronStart: (s = 20) => sv(<path d="M9 6l6 6-6 6" />, s),
  chevronEnd: (s = 18) => sv(<path d="M15 6l-6 6 6 6" />, s),
  chevronDown: (s = 20) => sv(<path d="M6 9l6 6 6-6" />, s),
  chevronUp: (s = 20) => sv(<path d="M6 15l6-6 6 6" />, s),
  close: (s = 22) => sv(<path d="M6 6l12 12M18 6L6 18" />, s),
  plus: (s = 22) => sv(<path d="M12 5v14M5 12h14" />, s),
  minus: (s = 22) => sv(<path d="M5 12h14" />, s),
  search: (s = 20) => sv(<><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></>, s),
  scan: (s = 22) => sv(<><path d="M4 7V5a1 1 0 011-1h2M17 4h2a1 1 0 011 1v2M20 17v2a1 1 0 01-1 1h-2M7 20H5a1 1 0 01-1-1v-2" /><path d="M8 8v8M11 8v8M14 8v8M16.5 8v8" /></>, s),
  list: (s = 22) => sv(<path d="M4 7h11M4 12h11M4 17h7M17 15l2 2 3-4" />, s),
  truck: (s = 22) => sv(<><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7" /><circle cx="7" cy="17.5" r="1.6" /><circle cx="17" cy="17.5" r="1.6" /></>, s),
  box: (s = 22) => sv(<><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>, s),
  filter: (s = 20) => sv(<path d="M4 5h16l-6 7v6l-4 2v-8z" />, s),
  dots: (s = 22) => sv(<><circle cx="12" cy="5.5" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="18.5" r="1.2" fill="currentColor" /></>, s),
  info: (s = 20) => sv(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>, s),
  warn: (s = 20) => sv(<><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17h.01" /></>, s),
  edit: (s = 18) => sv(<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />, s),
  camera: (s = 24) => sv(<><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>, s),
  file: (s = 22) => sv(<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>, s),
  phone: (s = 20) => sv(<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z" />, s),
  mail: (s = 22) => sv(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>, s),
  copy: (s = 22) => sv(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" /></>, s),
  whatsapp: (s = 22) => sv(<><path d="M4 20l1.3-4A8 8 0 1112 20a8 8 0 01-3.8-1z" /><path d="M9 8.5c0 3 2.5 6 6 6.5l1-1.6-2-1-1 .8a5 5 0 01-2.2-2.2l.8-1-1-2z" /></>, s),
  pdf: (s = 22) => sv(<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 14h6M9 17h4" /></>, s),
  check: (s = 18) => sv(<path d="M5 12.5l4.5 4.5L19 7.5" />, s),
  arrowLeft: (s = 22) => sv(<path d="M19 12H5M11 6l-6 6 6 6" />, s),
};

/* ================================================== bottom-bar awareness === */
/**
 * The app shell's fixed bottom bar (mobile) tags itself; the page keeps its
 * footer actions above it (and above the accessibility button) via --i2-nav-h.
 */
function useShellBarHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const measure = () => {
      const bar = document.querySelector<HTMLElement>('[data-component="shell-bottom-bar"]');
      const visible = bar && bar.offsetParent !== null ? bar.offsetHeight : 0;
      setH((cur) => (cur === visible ? cur : visible));
    };
    measure();
    window.addEventListener("resize", measure);
    const mo = new MutationObserver(measure);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener("resize", measure);
      mo.disconnect();
    };
  }, []);
  return h;
}

/* ================================================================== back === */
/** "חזרה ›" at the top start — the app's own back mechanism, in the approved look. */
export function InvBack({ fallback, onClick, label }: { fallback?: string; onClick?: () => void; label?: string }) {
  const { t } = useI18n();
  const { target, fallback: fb } = useBackDestination(fallback);
  const go = useGoBack(fb.url);
  const lastClick = useRef(0);
  const isFallback = !onClick && target?.kind === "none";
  const text = label ?? (isFallback ? fb.label : t("common.back"));
  return (
    <button
      type="button"
      className="i2-back"
      onClick={() => {
        const now = Date.now();
        if (now - lastClick.current < 350) return;
        lastClick.current = now;
        if (onClick) onClick();
        else go();
      }}
      aria-label={text}
      data-dz-back={onClick ? "step" : !target ? "pending" : target.kind === "history" ? "history" : "fallback"}
    >
      {I2.chevronStart(20)}
      <span>{text}</span>
    </button>
  );
}

/* ================================================================== page === */
export type InvSection = "overview" | "items" | "orders";

export function InvPage({
  title,
  back,
  backFallback,
  onBack,
  end,
  tabs,
  wide,
  children,
  footer,
}: {
  title: ReactNode;
  /** Show the back control (default true). */
  back?: boolean;
  backFallback?: string;
  onBack?: () => void;
  /** Header end slot (menu, text action). */
  end?: ReactNode;
  /** Section tabs under the header. */
  tabs?: InvSection;
  wide?: boolean;
  children: ReactNode;
  /** Primary actions — kept above the bottom bar and the accessibility button. */
  footer?: ReactNode;
}) {
  const barH = useShellBarHeight();
  return (
    <div data-inv2 data-inventory-module style={{ ["--i2-nav-h" as string]: `${barH}px` } as CSSProperties}>
      <style>{inv2Css}</style>
      <div className={`i2-page${wide ? " i2-page--wide" : ""}`}>
        <header className="i2-hd">
          <div className="i2-hd__start">{back === false ? null : <InvBack fallback={backFallback} onClick={onBack} />}</div>
          <h1 className="i2-hd__title">{title}</h1>
          <div className="i2-hd__end">{end}</div>
        </header>
        {tabs ? <InvSectionTabs active={tabs} /> : null}
        {children}
        {footer ? <div className="i2-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function InvSectionTabs({ active }: { active: InvSection }) {
  const items: Array<{ key: InvSection; href: string; label: string }> = [
    { key: "overview", href: "/inventory", label: "סקירה" },
    { key: "items", href: "/inventory/items", label: "מוצרים" },
    { key: "orders", href: "/inventory/supplier-purchases", label: "הזמנות" },
  ];
  return (
    <nav className="i2-tabs" aria-label="אזורי המלאי">
      {items.map((it) => (
        <Link key={it.key} href={it.href} className="i2-tab" aria-current={it.key === active ? "page" : undefined}>
          {it.label}
        </Link>
      ))}
    </nav>
  );
}

/** In-page tabs (state, not routes). */
export function InvTabs<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }>; label: string }) {
  return (
    <div className="i2-tabs" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" className="i2-tab" aria-selected={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ================================================================ thumbs === */
/** Product image with a calm fallback (first letter on beige) for missing or broken images. */
export function ProductThumb({ src, name, size = 56 }: { src?: string | null; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const usable = src && !broken && !/example\.com/.test(src);
  const letter = (name || "?").trim().charAt(0) || "?";
  return (
    <span className="i2-thumb" style={{ ["--s" as string]: `${size}px` } as CSSProperties} aria-hidden>
      {usable ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src!} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <span className="i2-thumb__l">{letter}</span>
      )}
    </span>
  );
}

/* ================================================================== rows === */
export function InvRow({
  href,
  onClick,
  thumb,
  kicker,
  title,
  dot,
  sub,
  subTone,
  trail,
  ariaLabel,
}: {
  href?: string;
  onClick?: () => void;
  thumb?: ReactNode;
  kicker?: ReactNode;
  title: ReactNode;
  dot?: "danger" | "warn" | null;
  sub?: ReactNode;
  subTone?: "danger";
  trail?: ReactNode;
  ariaLabel?: string;
}) {
  const body = (
    <>
      {thumb}
      <span className="i2-row__text">
        {kicker ? <span className="i2-row__kicker">{kicker}</span> : null}
        <span className="i2-row__title">
          {dot ? <span className={`i2-dot${dot === "warn" ? " i2-dot--warn" : ""}`} aria-hidden /> : null}
          <span>{title}</span>
        </span>
        {sub ? <span className={`i2-row__sub${subTone === "danger" ? " i2-row__sub--danger" : ""}`}>{sub}</span> : null}
      </span>
    </>
  );
  return (
    <li className="i2-row">
      {href ? (
        <Link href={href} className="i2-row__main" aria-label={ariaLabel}>
          {body}
        </Link>
      ) : onClick ? (
        <button type="button" className="i2-row__main" onClick={onClick} aria-label={ariaLabel} style={{ background: "none", border: 0, padding: 0, textAlign: "start", cursor: "pointer", font: "inherit" }}>
          {body}
        </button>
      ) : (
        <div className="i2-row__main">{body}</div>
      )}
      {trail ? <div className="i2-row__trail">{trail}</div> : null}
    </li>
  );
}

/* =============================================================== buttons === */
type BtnKind = "primary" | "secondary" | "soft" | "danger";
export function InvButton({
  kind = "primary",
  small,
  block,
  href,
  onClick,
  disabled,
  children,
  type = "button",
  ariaLabel,
}: {
  kind?: BtnKind;
  small?: boolean;
  block?: boolean;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  type?: "button" | "submit";
  ariaLabel?: string;
}) {
  const cls = `i2-btn i2-btn--${kind}${small ? " i2-btn--sm" : ""}${block ? " i2-btn--block" : ""}`;
  if (href && !disabled) {
    return (
      <Link href={href} className={cls} aria-label={ariaLabel}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  );
}

export function InvPill({ href, onClick, outline, children, ariaLabel, disabled }: { href?: string; onClick?: () => void; outline?: boolean; children: ReactNode; ariaLabel?: string; disabled?: boolean }) {
  const cls = `i2-pill${outline ? " i2-pill--outline" : ""}`;
  if (href) {
    return (
      <Link href={href} className={cls} aria-label={ariaLabel}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick} aria-label={ariaLabel} disabled={disabled}>
      {children}
    </button>
  );
}

/* ================================================================ search === */
export function InvSearch({
  value,
  onChange,
  placeholder,
  onScan,
  scanLabel,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onScan?: () => void;
  scanLabel?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className="i2-searchrow">
      <label className="i2-search">
        {I2.search(20)}
        <span className="i2-sr">{placeholder}</span>
        <input ref={inputRef} type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} enterKeyHint="search" />
      </label>
      {onScan ? (
        <button type="button" className="i2-scanbtn" onClick={onScan} aria-label={scanLabel ?? "סריקת ברקוד"}>
          {I2.scan(22)}
        </button>
      ) : null}
    </div>
  );
}

export function InvChips<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode; count?: number }>; label: string }) {
  return (
    <div className="i2-chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="i2-chip" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
          {typeof o.count === "number" ? <span className="i2-chip__n">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* =============================================================== quantity === */
/**
 * Typed quantity with − / +. Whole numbers only (the existing quantity policy);
 * clamped to [min, max]. The typed text is kept while editing and committed on blur.
 */
export function InvQty({
  value,
  onChange,
  min = 0,
  max,
  size = "md",
  label,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  size?: "sm" | "md" | "lg";
  label: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : String(value);
  const clamp = (n: number) => {
    let v = Math.round(n);
    if (Number.isNaN(v)) v = min;
    if (v < min) v = min;
    if (typeof max === "number" && v > max) v = max;
    return v;
  };
  const commit = (raw: string) => {
    setEditing(false);
    if (raw.trim() === "") return;
    const n = Number(raw.replace(",", "."));
    if (!Number.isFinite(n)) return;
    const next = clamp(n);
    if (next !== value) onChange(next);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };
  return (
    <span className={`i2-qty i2-qty--${size}`} role="group" aria-label={label}>
      <button type="button" className="i2-qty__b" onClick={() => onChange(clamp(value + 1))} disabled={disabled || (typeof max === "number" && value >= max)} aria-label={`הוספה של אחד · ${label}`}>
        +
      </button>
      <input
        className="i2-qty__in i2-num"
        inputMode="numeric"
        pattern="[0-9]*"
        value={shown}
        disabled={disabled}
        aria-label={label}
        onFocus={(e) => {
          setText(String(value));
          setEditing(true);
          e.target.select();
        }}
        onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={onKey}
      />
      <button type="button" className="i2-qty__b" onClick={() => onChange(clamp(value - 1))} disabled={disabled || value <= min} aria-label={`הפחתה של אחד · ${label}`}>
        −
      </button>
    </span>
  );
}

/* ================================================================= forms === */
export function InvField({
  label,
  required,
  optional,
  help,
  error,
  stack,
  children,
  htmlFor,
}: {
  label: ReactNode;
  required?: boolean;
  optional?: boolean;
  help?: ReactNode;
  error?: ReactNode;
  stack?: boolean;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className={`i2-field${stack ? " i2-field--stack" : ""}`}>
      <label className="i2-field__lab" htmlFor={htmlFor}>
        {label}
        {required ? <span className="i2-field__req" aria-hidden> *</span> : null}
        {optional ? <span className="i2-field__opt"> (אופציונלי)</span> : null}
      </label>
      <div>{children}</div>
      {error ? <p className="i2-field__err" role="alert">{error}</p> : help ? <p className="i2-field__help">{help}</p> : null}
    </div>
  );
}

export function InvSectionBox({ title, summary, defaultOpen = true, children }: { title: ReactNode; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className="i2-section">
      <button type="button" className="i2-section__hd" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        {open ? I2.chevronUp(20) : I2.chevronDown(20)}
      </button>
      {!open && summary ? <span className="i2-section__sum">{summary}</span> : null}
      <div id={id} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

export function InvSegmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }>; label: string }) {
  return (
    <div className="i2-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ========================================================== notes, status === */
export function InvNote({ tone, children }: { tone?: "warn" | "danger" | "ok"; children: ReactNode }) {
  return (
    <div className={`i2-note${tone ? ` i2-note--${tone}` : ""}`} role={tone === "danger" ? "alert" : undefined}>
      {tone === "warn" || tone === "danger" ? I2.warn(20) : I2.info(20)}
      <div>{children}</div>
    </div>
  );
}

export function InvStatus({ tone, children }: { tone?: "ok" | "warn" | "danger" | "info"; children: ReactNode }) {
  return <span className={`i2-status${tone ? ` i2-status--${tone}` : ""}`}>{children}</span>;
}

export function InvSteps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="i2-steps" aria-label={`שלב ${current + 1} מתוך ${steps.length}`}>
      {steps.map((s, i) => (
        <li key={s} data-state={i < current ? "done" : i === current ? "current" : "todo"} aria-current={i === current ? "step" : undefined}>
          <span className="i2-steps__dot">{i < current ? I2.check(18) : i + 1}</span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

/* ================================================================= states === */
export function InvLoading({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="טוען">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 0", borderBottom: "1px solid var(--i2-line)" }}>
          <div className="i2-skel" style={{ width: 56, height: 56 }} />
          <div style={{ flex: 1 }}>
            <div className="i2-skel" style={{ height: 16, width: "55%", marginBottom: 8 }} />
            <div className="i2-skel" style={{ height: 12, width: "35%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function InvState({ title, body, action }: { title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="i2-state">
      <p className="i2-state__t">{title}</p>
      {body ? <p className="i2-state__b">{body}</p> : null}
      {action}
    </div>
  );
}

export function InvError({ message, onRetry }: { message?: ReactNode; onRetry?: () => void }) {
  return (
    <div className="i2-state" role="alert">
      <p className="i2-state__t">לא הצלחנו לטעון את הנתונים</p>
      <p className="i2-state__b">{message ?? "בדקו את החיבור ונסו שוב."}</p>
      {onRetry ? (
        <InvButton kind="secondary" onClick={onRetry}>
          נסו שוב
        </InvButton>
      ) : null}
    </div>
  );
}

/* ================================================================== menu === */
export function InvMenu({ label, items }: { label: string; items: Array<{ label: ReactNode; href?: string; onClick?: () => void }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="i2-menu" ref={ref}>
      <button type="button" className="i2-iconbtn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {I2.dots(22)}
      </button>
      {open ? (
        <div className="i2-menu__pop" role="menu">
          {items.map((it, i) =>
            it.href ? (
              <Link key={i} href={it.href} className="i2-menu__item" role="menuitem" onClick={() => setOpen(false)}>
                {it.label}
              </Link>
            ) : (
              <button
                key={i}
                type="button"
                className="i2-menu__item"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  it.onClick?.();
                }}
              >
                {it.label}
              </button>
            )
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ======================================================== sheet and modal === */
function useKeyboardInset(): SheetViewportInset | null {
  const [inset, setInset] = useState<SheetViewportInset | null>(null);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const update = () => {
      const next = keyboardSheetInset(window.innerHeight, { height: vv.height, offsetTop: vv.offsetTop });
      setInset((cur) => (cur?.bottom === next?.bottom && cur?.maxHeight === next?.maxHeight ? cur : next));
      if (next) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest(".i2-sheet")) requestAnimationFrame(() => active.scrollIntoView({ block: "nearest" }));
      }
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

function usePortalEscape(onClose: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, ref]);
}

/**
 * Bottom sheet portaled to <body>: above the app's bottom bar (z-100) and the
 * accessibility button (z-101), and lifted above an on-screen keyboard.
 */
export function InvSheet({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  usePortalEscape(onClose, ref);
  const kb = useKeyboardInset();
  if (typeof document === "undefined") return null;
  return createPortal(
    <div data-inv2 data-inventory-module style={{ minHeight: 0, background: "transparent" }}>
      <style>{inv2Css}</style>
      <div className="i2-scrim" onClick={onClose} aria-hidden />
      <div
        className="i2-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        ref={ref}
        style={kb ? { bottom: kb.bottom, maxHeight: kb.maxHeight } : undefined}
      >
        <span className="i2-sheet__grab" aria-hidden />
        <div className="i2-sheet__hd">
          <h2>{title}</h2>
          <button type="button" className="i2-iconbtn" onClick={onClose} aria-label="סגירה">
            {I2.close(22)}
          </button>
        </div>
        {children}
        {footer}
      </div>
    </div>,
    document.body
  );
}

export function InvConfirm({
  title,
  body,
  confirmLabel,
  cancelLabel = "ביטול",
  onConfirm,
  onCancel,
  busy,
  danger,
}: {
  title: ReactNode;
  body?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  danger?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePortalEscape(onCancel, ref);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div data-inv2 data-inventory-module style={{ minHeight: 0, background: "transparent" }}>
      <style>{inv2Css}</style>
      <div className="i2-scrim" onClick={busy ? undefined : onCancel} aria-hidden />
      <div className="i2-modal" role="alertdialog" aria-modal="true" tabIndex={-1} ref={ref}>
        <h2>{title}</h2>
        {body ? <p>{body}</p> : null}
        <div className="i2-actions">
          <InvButton kind={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </InvButton>
          <InvButton kind="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </InvButton>
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ============================================================ formatting === */
export function formatMoney(n: number | null | undefined, digits: 0 | 2 = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₪${n.toLocaleString("he-IL", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
export function formatQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("he-IL", { maximumFractionDigits: 3 });
}
