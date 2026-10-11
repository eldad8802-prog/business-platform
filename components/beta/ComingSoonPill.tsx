/**
 * Closed-beta "בקרוב" status — one look everywhere an integration is not yet open to this business.
 *
 * Display only: the server refuses the gated actions by itself (lib/beta/beta-gate.ts). Never render a
 * button that starts the integration next to these.
 */
import type { ReactNode } from "react";

import { WarmPill } from "@/components/ui/warm-surface/warm-surface";
import styles from "./ComingSoonNote.module.css";

export function ComingSoonPill({ className }: { className?: string }) {
  return (
    <WarmPill tone="sand" className={className}>
      בקרוב
    </WarmPill>
  );
}

/** A small calm inline note: the pill + an optional title + a one-line explanation. */
export function ComingSoonNote({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `${styles.note} ${className}` : styles.note} dir="rtl">
      <ComingSoonPill className={styles.pill} />
      <div className={styles.body}>
        {title ? <p className={styles.title}>{title}</p> : null}
        {children ? <p className={styles.text}>{children}</p> : null}
      </div>
    </div>
  );
}
