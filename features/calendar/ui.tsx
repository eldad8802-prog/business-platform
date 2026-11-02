"use client";

/**
 * The feature's shared pieces (design direction A): line icons, the screen header with Dubiz's own back control at the
 * start edge, a switch, a segmented choice, the loading / error / empty states and the toast. Every calendar screen,
 * sheet and settings page is built from these and from calendar.module.css — one look for the whole feature.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type SVGProps } from "react";

import BackButton from "@/components/ui/back-button";

import type { AppointmentWire } from "./calendar-model";
import s from "./calendar.module.css";

// ── Icons (24px grid, 1.7 stroke, currentColor) ───────────────────────────────────────────────────

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function svg(paths: ReactNode, { size = 22, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {paths}
    </svg>
  );
}

export const IconClock = (p: IconProps) => svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>, p);
export const IconUsers = (p: IconProps) => svg(<><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19c.6-3 2.8-4.7 5.5-4.7s4.9 1.7 5.5 4.7" /><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.6c1.6.6 2.7 2.1 3 4.4" /></>, p);
export const IconUser = (p: IconProps) => svg(<><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></>, p);
export const IconScissors = (p: IconProps) => svg(<><circle cx="6.5" cy="17.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /><path d="M8.3 15.7 18 4M15.7 15.7 6 4" /></>, p);
export const IconCalendar = (p: IconProps) => svg(<><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>, p);
export const IconLink = (p: IconProps) => svg(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>, p);
export const IconPlus = (p: IconProps) => svg(<path d="M12 5v14M5 12h14" />, p);
export const IconCheck = (p: IconProps) => svg(<path d="m5 12.5 4.5 4.5L19 7.5" />, p);
export const IconX = (p: IconProps) => svg(<path d="M6 6l12 12M18 6 6 18" />, p);
export const IconAlert = (p: IconProps) => svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5.5M12 16.2v.3" /></>, p);
export const IconLock = (p: IconProps) => svg(<><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>, p);
export const IconBlock = (p: IconProps) => svg(<><circle cx="12" cy="12" r="8.5" /><path d="M6 6l12 12" /></>, p);
export const IconGear = (p: IconProps) => svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></>, p);
export const IconBell = (p: IconProps) => svg(<><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15Z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>, p);
export const IconPhone = (p: IconProps) => svg(<path d="M5 4.5h3.2l1.6 4-2 1.3a10.5 10.5 0 0 0 6.4 6.4l1.3-2 4 1.6V19a1.5 1.5 0 0 1-1.6 1.5A15.5 15.5 0 0 1 3.5 6.1 1.5 1.5 0 0 1 5 4.5Z" />, p);
export const IconChat = (p: IconProps) => svg(<path d="M4.5 19.5 5.6 16A7.5 7.5 0 1 1 8.4 18.6Z" />, p);
export const IconHourglass = (p: IconProps) => svg(<path d="M7 4h10M7 20h10M8 4c0 4 8 4 8 8s-8 4-8 8M16 4c0 4-8 4-8 8s8 4 8 8" />, p);
export const IconHistory = (p: IconProps) => svg(<><path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" /><path d="M4 4.5v4h4M12 8v4l2.5 1.5" /></>, p);
export const IconMove = (p: IconProps) => svg(<><path d="M12 3v18M3 12h18" /><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" /></>, p);
export const IconEdit = (p: IconProps) => svg(<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z" />, p);
export const IconCopy = (p: IconProps) => svg(<><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>, p);

/** A chevron that points in reading terms: "prev" → (right in RTL), "next" ← (left), "open" (a row's arrow, ←), "down". */
export function Chevron({ dir, size = 20 }: { dir: "prev" | "next" | "open" | "down" | "up"; size?: number }) {
  const d = dir === "prev" ? "M9 6l6 6-6 6" : dir === "down" ? "M6 9l6 6 6-6" : dir === "up" ? "M6 15l6-6 6 6" : "M15 6l-6 6 6 6";
  return svg(<path d={d} />, { size });
}

// ── The state mark of an appointment: an icon, never colour alone ─────────────────────────────────

/** The mark a block shows for its state (null for a plain confirmed appointment). */
export function markOf(a: Pick<AppointmentWire, "kind" | "status">): "PROPOSED" | "COMPLETED" | "NO_SHOW" | "CANCELED" | "BLOCK" | "INTERNAL" | null {
  if (a.status === "CANCELED") return "CANCELED";
  if (a.kind === "BLOCK") return "BLOCK";
  if (a.status === "PROPOSED" || a.status === "COMPLETED" || a.status === "NO_SHOW") return a.status;
  if (a.kind === "INTERNAL") return "INTERNAL";
  return null;
}

export function StateMark({ mark, size = 13 }: { mark: NonNullable<ReturnType<typeof markOf>>; size?: number }) {
  const icon =
    mark === "PROPOSED" ? <IconHourglass size={size} strokeWidth={2} />
      : mark === "COMPLETED" ? <IconCheck size={size} strokeWidth={2.4} />
        : mark === "NO_SHOW" ? <IconAlert size={size} strokeWidth={2.2} />
          : mark === "CANCELED" ? <IconX size={size} strokeWidth={2.2} />
            : mark === "BLOCK" ? <IconBlock size={size} strokeWidth={2} />
              : <IconUsers size={size} strokeWidth={2} />;
  return <span className={`${s.mark} ${s[`mark_${mark}`]}`} aria-hidden="true">{icon}</span>;
}

// ── Header ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A screen's head: Dubiz's back control at the start edge (right), the title centred with one line of context, and
 * an optional action at the end edge. A root screen passes `root` (back shows only when there is a real origin).
 */
export function ScreenHead({
  title,
  subtitle,
  end,
  root,
  fallback,
  fallbackLabel,
  onBeforeLeave,
}: {
  title: string;
  subtitle?: ReactNode;
  end?: ReactNode;
  root?: boolean;
  fallback?: string;
  fallbackLabel?: string;
  onBeforeLeave?: (proceed: () => void) => void;
}) {
  return (
    <header className={s.calHead}>
      <div className={s.headBar}>
        <BackButton hideWithoutOrigin={root} fallback={fallback} fallbackLabel={fallbackLabel} onBeforeLeave={onBeforeLeave} />
      </div>
      <div className={s.headCenter}>
        <h1 className={s.title}>{title}</h1>
        {subtitle ? <p className={s.subtitle}>{subtitle}</p> : null}
      </div>
      <div className={s.calHeadEnd}>{end}</div>
    </header>
  );
}

// ── Controls ──────────────────────────────────────────────────────────────────────────────────────

export function Switch({ id, checked, onChange, disabled, label }: { id?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={s.switch} onClick={() => onChange(!checked)}>
      <span aria-hidden="true" />
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange, label, disabled, small }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string; disabled?: boolean; small?: boolean }) {
  return (
    <div className={`${s.seg} ${small ? s.segSm : ""}`} role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabled} onClick={() => value !== v && onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

// ── States ────────────────────────────────────────────────────────────────────────────────────────

export function Loading({ label = "טוען…", rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div className={s.skel} aria-busy="true" role="status">
      <span className={s.sr}>{label}</span>
      {Array.from({ length: rows }, (_, i) => <span key={i} className={s.skelBar} style={{ width: `${[82, 64, 74, 56, 68][i % 5]}%` }} />)}
    </div>
  );
}

/** A load that failed — never shown as "nothing here": the reason and a retry. */
export function LoadError({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className={`${s.banner} ${s.bannerBad}`} role="alert">
      <IconAlert size={20} />
      <span className={s.bannerText}>{text}</span>
      {onRetry ? <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={onRetry}>לנסות שוב</button> : null}
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <section className={s.empty}>
      {icon ? <span className={s.emptyIcon}>{icon}</span> : null}
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** The feature is not open for this business (the `appointments` flag): a clear closed state, nothing fetched. */
export function FeatureOff({ title }: { title: string }) {
  return (
    <main className={s.screen}>
      <ScreenHead title={title} fallback="/app" />
      <Empty title="היומן עדיין לא פעיל לעסק שלך" icon={<IconCalendar size={36} />}>
        <span>כשהיומן ייפתח, יופיעו כאן התורים והפגישות של העסק.</span>
      </Empty>
    </main>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────────────────────────

export type ToastAction = { label: string; run: () => void };

export function useToast() {
  const [toast, setToast] = useState<{ text: string; action?: ToastAction } | null>(null);
  const timer = useRef<number | null>(null);
  const flash = useCallback((text: string, action?: ToastAction) => {
    if (timer.current) window.clearTimeout(timer.current);
    setToast({ text, action });
    timer.current = window.setTimeout(() => setToast(null), action ? 8000 : 5000);
  }, []);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const node = toast ? (
    <div className={s.toast} role="status">
      <span>{toast.text}</span>
      {toast.action ? <button type="button" onClick={() => { const a = toast.action!; setToast(null); a.run(); }}>{toast.action.label}</button> : null}
    </div>
  ) : null;
  return { flash, node };
}

/** Closing the tab or reloading with unsaved changes asks first (the browser's own question). */
export function useBeforeUnload(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

/** "לצאת בלי לשמור?" — the inline question shown before unsaved changes are dropped. */
export function LeaveConfirm({ what, onStay, onLeave }: { what?: string; onStay: () => void; onLeave: () => void }) {
  return (
    <div className={s.confirm} role="alertdialog" aria-labelledby="leave-q" aria-describedby="leave-d">
      <strong id="leave-q">יש שינויים שלא נשמרו{what ? ` ב${what}` : ""}.</strong>
      <span id="leave-d">לצאת בלי לשמור? השינויים יאבדו.</span>
      <div className={s.confirmRow}>
        <button type="button" className={`${s.btn} ${s.btnPri}`} autoFocus onClick={onStay}>להישאר</button>
        <button type="button" className={`${s.btn}`} onClick={onLeave}>לצאת בלי לשמור</button>
      </div>
    </div>
  );
}
