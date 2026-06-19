"use client";

import type { CSSProperties, ReactNode } from "react";
import {
  inventoryRadius,
  inventorySpacing,
  inventoryTheme as inventoryTokenTheme,
  inventoryToneStyles,
  type InventoryTone,
} from "@/components/inventory/inventory-tokens";
import {
  InventoryHeader,
  type InventoryHeaderAction as InventoryHeaderActionType,
} from "@/components/inventory/inventory-primitives";

export const inventoryTheme = inventoryTokenTheme;

// Re-export shared primitives so existing imports from inventory-design keep working.
export {
  InventoryHeader,
  IconChevronStart,
  IconPlus,
  IconEdit,
  SegmentedControl,
  FilterChipRow,
  Stepper,
  MiniStepper,
  ConfidencePill,
  DecisionCard,
  DecisionChips,
  BottomActionBar,
  SaveBar,
  BottomSheet,
  SheetActions,
  ConfirmModal,
  WizardSteps,
  ProductHero,
  ProductTags,
  StockStatusBlock,
  KeyValueGrid,
  MovementRow,
  DetailActions,
  InventorySearch,
  InventoryProductRow,
  InventoryRow,
  InventoryOrderLine,
  InventoryBadge,
  IconSearch,
  IconScan,
  stockPalette,
  type InventoryHeaderAction,
  type ConfidenceLevel,
  type DecisionChoice,
  type StockTone,
  type DetailAction,
  type BadgeTone,
} from "@/components/inventory/inventory-primitives";

export function inventoryPageStyle(): CSSProperties {
  return {
    minHeight: "100vh",
    background: inventoryTheme.pageBg,
    direction: "rtl",
  };
}

export function inventoryMainStyle(maxWidth = 920): CSSProperties {
  return {
    maxWidth,
    margin: "0 auto",
    padding: `${inventorySpacing.lg}px ${inventorySpacing.lg}px ${inventorySpacing.xxxl}px`,
    display: "flex",
    flexDirection: "column",
    gap: inventorySpacing.lg,
    boxSizing: "border-box",
  };
}

export function inventoryCardStyle(extra?: CSSProperties): CSSProperties {
  return {
    background: inventoryTheme.cardBg,
    border: `1px solid ${inventoryTheme.cardBorder}`,
    borderRadius: inventoryRadius.lg,
    padding: inventorySpacing.lg,
    boxShadow: inventoryTheme.cardShadow,
    ...extra,
  };
}

type Tone = InventoryTone;

const toneStyles = inventoryToneStyles;

export function AttentionCard({
  label,
  count,
  tone,
  icon,
  onClick,
  unitLabel = "פריטים",
}: {
  label: string;
  count: number;
  tone: Tone;
  icon: ReactNode;
  onClick?: () => void;
  unitLabel?: string;
}) {
  const t = toneStyles[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: inventoryRadius.lg,
        background: t.bg,
        padding: `${inventorySpacing.lg}px ${inventorySpacing.md}px`,
        textAlign: "right",
        cursor: onClick ? "pointer" : "default",
        display: "flex",
        flexDirection: "column",
        gap: inventorySpacing.sm,
        minHeight: 118,
        width: "100%",
        boxShadow: "0 4px 12px rgba(15, 23, 42, 0.04)",
        fontFamily: "inherit",
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: inventoryRadius.md,
          background: t.iconBg,
          color: t.color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icon}
      </div>
      <div style={{ fontSize: 30, fontWeight: 950, color: t.color, lineHeight: 1 }}>
        {count}
      </div>
      <div style={{ fontSize: 13, fontWeight: 800, color: t.color, lineHeight: 1.35 }}>
        {label}
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color: inventoryTheme.textMuted }}>
        {unitLabel}
      </div>
    </button>
  );
}

export function QuickActionTile({
  label,
  tone,
  icon,
  onClick,
  outline,
  className,
}: {
  label: string;
  tone: Tone;
  icon: ReactNode;
  onClick: () => void;
  outline?: boolean;
  className?: string;
}) {
  const t = toneStyles[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={className}
      style={{
        border: outline
          ? `2px solid ${inventoryTheme.accent}`
          : `1px solid ${inventoryTheme.cardBorder}`,
        borderRadius: inventoryRadius.lg,
        background: outline ? "#eff6ff" : inventoryTheme.cardBg,
        padding: `${inventorySpacing.lg}px ${inventorySpacing.sm}px`,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        minHeight: 102,
        boxShadow: "0 4px 12px rgba(15, 23, 42, 0.04)",
        fontFamily: "inherit",
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: inventoryRadius.lg,
          background: t.iconBg,
          color: t.color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icon}
      </div>
      <span
        style={{
          fontSize: 12,
          fontWeight: 800,
          color: inventoryTheme.text,
          lineHeight: 1.3,
          textAlign: "center",
        }}
      >
        {label}
      </span>
    </button>
  );
}

export function SectionHeader({
  title,
  badge,
  action,
  icon,
  badgeTone = "purple",
}: {
  title: string;
  badge?: string | number;
  action?: ReactNode;
  icon?: ReactNode;
  badgeTone?: "purple" | "danger";
}) {
  const badgeStyle =
    badgeTone === "danger"
      ? { background: "#fee2e2", color: inventoryTheme.danger }
      : { background: "#ede9fe", color: inventoryTheme.purple };

  return (
    <RowBetween>
      <Row gap={8} align="center">
        {icon}
        <h2
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 900,
            color: inventoryTheme.text,
          }}
        >
          {title}
        </h2>
        {badge !== undefined ? (
          <span
            style={{
              fontSize: 11,
              fontWeight: 900,
              padding: "3px 8px",
              borderRadius: 999,
              ...badgeStyle,
            }}
          >
            {badge}
          </span>
        ) : null}
      </Row>
      {action}
    </RowBetween>
  );
}

export function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: "ok" | "critical" | "low";
}) {
  const styles =
    tone === "ok"
      ? { bg: "#dcfce7", color: "#166534" }
      : tone === "critical"
        ? { bg: "#fee2e2", color: "#991b1b" }
        : { bg: "#fef3c7", color: "#92400e" };

  return (
    <span
      style={{
        display: "inline-flex",
        padding: "4px 10px",
        borderRadius: 999,
        background: styles.bg,
        color: styles.color,
        fontSize: 11,
        fontWeight: 900,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

export function StockBar({ ratio, tone }: { ratio: number; tone: "ok" | "critical" | "low" }) {
  const color =
    tone === "ok" ? "#22c55e" : tone === "critical" ? "#ef4444" : "#f59e0b";
  const pct = Math.max(0, Math.min(100, ratio * 100));

  return (
    <div
      style={{
        height: 6,
        borderRadius: 999,
        background: "#e2e8f0",
        overflow: "hidden",
        minWidth: 72,
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          borderRadius: 999,
          background: color,
        }}
      />
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  variant = "primary",
  fullWidth,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "success";
  fullWidth?: boolean;
}) {
  void variant;
  const bg = inventoryTheme.primaryBtn;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: fullWidth ? "100%" : undefined,
        minHeight: 52,
        padding: "12px 18px",
        borderRadius: inventoryRadius.sm,
        border: "none",
        background: disabled ? "#cbd5e1" : bg,
        color: "#ffffff",
        fontSize: 15,
        fontWeight: 900,
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit",
        boxShadow: disabled
          ? "none"
          : "0 12px 24px rgba(36, 59, 87, 0.22), inset 0 1px 0 rgba(255,255,255,0.22)",
      }}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        minHeight: 44,
        padding: "10px 14px",
        borderRadius: inventoryRadius.sm,
        border: `1px solid ${inventoryTheme.cardBorder}`,
        background: inventoryTheme.cardBg,
        color: inventoryTheme.text,
        fontSize: 14,
        fontWeight: 800,
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

export function InventoryStatePanel({
  title,
  children,
  tone = "neutral",
  action,
}: {
  title: string;
  children?: ReactNode;
  tone?: "neutral" | "error" | "success" | "info";
  action?: ReactNode;
}) {
  const palette =
    tone === "error"
      ? {
          border: inventoryToneStyles.danger.border,
          background: inventoryToneStyles.danger.bg,
          title: inventoryToneStyles.danger.color,
        }
      : tone === "success"
        ? {
            border: inventoryToneStyles.success.border,
            background: inventoryToneStyles.success.bg,
            title: inventoryToneStyles.success.color,
          }
        : tone === "info"
          ? {
              border: inventoryToneStyles.info.border,
              background: inventoryToneStyles.info.bg,
              title: inventoryToneStyles.info.color,
            }
          : {
              border: inventoryTheme.cardBorder,
              background: inventoryTheme.cardBg,
              title: inventoryTheme.text,
            };

  return (
    <section
      style={{
        ...inventoryCardStyle({
          borderColor: palette.border,
          background: palette.background,
          textAlign: "center",
          padding: `${inventorySpacing.xxl}px ${inventorySpacing.lg}px`,
        }),
      }}
    >
      <h2
        style={{
          margin: 0,
          color: palette.title,
          fontSize: 17,
          lineHeight: 1.35,
          fontWeight: 950,
        }}
      >
        {title}
      </h2>
      {children ? (
        <div
          style={{
            marginTop: inventorySpacing.sm,
            color: inventoryTheme.textMuted,
            fontSize: 14,
            lineHeight: 1.6,
            fontWeight: 700,
          }}
        >
          {children}
        </div>
      ) : null}
      {action ? <div style={{ marginTop: inventorySpacing.lg }}>{action}</div> : null}
    </section>
  );
}

export function InventorySkeletonBlock({
  height = 84,
  rows = 1,
}: {
  height?: number;
  rows?: number;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: inventorySpacing.sm }}>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="inv-skeleton-block"
          style={{
            height,
            borderRadius: inventoryRadius.lg,
            background:
              "linear-gradient(90deg, rgba(229,231,235,0.65), rgba(245,246,248,0.92), rgba(229,231,235,0.65))",
            backgroundSize: "220% 100%",
          }}
        />
      ))}
    </div>
  );
}

export function InventoryCtaGroup({ children }: { children: ReactNode }) {
  return <div className="inv-cta-group">{children}</div>;
}

function RowBetween({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      {children}
    </div>
  );
}

function Row({
  children,
  gap = 0,
  align = "stretch",
}: {
  children: ReactNode;
  gap?: number;
  align?: "stretch" | "center";
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: align,
        gap,
        flexWrap: "wrap",
      }}
    >
      {children}
    </div>
  );
}

/* SVG icons */
export function IconAlert() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconBox() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

export function IconClipboard() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 5h6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconQuestion() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <path
        d="M9.09 9a3 3 0 1 1 5.82 1c0 2-3 2-3 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="17" r="1" fill="currentColor" />
    </svg>
  );
}

export function IconSale() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M2 10h20" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function IconPlusBox() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconCart() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="9" cy="21" r="1" fill="currentColor" />
      <circle cx="20" cy="21" r="1" fill="currentColor" />
      <path
        d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconTruck() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M1 3h15v13H1zM16 8h4l3 3v5h-7V8z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="5.5" cy="18.5" r="2.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="18.5" cy="18.5" r="2.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function IconArrows() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconBell() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconCube() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconMenu() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function IconHome() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export function InventoryBottomNav({
  active = "home",
}: {
  active?: "home" | "products" | "sales" | "orders" | "more";
}) {
  void active;
  return null;
/*
  const router = useRouter();
  const items: Array<{
    id: typeof active;
    label: string;
    icon: ReactNode;
    href: string;
  }> = [
    { id: "home", label: "בית", icon: <IconHome />, href: "/inventory" },
    { id: "products", label: "מוצרים", icon: <IconBox />, href: "/inventory/items" },
    { id: "sales", label: "מכירות", icon: <IconSale />, href: "/inventory/sales/create" },
    { id: "orders", label: "הזמנות", icon: <IconClipboard />, href: "/inventory/supplier-purchases" },
    { id: "more", label: "עוד", icon: <span style={{ fontSize: 18, lineHeight: 1 }}>⋯</span>, href: "/inventory/supplier-purchases" },
  ];

  return (
    <nav className="inv-bottom-nav">
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => router.push(item.href)}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              padding: "8px 4px",
              color: isActive ? inventoryTheme.accent : inventoryTheme.textMuted,
              fontWeight: isActive ? 900 : 700,
              fontSize: 11,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
              {item.icon}
            </span>
            {item.label}
          </button>
        );
      })}
    </nav>
  );
*/
}

export const inventoryResponsiveCss = `
  .inv-attention-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }
  .inv-actions-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 10px;
  }
  .inv-action-span-full { grid-column: auto; }
  .inv-stock-bar-col { display: block; }
  .inv-table-head { display: grid; }
  .inv-hamburger { display: none; }
  .inv-bottom-nav {
    display: none;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 50;
    background: rgba(255,255,255,0.96);
    backdrop-filter: blur(12px);
    border-top: 1px solid #e2e8f0;
    padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
  }
  .inv-main-shell { padding-bottom: 32px; }
  @media (max-width: 720px) {
    .inv-attention-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .inv-actions-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .inv-action-span-full { grid-column: 1 / -1; }
    .inv-stock-bar-col { display: none; }
    .inv-table-head { display: none; }
    .inv-hamburger { display: flex; }
    .inv-main-shell { padding-bottom: 88px; }
  }
`;

export function getStockTone(item: {
  currentQuantity: number;
  minimumQuantity?: number;
  reorderPoint?: number | null;
}): "ok" | "critical" | "low" {
  const min = item.minimumQuantity ?? 0;
  if (item.currentQuantity <= min) return "critical";
  if (
    item.reorderPoint != null &&
    item.currentQuantity <= item.reorderPoint
  ) {
    return "low";
  }
  return "ok";
}

export function getStockStatusLabel(tone: "ok" | "critical" | "low") {
  if (tone === "critical") return "מלאי קריטי";
  if (tone === "low") return "מלאי נמוך";
  return "תקין";
}

export function getStockRatio(item: {
  currentQuantity: number;
  minimumQuantity?: number;
  reorderPoint?: number | null;
}) {
  const target =
    item.reorderPoint != null && item.reorderPoint > 0
      ? item.reorderPoint
      : Math.max(item.minimumQuantity ?? 1, 1);
  return item.currentQuantity / (target * 2);
}

type IntroTone = "accent" | "primary" | "warning" | "info";

const introToneStyles: Record<
  IntroTone,
  { stageColor: string; bg: string; border: string }
> = {
  accent: {
    stageColor: inventoryTheme.accent,
    bg: "#ecfdf5",
    border: "#bbf7d0",
  },
  primary: {
    stageColor: inventoryTheme.primaryBtn,
    bg: "#eef2ff",
    border: "#c7d2fe",
  },
  warning: {
    stageColor: inventoryTheme.warning,
    bg: "#fff7ed",
    border: "#fed7aa",
  },
  info: {
    stageColor: inventoryTheme.info,
    bg: "#eff6ff",
    border: "#bfdbfe",
  },
};

/**
 * Page-variant header. Thin wrapper over the canonical {@link InventoryHeader}
 * kept for back-compat with existing `InventorySubPage` callers. The back button
 * is now the unified chevron-start icon button (the `backLabel` text is no longer
 * rendered). Pass `showBack={false}` for hub screens (no back).
 */
export function InventorySubheader({
  title,
  showBack = true,
  backHref,
  onBack,
  action,
}: {
  title: string;
  showBack?: boolean;
  backHref?: string;
  /** @deprecated chevron has no text label; kept so callers don't break. */
  backLabel?: string;
  onBack?: () => void;
  action?: InventoryHeaderActionType | null;
}) {
  if (!showBack) {
    return <InventoryHeader title={title} variant="hub" action={action} />;
  }
  return (
    <InventoryHeader
      title={title}
      variant="page"
      back={{ href: backHref, onBack }}
      action={action}
    />
  );
}

export function PageIntro({
  stage,
  title,
  description,
  tone = "accent",
  stats,
}: {
  stage?: string;
  title: string;
  description?: string;
  tone?: IntroTone;
  stats?: Array<{ label: string; value: ReactNode }>;
}) {
  const palette = introToneStyles[tone];

  return (
    <section
      style={{
        ...inventoryCardStyle(),
        border: `1px solid ${palette.border}`,
        background: palette.bg,
      }}
    >
      {stage ? (
        <div
          style={{
            fontSize: 12,
            fontWeight: 900,
            color: palette.stageColor,
            marginBottom: 8,
          }}
        >
          {stage}
        </div>
      ) : null}
      <h1
        style={{
          margin: 0,
          fontSize: 22,
          lineHeight: 1.25,
          fontWeight: 950,
          color: inventoryTheme.text,
        }}
      >
        {title}
      </h1>
      {description ? (
        <p
          style={{
            margin: "8px 0 0",
            color: inventoryTheme.textMuted,
            fontSize: 14,
            lineHeight: 1.7,
          }}
        >
          {description}
        </p>
      ) : null}
      {stats && stats.length > 0 ? (
        <div
          style={{
            marginTop: 14,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 10,
          }}
        >
          {stats.map((stat) => (
            <div
              key={stat.label}
              style={{
                borderRadius: 14,
                padding: 14,
                background: inventoryTheme.cardBg,
                border: `1px solid ${inventoryTheme.cardBorder}`,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: inventoryTheme.textMuted,
                  fontWeight: 800,
                }}
              >
                {stat.label}
              </div>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 950,
                  marginTop: 4,
                  color: inventoryTheme.text,
                }}
              >
                {stat.value}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function HubActionCard({
  icon,
  title,
  description,
  onClick,
  accent,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...inventoryCardStyle({
          width: "100%",
          textAlign: "right",
          cursor: "pointer",
          border: accent
            ? `1px solid ${inventoryTheme.primaryBtn}`
            : `1px solid ${inventoryTheme.cardBorder}`,
          background: accent ? "#eef2ff" : inventoryTheme.cardBg,
        }),
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 17,
          fontWeight: 950,
          color: inventoryTheme.text,
        }}
      >
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 12,
            background: accent ? "#e0e7ff" : "#f1f5f9",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
          }}
        >
          {icon}
        </span>
        {title}
      </div>
      <div
        style={{
          fontSize: 13,
          color: inventoryTheme.textMuted,
          lineHeight: 1.6,
        }}
      >
        {description}
      </div>
    </button>
  );
}

export function NoticeBanner({
  children,
  tone = "error",
  onRetry,
}: {
  children: ReactNode;
  tone?: "error" | "success" | "info";
  onRetry?: () => void;
}) {
  const styles =
    tone === "success"
      ? {
          border: "#bbf7d0",
          bg: "#f0fdf4",
          color: "#166534",
          btn: "#166534",
        }
      : tone === "info"
        ? {
            border: "#bfdbfe",
            bg: "#eff6ff",
            color: "#3F619C",
            btn: "#3F619C",
          }
        : {
            border: "#fecaca",
            bg: "#fef2f2",
            color: "#991b1b",
            btn: "#991b1b",
          };

  return (
    <section
      style={{
        ...inventoryCardStyle(),
        borderColor: styles.border,
        background: styles.bg,
        color: styles.color,
      }}
    >
      {children}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: 10,
            border: "none",
            background: styles.btn,
            color: "#fff",
            borderRadius: 10,
            padding: "8px 12px",
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          נסה שוב
        </button>
      ) : null}
    </section>
  );
}

export const orderPipelineCss = `
  .order-pipeline {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    align-items: start;
  }
  @media (max-width: 1100px) {
    .order-pipeline { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 640px) {
    .order-pipeline { grid-template-columns: 1fr; }
  }
`;

export function inventoryFieldStyle(disabled?: boolean): CSSProperties {
  return {
    width: "100%",
    minHeight: 46,
    padding: "10px 12px",
    borderRadius: 12,
    border: `1px solid ${inventoryTheme.cardBorder}`,
    fontSize: 14,
    background: disabled ? "#f8fafc" : inventoryTheme.cardBg,
    boxSizing: "border-box",
    outline: "none",
  };
}
