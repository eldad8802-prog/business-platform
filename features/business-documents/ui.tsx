"use client";

/**
 * Shared screen pieces for the business-documents screens (ר1–ר3): a head with Dubiz's
 * "חזרה" control, loading / error / empty states and the feature-off notice. Hebrew only.
 */
import type { ReactNode } from "react";

import BackButton from "@/components/ui/back-button";

import s from "./docs.module.css";

export function ScreenHead({ title, subtitle, fallback, fallbackLabel }: { title: string; subtitle?: ReactNode; fallback: string; fallbackLabel: string }) {
  return (
    <header className={s.head}>
      <div className={s.headBar}>
        <BackButton fallback={fallback} fallbackLabel={fallbackLabel} />
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

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={s.empty}>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** Shown while the business_documents feature is off for the business (the default). */
export function FeatureOff() {
  return (
    <Empty title="המסך הזה עדיין לא פתוח לעסק">
      <p className={s.note}>הוא ייפתח אחרי שהבעלים יאשרו אותו.</p>
    </Empty>
  );
}
