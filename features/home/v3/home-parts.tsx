"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import {
  IconBox,
  IconBriefcase,
  IconCalendar,
  IconCard,
  IconCash,
  IconChevronLeft,
  IconFileLines,
  IconSparkle,
  IconTrend,
  IconUserPlus,
  IconUsers,
  IconWallet,
  type IconComponent,
} from "@/components/navigation/nav-icons";
import { TOOL_GROUPS, categoryHref } from "@/lib/navigation/home-routes";
import { useI18n } from "@/components/i18n/I18nProvider";
import dirStyles from "@/components/ui/directional.module.css";
import type { MessageKey } from "@/lib/i18n/translate";

import type { InsightView } from "./use-home-data";
import {
  countText,
  type ActivityItem,
  type ActivityKind,
  type CountClaim,
  type Load,
  type WaitingItem,
  type WaitingKind,
  type WaitingTag,
  type WaitingTone,
} from "./home-v3-model";

/**
 * The building blocks every Home layout shares — each drawn once, with the
 * per-device variants the approved references define (vertical waiting cards
 * on mobile / tablet, horizontal rows on desktop; a flat activity list on
 * mobile, a boxed one on tablet, a timeline on desktop).
 */

export const INK = "#1E2B2A";
export const MUTED = "#5E6B69";
export const CARD = "#FFFDFA";
export const LINE = "#F0E3D3";
export const DIVIDER = "#F3E8DA";
export const TEAL = "#246966";

/* ------------------------------------------------------------- headings -- */

export function ShowAll({ href, size = 14, label: labelProp }: { href: string; size?: number; label?: string }) {
  const { t } = useI18n();
  const label = labelProp ?? t("home.parts.showAll");
  return (
    <Link
      href={href}
      prefetch={false}
      className="dzh-link"
      style={{ fontSize: size, fontWeight: 500, textDecoration: "none", display: "flex", alignItems: "center", gap: 2, padding: "10px 0" }}
    >
      {label}
      {size >= 14 ? <IconChevronLeft size={16} strokeWidth={2} className={dirStyles.forward} /> : null}
    </Link>
  );
}

export function CountPill({ claim }: { claim: CountClaim }) {
  const { t } = useI18n();
  return (
    <span
      aria-label={claim.exact ? t("home.parts.countExact", { count: claim.n }) : t("home.parts.countMore", { count: claim.n })}
      style={{
        minWidth: 22,
        height: 22,
        padding: "0 6px",
        boxSizing: "border-box",
        borderRadius: 999,
        background: TEAL,
        color: "#FFFFFF",
        fontSize: 12,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {countText(claim)}
    </span>
  );
}

/** "מה ממתין לך" heading — mobile and tablet. */
export function WaitingHeading({ waiting, tablet }: { waiting: Load<{ total: CountClaim }>; tablet?: boolean }) {
  const Title = tablet ? "h2" : "span";
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Title style={{ margin: 0, fontSize: 19, fontWeight: 600 }}>{t("home.parts.waitingTitle")}</Title>
          {waiting.state === "ready" && waiting.value.total.n > 0 ? <CountPill claim={waiting.value.total} /> : null}
        </div>
        <div style={{ fontSize: 13, color: MUTED }}>{t("home.parts.waitingSub")}</div>
      </div>
      <ShowAll href="/attention" />
    </div>
  );
}

/* -------------------------------------------------------------- waiting -- */

const TONE: Record<WaitingTone, { bg: string; border: string; icon: string }> = {
  urgent: { bg: "#FDF0EC", border: "#F4D8CE", icon: "#B4432F" },
  todo: { bg: "#FDF4E7", border: "#F1DFC4", icon: "#A0601F" },
  fresh: { bg: "#EEF7F5", border: "#D4E9E5", icon: TEAL },
};

const TAG: Record<WaitingTag["style"], { color: string; background: string }> = {
  urgentSolid: { color: "#FFFFFF", background: "#C24A33" },
  urgentSoft: { color: "#8E3A28", background: "#F9DDD4" },
  todo: { color: "#8A4F16", background: "#F6E0C2" },
  fresh: { color: "#1D5552", background: "#D3ECE8" },
};

const KIND_ICON: Record<WaitingKind, IconComponent> = {
  payment: IconCalendar,
  collection: IconCard,
  stock: IconBox,
  lead: IconFileLines,
};

/** The desktop row's category tag — the same words as the filter chips. */
export const KIND_TAG: Record<WaitingKind, { labelKey: MessageKey; color: string; background: string }> = {
  payment: { labelKey: "home.parts.kind.payment", color: "#8E3A28", background: "#F9DDD4" },
  stock: { labelKey: "home.parts.kind.stock", color: "#8A4F16", background: "#F6E0C2" },
  collection: { labelKey: "home.parts.kind.collection", color: "#1D5552", background: "#D3ECE8" },
  lead: { labelKey: "home.parts.kind.lead", color: "#5B4FA8", background: "#ECE9F7" },
};

/** Vertical card — mobile (3 in a row) and tablet (3 in a row). */
export function WaitingCard({ item, tablet }: { item: WaitingItem; tablet?: boolean }) {
  const tone = TONE[item.tone];
  const Icon = KIND_ICON[item.kind];
  return (
    <div
      style={{
        borderRadius: tablet ? 20 : 18,
        padding: tablet ? 14 : 12,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
        <span
          style={{
            width: tablet ? 38 : 34,
            height: tablet ? 38 : 34,
            flexShrink: 0,
            borderRadius: tablet ? 12 : 11,
            background: "#FFFFFF",
            color: tone.icon,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon size={tablet ? 19 : 18} />
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 999, padding: tablet ? "3px 9px" : "3px 8px", whiteSpace: "nowrap", ...TAG[item.tag.style] }}>
          {item.tag.label}
        </span>
      </div>
      <div style={{ fontSize: tablet ? 15 : 14, fontWeight: 600, lineHeight: 1.3, overflowWrap: "anywhere" }}>{item.title}</div>
      {item.subtitle || item.amount ? (
        <div style={{ fontSize: 12, color: MUTED, lineHeight: tablet ? 1.45 : 1.4, overflowWrap: "anywhere" }}>
          {item.subtitle}
          {item.subtitle && item.amount ? <br /> : null}
          {item.amount ? <span style={{ fontSize: tablet ? 15 : 14, fontWeight: 600, color: INK }}>{item.amount}</span> : null}
        </div>
      ) : null}
      <div style={{ flex: 1 }} />
      <Link
        href={item.href}
        prefetch={false}
        className="dzh-btn"
        style={{
          height: tablet ? 40 : 36,
          minHeight: 36,
          borderRadius: 12,
          background: TEAL,
          color: "#FFFFFF",
          fontSize: 13,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textDecoration: "none",
        }}
      >
        {item.actionLabel}
      </Link>
    </div>
  );
}

/** Horizontal row — the desktop "מה מחכה" panel. */
export function WaitingRow({ item }: { item: WaitingItem }) {
  const tone = TONE[item.tone];
  const Icon = KIND_ICON[item.kind];
  const tag = KIND_TAG[item.kind];
  const { t } = useI18n();
  // Desktop offers the next step the stock row actually needs: ordering.
  const action =
    item.kind === "stock"
      ? { label: t("home.parts.order"), href: "/inventory/supplier-purchases/new" }
      : { label: item.actionLabel, href: item.href };
  return (
    <div
      style={{
        borderRadius: 16,
        padding: 12,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span
        style={{
          width: 38,
          height: 38,
          flexShrink: 0,
          borderRadius: 11,
          background: "#FFFFFF",
          color: tone.icon,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={18} />
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.title}</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: tag.color, background: tag.background, borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" }}>
            {t(tag.labelKey)}
          </span>
        </span>
        <span style={{ fontSize: 12, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {[item.subtitle, item.amount].filter(Boolean).join(" · ")}
        </span>
      </span>
      <Link
        href={action.href}
        prefetch={false}
        className="dzh-btn"
        style={{
          height: 36,
          padding: "0 14px",
          borderRadius: 11,
          background: TEAL,
          color: "#FFFFFF",
          fontSize: 13,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          textDecoration: "none",
          flexShrink: 0,
        }}
      >
        {action.label}
      </Link>
    </div>
  );
}

/** The honest empty / failed line, in the place the content would be. */
export function Note({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5, padding: "10px 0", ...style }} role="status">
      {children}
    </div>
  );
}

export function SkeletonBlock({ h, r = 16, style }: { h: number; r?: number; style?: CSSProperties }) {
  return <div aria-hidden className="animate-pulse" style={{ height: h, borderRadius: r, background: "#F6EDE2", ...style }} />;
}

/* -------------------------------------------------------- feature tiles -- */

const FAMILY_VISUAL: Record<string, { icon: IconComponent; color: string; bg: string; sub: MessageKey }> = {
  money: { icon: IconWallet, color: TEAL, bg: "#E3F2F0", sub: "home.parts.family.money" },
  customers: { icon: IconUsers, color: "#5B4FA8", bg: "#ECE9F7", sub: "home.parts.family.customers" },
  operations: { icon: IconBriefcase, color: "#A0601F", bg: "#FBEEDD", sub: "home.parts.family.operations" },
};

/** The three families, symmetric — no "כל הכלים" tile (approved design). */
export function FeatureTiles({ height, gap }: { height: number; gap: number }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("home.parts.toolGroupsAria")} style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap }}>
      {TOOL_GROUPS.map((group) => {
        const v = FAMILY_VISUAL[group.key];
        const Icon = v.icon;
        return (
          <Link
            key={group.key}
            href={categoryHref(group)}
            prefetch={false}
            className="dzh-tile"
            style={{
              textDecoration: "none",
              color: INK,
              // A minimum, not a fixed height: where the tile is narrow its sub-line wraps and the row grows
              // evenly (grid stretch) instead of the text spilling out of the card.
              minHeight: height,
              boxSizing: "border-box",
              borderRadius: 20,
              padding: "16px 6px",
              background: CARD,
              border: `1px solid ${LINE}`,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              textAlign: "center",
              minWidth: 0,
            }}
          >
            <span style={{ width: 48, height: 48, borderRadius: 16, background: v.bg, color: v.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon size={22} />
            </span>
            <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, maxWidth: "100%" }}>
              <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3, maxWidth: "100%", overflowWrap: "break-word", textWrap: "balance" }}>{group.label}</span>
              <span style={{ fontSize: 12, lineHeight: 1.35, color: MUTED, maxWidth: "100%", overflowWrap: "break-word", textWrap: "balance" }}>{t(v.sub)}</span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------- activity -- */

const ACTIVITY_VISUAL: Record<ActivityKind, { icon: IconComponent; color: string; bg: string }> = {
  collected: { icon: IconCash, color: TEAL, bg: "#E3F2F0" },
  lead: { icon: IconUserPlus, color: "#5B4FA8", bg: "#ECE9F7" },
  document: { icon: IconFileLines, color: "#A0601F", bg: "#FBEEDD" },
};

/**
 * "פעולות אחרונות". The references carry a "הצג הכל" here; there is no screen
 * that lists all of these together, so it is not drawn (TODO(future): an
 * activity feed route).
 */
export function ActivityList({
  activity,
  variant,
  when,
}: {
  activity: Load<ActivityItem[]>;
  variant: "flat" | "boxed" | "timeline";
  when: (iso: string) => string;
}) {
  const { t } = useI18n();
  const title = t("home.parts.activityTitle");
  const heading =
    variant === "flat" ? (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 44 }}>
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 600 }}>{title}</h2>
      </div>
    ) : (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 40 }}>
        <h2 style={{ margin: 0, fontSize: variant === "boxed" ? 17 : 16, fontWeight: 600 }}>{title}</h2>
      </div>
    );

  let body: ReactNode;
  if (activity.state === "loading") {
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "6px 0" }}>
        <SkeletonBlock h={40} r={12} />
        <SkeletonBlock h={40} r={12} />
        <SkeletonBlock h={40} r={12} />
      </div>
    );
  } else if (activity.state === "failed") {
    body = <Note>{t("home.parts.activityFailed")}</Note>;
  } else if (activity.value.length === 0) {
    body = <Note>{t("home.parts.activityEmpty")}</Note>;
  } else if (variant === "timeline") {
    body = activity.value.map((a, i) => {
      const v = ACTIVITY_VISUAL[a.kind];
      const Icon = v.icon;
      const last = i === activity.value.length - 1;
      return (
        <Link key={a.id} href={a.href} prefetch={false} className="dzh-row" style={{ display: "flex", gap: 12, textDecoration: "none", color: INK }}>
          <span style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 34, flexShrink: 0 }}>
            <span style={{ width: 34, height: 34, borderRadius: 999, background: v.bg, color: v.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon size={16} />
            </span>
            {last ? null : <span style={{ flex: 1, width: 2, background: "#EFE3D3", minHeight: 10 }} />}
          </span>
          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1, padding: last ? "2px 0" : "2px 0 10px" }}>
            <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{a.title}</span>
              <span style={{ fontSize: 12, color: MUTED, flexShrink: 0 }}>{when(a.at)}</span>
            </span>
            {a.detail ? <span style={{ fontSize: 12, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.detail}</span> : null}
          </span>
        </Link>
      );
    });
  } else {
    body = activity.value.map((a, i) => {
      const v = ACTIVITY_VISUAL[a.kind];
      const Icon = v.icon;
      return (
        <div key={a.id}>
          {i > 0 ? <div style={{ height: 1, background: DIVIDER, marginInlineStart: 52 }} /> : null}
          <Link href={a.href} prefetch={false} className="dzh-row" style={{ textDecoration: "none", color: INK, display: "flex", alignItems: "center", gap: 12, padding: "10px 0" }}>
            <span style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 999, background: v.bg, color: v.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon size={19} />
            </span>
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{a.title}</span>
              {a.detail ? <span style={{ fontSize: 12, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.detail}</span> : null}
            </span>
            <span style={{ fontSize: 12, color: MUTED, flexShrink: 0 }}>{when(a.at)}</span>
          </Link>
        </div>
      );
    });
  }

  if (variant === "flat") {
    return (
      <section aria-label={title} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {heading}
        <div style={{ display: "flex", flexDirection: "column" }}>{body}</div>
      </section>
    );
  }
  return (
    <section
      aria-label={title}
      style={{
        borderRadius: variant === "boxed" ? 20 : 22,
        padding: variant === "boxed" ? "16px 18px 6px" : 18,
        background: CARD,
        border: `1px solid ${LINE}`,
        display: "flex",
        flexDirection: "column",
        gap: variant === "boxed" ? 4 : 6,
        minWidth: 0,
        boxSizing: "border-box",
      }}
    >
      {heading}
      {body}
    </section>
  );
}

/* -------------------------------------------------------------- insight -- */

/** "התובנה של Dubiz" — drawn only when the backend actually has an insight. */
export function InsightCard({ insight, wide, style }: { insight: Load<InsightView | null>; wide?: boolean; style?: CSSProperties }) {
  const { t } = useI18n();
  if (insight.state !== "ready" || insight.value === null) return null;
  const v = insight.value;
  return (
    <Link
      href={v.href}
      prefetch={false}
      className="dzh-insight"
      style={{
        textDecoration: "none",
        color: INK,
        borderRadius: wide ? 22 : 20,
        padding: wide ? "20px 24px" : 16,
        background: "#E9F5F3",
        display: "flex",
        alignItems: "center",
        gap: wide ? 20 : 14,
        minWidth: 0,
        ...style,
      }}
    >
      <span
        style={{
          width: wide ? 60 : 52,
          height: wide ? 60 : 52,
          flexShrink: 0,
          borderRadius: wide ? 18 : 16,
          background: TEAL,
          color: "#FFFFFF",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <IconTrend size={wide ? 26 : 24} strokeWidth={2} />
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#1D5552" }}>
          <IconSparkle size={14} strokeWidth={2} />
          {t("home.parts.insightEyebrow")}
        </span>
        <span style={{ fontSize: wide ? 18 : 15, fontWeight: 600 }}>{v.title}</span>
        {v.body ? <span style={{ fontSize: wide ? 14 : 12, color: "#4F5C5A" }}>{v.body}</span> : null}
      </span>
      {wide ? null : (
        <span style={{ color: TEAL, display: "flex" }}>
          <IconChevronLeft size={18} strokeWidth={2} className={dirStyles.forward} />
        </span>
      )}
    </Link>
  );
}

/* ------------------------------------------------- tell us (identity) -- */

/**
 * One small item in "מה ממתין לך" while the owner has not described the
 * business (skipped it at signup). It is not counted as something urgent and
 * it disappears once a description exists.
 */
const IDENTITY_PROMPT = {
  title: "home.parts.identityTitle",
  subtitle: "home.parts.identitySubtitle",
  action: "home.parts.identityAction",
  href: "/setup",
} as const satisfies { title: MessageKey; subtitle: MessageKey; action: MessageKey; href: string };

export function IdentityPromptRow() {
  const { t } = useI18n();
  return (
    <div style={{ borderRadius: 16, padding: 12, background: "#FBF4EA", border: "1px solid #F1E2CC", display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: "#8A4F16", background: "#F6E0C2", borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" }}>{t("home.parts.identityTag")}</span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{t(IDENTITY_PROMPT.title)}</span>
        <span style={{ fontSize: 12, color: MUTED }}>{t(IDENTITY_PROMPT.subtitle)}</span>
      </span>
      <Link href={IDENTITY_PROMPT.href} prefetch={false} className="dzh-link" style={{ fontSize: 13, fontWeight: 600, textDecoration: "none", padding: "10px 4px" }}>
        {t(IDENTITY_PROMPT.action)}
      </Link>
    </div>
  );
}

export function IdentityPromptCard({ tablet }: { tablet?: boolean }) {
  const { t } = useI18n();
  return (
    <Link
      href={IDENTITY_PROMPT.href}
      prefetch={false}
      style={{
        borderRadius: tablet ? 20 : 18,
        padding: tablet ? 14 : 12,
        background: "#FBF4EA",
        border: "1px solid #F1E2CC",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
        textDecoration: "none",
        color: INK,
      }}
    >
      <span style={{ alignSelf: "flex-start", fontSize: 11, fontWeight: 600, color: "#8A4F16", background: "#F6E0C2", borderRadius: 999, padding: "3px 8px" }}>{t("home.parts.identityTag")}</span>
      <span style={{ fontSize: tablet ? 15 : 14, fontWeight: 600, lineHeight: 1.3 }}>{t(IDENTITY_PROMPT.title)}</span>
      <span style={{ fontSize: 12, color: MUTED, lineHeight: 1.4 }}>{t(IDENTITY_PROMPT.subtitle)}</span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 13, fontWeight: 600, color: TEAL }}>{t(IDENTITY_PROMPT.action)}</span>
    </Link>
  );
}

/* ---------------------------------------------------------- page styles -- */

/** Hover / focus for the Home's own links and buttons (inline styles cannot). */
export const HOME_CSS = `
.dzh-root a { color: inherit; }
.dzh-root .dzh-link { color: #246966; }
.dzh-root .dzh-link:hover { color: #1D5552; }
.dzh-root .dzh-btn:hover { background: #1D5552 !important; }
.dzh-root .dzh-tile:hover, .dzh-root .dzh-insight:hover { border-color: #E3D2BD; filter: brightness(0.99); }
.dzh-root .dzh-row:hover { background: rgba(240,227,211,0.35); border-radius: 12px; }
.dzh-root a:focus-visible, .dzh-root button:focus-visible, .dzh-root input:focus-visible {
  outline: 2px solid #246966; outline-offset: 2px;
}
.dzh-root ::placeholder { color: #7A8583; }
/* Narrow phones (under 390): the card header keeps "הכנסות והוצאות" on one
   line by giving the period buttons a little less side padding. The info
   button keeps its 44px target. Below 360 the title may wrap — it never
   overflows. */
@media (min-width: 360px) { .dzh-root .dzh-cash-title { white-space: nowrap; } }
@media (max-width: 389.98px) { .dzh-root .dzh-period-btn { padding-inline: 10px !important; } }
`;
