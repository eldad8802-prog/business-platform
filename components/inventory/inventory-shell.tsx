"use client";

import type { CSSProperties, ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  IconAlert,
  IconBox,
  IconClipboard,
  IconQuestion,
  inventoryCardStyle,
  inventoryPageStyle,
  inventoryResponsiveCss,
  inventoryTheme,
  InventorySubheader,
  InventoryBottomNav,
} from "@/components/inventory/inventory-design";
import { inventoryFoundationCss } from "@/components/inventory/inventory-foundation.css";
import { inventoryLayoutCss } from "@/components/inventory/inventory-layout.css";
import { inventoryPrimitivesCss } from "@/components/inventory/inventory-primitives.css";
import type { InventoryHeaderAction } from "@/components/inventory/inventory-primitives";
import {
  useInventoryInboxCounts,
  type InventoryInboxCounts,
} from "@/components/inventory/use-inventory-inbox-counts";

export type InventoryFlowStepId =
  | "sale"
  | "shortage"
  | "plan"
  | "order"
  | "send"
  | "receive"
  | "updated";

export const INVENTORY_FLOW_STEPS: Array<{
  id: InventoryFlowStepId;
  label: string;
  shortLabel: string;
}> = [
  { id: "sale", label: "מכירה בקופה", shortLabel: "מכירה" },
  { id: "shortage", label: "מלאי חסר", shortLabel: "חסר" },
  { id: "plan", label: "המלצות/תכנון", shortLabel: "תכנון" },
  { id: "order", label: "יצירת הזמנה", shortLabel: "הזמנה" },
  { id: "send", label: "שליחה לספק", shortLabel: "שליחה" },
  { id: "receive", label: "קליטת סחורה", shortLabel: "קליטה" },
  { id: "updated", label: "המלאי עודכן", shortLabel: "עודכן" },
];

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "בוקר טוב";
  if (hour < 17) return "צהריים טובים";
  if (hour < 21) return "ערב טוב";
  return "לילה טוב";
}

function IconBell() {
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

function IconMenuBtn() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 7h16M4 12h16M4 17h16"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function InventoryBrandLogo({ size = "md" }: { size?: "sm" | "md" }) {
  const iconSize = size === "sm" ? 28 : 34;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span
        style={{
          width: iconSize,
          height: iconSize,
          borderRadius: 10,
          background: "linear-gradient(135deg, #10b981, #059669)",
          color: "#fff",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 4px 12px rgba(16, 185, 129, 0.35)",
        }}
      >
        <IconBox />
      </span>
      <span
        style={{
          fontSize: size === "sm" ? 16 : 20,
          fontWeight: 950,
          color: inventoryTheme.text,
          letterSpacing: "-0.02em",
        }}
      >
        Inventory
      </span>
    </div>
  );
}

export function InventoryAppHeader({
  notificationCount = 0,
  onMenuClick,
}: {
  notificationCount?: number;
  onMenuClick?: () => void;
}) {
  return (
    <header className="inv-app-header">
      <div
        className="inv-header-inner inv-home-header-inner"
        style={{
          width: "100%",
          maxWidth: 960,
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          alignItems: "center",
          gap: 12,
          padding: "0 clamp(16px, 3.5vw, 28px)",
          boxSizing: "border-box",
        }}
      >
        <button
          type="button"
          className="inv-hamburger"
          onClick={onMenuClick}
          aria-label="תפריט"
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            border: `1px solid ${inventoryTheme.cardBorder}`,
            background: inventoryTheme.cardBg,
            display: "none",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: inventoryTheme.text,
          }}
        >
          <IconMenuBtn />
        </button>

        <div className="inv-header-logo" style={{ justifySelf: "start" }}>
          <InventoryBrandLogo />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            justifySelf: "end",
          }}
        >
          <button
            type="button"
            aria-label="התראות"
            style={{
              position: "relative",
              width: 42,
              height: 42,
              borderRadius: 12,
              border: `1px solid ${inventoryTheme.cardBorder}`,
              background: inventoryTheme.cardBg,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: inventoryTheme.textMuted,
              boxShadow: "0 2px 8px rgba(15, 23, 42, 0.04)",
            }}
          >
            <IconBell />
            {notificationCount > 0 ? (
              <span
                style={{
                  position: "absolute",
                  top: -4,
                  left: -4,
                  minWidth: 18,
                  height: 18,
                  borderRadius: 999,
                  background: inventoryTheme.danger,
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 900,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 4px",
                }}
              >
                {notificationCount > 99 ? "99+" : notificationCount}
              </span>
            ) : null}
          </button>
          <div
            className="inv-header-avatar"
            aria-hidden
            style={{
              width: 40,
              height: 40,
              borderRadius: 999,
              background: "linear-gradient(135deg, #e2e8f0, #cbd5e1)",
              border: `2px solid ${inventoryTheme.cardBg}`,
              boxShadow: "0 2px 8px rgba(15,23,42,0.08)",
              flexShrink: 0,
            }}
          />
        </div>
      </div>
    </header>
  );
}

export function InventoryGreeting({
  userName = "דני",
  variant = "default",
}: {
  userName?: string;
  /** Home workspace: business context only — no greeting hero */
  variant?: "default" | "workspace";
}) {
  const businessSelector = (
    <label className="inv-greeting-business">
      <span className="inv-greeting-business__label">עסק</span>
      <select className="inv-greeting-business__select" defaultValue="default">
        <option value="default">העסק שלי</option>
      </select>
    </label>
  );

  if (variant === "workspace") {
    return (
      <section className="inv-greeting inv-greeting--workspace" aria-label="הקשר עסק">
        <span className="inv-greeting-module">מלאי</span>
        {businessSelector}
      </section>
    );
  }

  return (
    <section className="inv-greeting inv-greeting--default">
      <div className="inv-greeting-copy">
        <h1 className="inv-greeting-title">
          {getGreeting()}, {userName}
        </h1>
        <p className="inv-greeting-sub">מה מחכה לי היום?</p>
      </div>
      {businessSelector}
    </section>
  );
}

export function InventoryFlowStepper({
  activeStep,
}: {
  activeStep: InventoryFlowStepId;
}) {
  const activeIndex = INVENTORY_FLOW_STEPS.findIndex((s) => s.id === activeStep);

  return (
    <div
      className="inv-flow-stepper-wrap"
      style={{
        maxWidth: 920,
        margin: "0 auto",
        padding: "0 16px 12px",
        overflowX: "auto",
      }}
    >
      <div
        className="inv-flow-stepper"
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 0,
          minWidth: "max-content",
          paddingBottom: 4,
        }}
      >
        {INVENTORY_FLOW_STEPS.map((step, index) => {
          const isActive = index === activeIndex;
          const isDone = index < activeIndex;
          return (
            <div
              key={step.id}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                minWidth: 88,
                flex: "0 0 auto",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  width: "100%",
                }}
              >
                {index > 0 ? (
                  <div
                    style={{
                      flex: 1,
                      height: 2,
                      background: isDone ? inventoryTheme.accent : "#e2e8f0",
                      marginBottom: 18,
                    }}
                  />
                ) : (
                  <div style={{ flex: 1 }} />
                )}
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 999,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 900,
                    background: isActive
                      ? inventoryTheme.primaryBtn
                      : isDone
                        ? inventoryTheme.accent
                        : "#f1f5f9",
                    color: isActive || isDone ? "#fff" : inventoryTheme.textMuted,
                    border: isActive
                      ? `2px solid ${inventoryTheme.primaryBtn}`
                      : "2px solid transparent",
                    boxShadow: isActive
                      ? "0 4px 12px rgba(91, 91, 214, 0.35)"
                      : "none",
                  }}
                >
                  {isDone ? "✓" : index + 1}
                </div>
                {index < INVENTORY_FLOW_STEPS.length - 1 ? (
                  <div
                    style={{
                      flex: 1,
                      height: 2,
                      background: isDone ? inventoryTheme.accent : "#e2e8f0",
                      marginBottom: 18,
                    }}
                  />
                ) : (
                  <div style={{ flex: 1 }} />
                )}
              </div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: isActive ? 900 : 700,
                  color: isActive ? inventoryTheme.primaryBtn : inventoryTheme.textMuted,
                  textAlign: "center",
                  lineHeight: 1.3,
                  marginTop: 4,
                  maxWidth: 84,
                }}
              >
                <span className="inv-flow-step-label-full">{step.label}</span>
                <span className="inv-flow-step-label-short">{step.shortLabel}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type InboxItem = {
  key: string;
  label: string;
  count: number;
  tone: "danger" | "warning" | "purple" | "info" | "neutral";
  icon: ReactNode;
  href: string;
};

function inboxItemsFromCounts(counts: InventoryInboxCounts): InboxItem[] {
  return [
    {
      key: "unmatched-sales",
      label: "מכירות שעדיין לא זוהו",
      count: counts.unmatched,
      tone: "info",
      icon: <IconQuestion />,
      href: "/inventory/unmatched",
    },
    {
      key: "drafts",
      label: "פריטים לבדיקה",
      count: counts.drafts,
      tone: "purple",
      icon: <IconClipboard />,
      href: "/inventory/drafts",
    },
    {
      key: "pending",
      label: "הזמנות ממתינות",
      count: counts.pendingOrders,
      tone: "warning",
      icon: <IconBox />,
      href: "/inventory/supplier-purchases/pending",
    },
    {
      key: "critical",
      label: "מלאי קריטי",
      count: counts.criticalStock,
      tone: "danger",
      icon: <IconAlert />,
      href: "/inventory",
    },
    {
      key: "reorder",
      label: "התראות חוסר",
      count: counts.reorderAlerts,
      tone: "neutral",
      icon: <IconAlert />,
      href: "/inventory/supplier-purchases/new",
    },
  ];
}

const inboxToneBg: Record<InboxItem["tone"], string> = {
  danger: "#fef2f2",
  warning: "#fff7ed",
  purple: "#f5f3ff",
  info: "#eff6ff",
  neutral: "#f8fafc",
};

export function InventoryInboxSidebar({
  counts: countsProp,
}: {
  counts?: InventoryInboxCounts;
}) {
  const router = useRouter();
  const { counts: fetched } = useInventoryInboxCounts();
  const counts = countsProp ?? fetched;
  const items = inboxItemsFromCounts(counts);

  return (
    <aside
      className="inv-inbox-sidebar"
      style={{
        ...inventoryCardStyle({ padding: 0, overflow: "hidden" }),
        alignSelf: "start",
        position: "sticky",
        top: 72,
      }}
    >
      <div
        style={{
          padding: "14px 16px",
          borderBottom: `1px solid ${inventoryTheme.cardBorder}`,
          fontSize: 15,
          fontWeight: 950,
          color: inventoryTheme.text,
        }}
      >
        מה מחכה לי? (Inbox)
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: "8px 0" }}>
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => router.push(item.href)}
              style={{
                width: "100%",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "12px 16px",
                textAlign: "right",
                fontSize: 13,
                fontWeight: 700,
                color: inventoryTheme.text,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 10,
                    background: inboxToneBg[item.tone],
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: inventoryTheme.textMuted,
                  }}
                >
                  {item.icon}
                </span>
                {item.label}
              </span>
              <span
                style={{
                  minWidth: 26,
                  height: 26,
                  borderRadius: 999,
                  background: "#e2e8f0",
                  fontSize: 12,
                  fontWeight: 900,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: inventoryTheme.text,
                }}
              >
                {counts.loading ? "…" : item.count}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div style={{ padding: "12px 16px 16px" }}>
        <button
          type="button"
          onClick={() => router.push("/attention")}
          style={{
            width: "100%",
            minHeight: 44,
            borderRadius: 12,
            border: "none",
            background: inventoryTheme.primaryBtn,
            color: "#fff",
            fontSize: 14,
            fontWeight: 900,
            cursor: "pointer",
          }}
        >
          לכל המשימות
        </button>
      </div>
    </aside>
  );
}

export type InventoryBottomTab =
  | "home"
  | "products"
  | "sales"
  | "orders"
  | "more";

export function InventorySubPage({
  title,
  variant = "page",
  backHref,
  sub,
  headerAction,
  progressLabel,
  showInbox = false,
  bottomNav = "products",
  wide = false,
  children,
}: {
  title: string;
  /** "page" → chevron-start back (default). "hub" → big title, no back. */
  variant?: "hub" | "page";
  /** Page variant only. */
  backHref?: string;
  backLabel?: string;
  /** Hub variant subtitle line under the title. */
  sub?: ReactNode;
  /** Trailing header action (e.g. the "+" new-item button). */
  headerAction?: InventoryHeaderAction | null;
  /** Short line under header, e.g. "שלב 2 מתוך 4 · עגלת הזמנה" */
  progressLabel?: ReactNode;
  showInbox?: boolean;
  bottomNav?: InventoryBottomTab;
  wide?: boolean;
  children: ReactNode;
  mainStyle?: CSSProperties;
}) {
  return (
    <div
      className="inv-subpage-root inv-page-root"
      style={inventoryPageStyle()}
      data-inventory-module
      data-inventory-subpage
    >
      <style>{inventoryFoundationCss}</style>
      <style>{inventoryResponsiveCss}</style>
      <style>{inventoryShellCss}</style>
      <style>{inventoryLayoutCss}</style>
      <style>{inventoryPrimitivesCss}</style>
      {variant === "hub" ? (
        <InventorySubheader title={title} showBack={false} action={headerAction} />
      ) : (
        <InventorySubheader title={title} backHref={backHref} action={headerAction} />
      )}
      {variant === "hub" && sub ? <div className="inv-hd__sub">{sub}</div> : null}
      <div className="inv-subpage-body">
        {progressLabel ? (
          <p className="inv-progress-crumb">{progressLabel}</p>
        ) : null}
        {showInbox ? (
          <div className="inv-flow-page-grid" style={{ maxWidth: 1080, margin: "0 auto" }}>
            <InventoryInboxSidebar />
            <main
              className={`inv-subpage-main inv-main-shell${wide ? " inv-subpage-main--wide" : ""}`}
            >
              {children}
            </main>
          </div>
        ) : (
          <main
            className={`inv-subpage-main inv-main-shell${wide ? " inv-subpage-main--wide" : ""}`}
          >
            {children}
          </main>
        )}
      </div>
      <InventoryBottomNav active={bottomNav} />
    </div>
  );
}

export const inventoryShellCss = `
  .inv-flow-step-label-short { display: none; }
  @media (max-width: 900px) {
    .inv-flow-step-label-full { display: none; }
    .inv-flow-step-label-short { display: inline; }
  }
  .inv-flow-page-grid {
    display: grid;
    grid-template-columns: minmax(240px, 280px) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  @media (max-width: 960px) {
    .inv-flow-page-grid {
      grid-template-columns: 1fr;
    }
    .inv-inbox-sidebar {
      position: static !important;
    }
  }
  @media (max-width: 720px) {
    .inv-header-logo { justify-self: center !important; }
    .inv-hamburger { display: inline-flex !important; }
  }

  .inv-greeting--default {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding-top: 4px;
  }

  .inv-greeting-copy {
    min-width: 0;
    flex: 1 1 200px;
  }

  .inv-greeting-title {
    margin: 0;
    font-size: 28px;
    font-weight: 950;
    color: ${inventoryTheme.text};
    line-height: 1.15;
    letter-spacing: -0.03em;
  }

  .inv-greeting-sub {
    margin: 8px 0 0;
    font-size: 15px;
    color: ${inventoryTheme.textMuted};
    font-weight: 700;
  }

  .inv-greeting-business {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 12px;
    border-radius: 10px;
    border: 1px solid ${inventoryTheme.cardBorder};
    background: ${inventoryTheme.cardBg};
    font-size: 13px;
    font-weight: 700;
    color: ${inventoryTheme.text};
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  }

  .inv-greeting-business__label {
    color: ${inventoryTheme.textMuted};
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .inv-greeting-business__select {
    border: none;
    background: transparent;
    font-weight: 700;
    font-size: 13px;
    color: ${inventoryTheme.text};
    cursor: pointer;
    outline: none;
  }
`;
