"use client";

/**
 * Shared Service Desk screen pieces (UI 1.3a): the head with Dubiz's "חזרה" control, loading / error states, the notice
 * for a business the module is not open to, and the read-only banner. Hebrew only.
 */
import type { ReactNode } from "react";

import BackButton from "@/components/ui/back-button";

import s from "./sd.module.css";

export function ScreenHead({ title, subtitle, fallback, fallbackLabel, onBeforeLeave }: {
  title: string;
  subtitle?: ReactNode;
  fallback: string;
  fallbackLabel: string;
  onBeforeLeave?: (proceed: () => void) => void;
}) {
  return (
    <header className={s.head}>
      <div className={s.headBar}>
        <BackButton fallback={fallback} fallbackLabel={fallbackLabel} onBeforeLeave={onBeforeLeave} />
      </div>
      <div className={s.headCenter}>
        <h1 className={s.title}>{title}</h1>
        {subtitle ? <p className={s.subtitle}>{subtitle}</p> : null}
      </div>
    </header>
  );
}

export function Loading() {
  return (
    <div className={s.skel} role="status" aria-live="polite">
      <span className={s.skelBar} style={{ width: "70%" }} />
      <span className={s.skelBar} style={{ width: "90%" }} />
      <span className={s.skelBar} style={{ width: "55%" }} />
      <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>טוען…</span>
    </div>
  );
}

export function LoadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className={s.error} role="alert">
      <span>{text}</span>
      <div>
        <button type="button" className={s.button} onClick={onRetry}>לנסות שוב</button>
      </div>
    </div>
  );
}

/** Mode NONE: the module is not open to this business (the default while service_desk is off). */
export function NotOpen() {
  return (
    <div className={s.empty}>
      <h2>מערכת השירות עדיין לא פתוחה לעסק</h2>
      <p className={s.note}>היא תיפתח אחרי שהבעלים יאשרו אותה.</p>
    </div>
  );
}

export function ReadOnlyBanner() {
  return <p className={s.banner} role="status">מערכת השירות פתוחה אצלך לצפייה בלבד. אפשר לראות את ההגדרות, לא לשנות אותן.</p>;
}

/** A planned part that is not available yet — shown muted, with no control, so it never looks active. */
export function Later({ title, text }: { title: string; text: string }) {
  return (
    <div className={s.later}>
      <span className={s.laterText}>
        <span className={s.laterTitle}>{title}</span>
        <span className={s.hint}>{text}</span>
      </span>
      <span className={s.tag}>עוד לא זמין</span>
    </div>
  );
}

export function Chevron() {
  // RTL: "forward" points left.
  return (
    <svg className={s.chevron} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
