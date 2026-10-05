/**
 * Warm-surface primitives. See warm-surface.module.css for the language.
 *
 * Icons: a tile carries the EXISTING colourful Dubiz icon (today the Settings
 * emoji) — the tile supplies only the tone background around it. Never pass a
 * monochrome replacement icon in.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import { ChevronGlyph } from "./glyphs";
import styles from "./warm-surface.module.css";

export { styles as warmStyles };

export type WarmTone = "teal" | "violet" | "amber" | "blue" | "stone";

const TONE_CLASS: Record<WarmTone, string> = {
  teal: styles.toneTeal,
  violet: styles.toneViolet,
  amber: styles.toneAmber,
  blue: styles.toneBlue,
  stone: styles.toneStone,
};

export function toneClass(tone: WarmTone): string {
  return TONE_CLASS[tone];
}

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

export function WarmPageHeading({
  title,
  subtitle,
  actions,
  className,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx(styles.heading, className)}>
      <div className={styles.headingText}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
      </div>
      {actions ? <div className={styles.headingActions}>{actions}</div> : null}
    </header>
  );
}

/** A 44px round link carrying an existing Dubiz nav icon. Icon-only → aria-label required. */
export function WarmRoundLink({
  href,
  label,
  alert = false,
  alertLabel,
  children,
}: {
  href: string;
  label: string;
  alert?: boolean;
  alertLabel?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} aria-label={label} className={styles.roundButton}>
      {children}
      {alert ? (
        <>
          <span className={styles.alertDot} aria-hidden="true" />
          {alertLabel ? <span className={styles.srOnly}>{alertLabel}</span> : null}
        </>
      ) : null}
    </Link>
  );
}

/** The coloured square around an existing icon. `onWhite` for tiles on tinted cards. */
export function WarmTile({
  tone,
  icon,
  onWhite = false,
  className,
}: {
  tone: WarmTone;
  icon: ReactNode;
  onWhite?: boolean;
  className?: string;
}) {
  return (
    <span className={cx(styles.tile, toneClass(tone), onWhite && styles.tileOnWhite, className)} aria-hidden="true">
      {typeof icon === "string" ? <span className={styles.emoji}>{icon}</span> : icon}
    </span>
  );
}

export function WarmGroup({
  title,
  tone,
  children,
  className,
  headingId,
}: {
  title: string;
  tone: WarmTone;
  children: ReactNode;
  className?: string;
  headingId?: string;
}) {
  return (
    <section className={cx(styles.group, toneClass(tone), className)} aria-labelledby={headingId}>
      <h2 className={styles.groupHeading} id={headingId}>
        <span className={styles.groupDot} aria-hidden="true" />
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The card that holds a group's rows. Children are `<WarmRow>`s. */
export function WarmRowList({ children }: { children: ReactNode }) {
  return <ul className={styles.groupCard}>{children}</ul>;
}

export type WarmRowProps = {
  tone: WarmTone;
  icon: ReactNode;
  title: string;
  subtitle?: string;
  /** A short current value shown before the chevron ("עברית", "3 פעילים"). */
  value?: ReactNode;
  /** A pill in place of the value (e.g. "בקרוב"). */
  badge?: ReactNode;
  /**
   * Where the row goes. `null` makes a static row with no chevron — used only
   * for an area that is deliberately present but not yet available, so it
   * never looks like it leads somewhere.
   */
  href: string | null;
  /** External/mail links render as a plain anchor. */
  external?: boolean;
};

export function WarmRow({ tone, icon, title, subtitle, value, badge, href, external = false }: WarmRowProps) {
  const body = (
    <>
      <WarmTile tone={tone} icon={icon} />
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>{title}</span>
        {subtitle ? <span className={styles.rowSubtitle}>{subtitle}</span> : null}
      </span>
      {badge ?? (value != null ? <span className={styles.rowValue}>{value}</span> : null)}
      {href ? <ChevronGlyph className={styles.chevron} /> : null}
    </>
  );

  return (
    <li>
      {href === null ? (
        <div className={styles.row}>{body}</div>
      ) : external ? (
        <a href={href} className={styles.row}>
          {body}
        </a>
      ) : (
        <Link href={href} className={styles.row}>
          {body}
        </Link>
      )}
    </li>
  );
}

export function WarmPill({
  tone = "sand",
  children,
  className,
}: {
  tone?: "sand" | "mint" | "neutral";
  children: ReactNode;
  className?: string;
}) {
  const toneCls = tone === "mint" ? styles.pillMint : tone === "neutral" ? styles.pillNeutral : styles.pillSand;
  return <span className={cx(styles.pill, toneCls, className)}>{children}</span>;
}

export function WarmSkeleton({ label = "טוען" }: { label?: string }) {
  return (
    <span className={styles.skeleton} role="status">
      <span className={styles.srOnly}>{label}</span>
    </span>
  );
}
