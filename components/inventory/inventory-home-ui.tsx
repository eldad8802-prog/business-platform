"use client";

import { useEffect, useState, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { InventoryItemRow } from "@/components/inventory/inventory-item-row";
import { getStockTone } from "@/components/inventory/inventory-design";
import type { InventoryInboxCounts } from "@/components/inventory/use-inventory-inbox-counts";
import type { InventoryItemDTO } from "@/lib/api/inventory";

/* ─── Local SVG icons ─── */

function IconAlert({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3l9.5 17h-19L12 3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M12 10v5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="17.5" r="1.1" fill="currentColor" />
    </svg>
  );
}

function IconBoxOutline({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5v-9z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M3 7.5L12 12m0 0l9-4.5M12 12v9" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function IconClipboard({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="5" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M9 3h6v3H9z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconQuestion({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.5-2.5 2-2.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1.1" fill="currentColor" />
    </svg>
  );
}

function IconSpark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3z" fill="currentColor" />
    </svg>
  );
}

function IconCashRegister({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M6 10V6h12v4" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M9 6V4h6v2" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M7 14h2M11 14h2M15 14h2M7 17h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconBoxFilled({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5v-9z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" fill="currentColor" fillOpacity="0.12" />
      <path d="M3 7.5L12 12m0 0l9-4.5M12 12v9" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function IconCart({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 4h2l2.5 11.5a2 2 0 002 1.5h7a2 2 0 002-1.5L20 8H6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9" cy="20" r="1.5" fill="currentColor" />
      <circle cx="17" cy="20" r="1.5" fill="currentColor" />
    </svg>
  );
}

function IconTruck({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 7h11v9H3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M14 10h4l3 3v3h-7" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="7" cy="17.5" r="1.8" fill="currentColor" />
      <circle cx="17" cy="17.5" r="1.8" fill="currentColor" />
    </svg>
  );
}

function IconArrows({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8 3v14m0 0l-3-3m3 3l3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 21V7m0 0l-3 3m3-3l3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconChevronEnd({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ─── Control Center: work queue (C1) ─── */

export type WorkQueueRowTone =
  | "info"
  | "neutral"
  | "warning"
  | "danger"
  | "success";

export type WorkQueueRow = {
  id: string;
  title: string;
  meta: string;
  count: number;
  tone: WorkQueueRowTone;
  isRecommendation?: boolean;
  icon: React.ReactNode;
  onClick: () => void;
};

export function buildWorkQueueRows(
  counts: InventoryInboxCounts,
  router: ReturnType<typeof useRouter>,
  onCriticalClick: () => void
): WorkQueueRow[] {
  const rows: WorkQueueRow[] = [
    {
      id: "unmatched",
      title: "מכירות שלא זוהו",
      meta: "קישור לפריטים במלאי",
      count: counts.unmatched,
      tone: "info",
      icon: <IconQuestion />,
      onClick: () => router.push("/inventory/unmatched"),
    },
    {
      id: "drafts",
      title: "פריטים לבדיקה",
      meta: "אישור לפני כניסה למלאי",
      count: counts.drafts,
      tone: "neutral",
      icon: <IconClipboard />,
      onClick: () => router.push("/inventory/drafts"),
    },
    {
      id: "pending",
      title: "תור קליטה",
      meta: "הזמנות שממתינות לקליטה",
      count: counts.pendingOrders,
      tone: "warning",
      icon: <IconBoxOutline />,
      onClick: () => router.push("/inventory/supplier-purchases/pending"),
    },
    {
      id: "critical",
      title: "התראות מלאי",
      meta: "מתחת לסף מינימום",
      count: counts.criticalStock,
      tone: "danger",
      icon: <IconAlert />,
      onClick: onCriticalClick,
    },
    {
      id: "reorder",
      title: "המלצת הזמנה",
      meta: "חידוש מלאי מומלץ",
      count: counts.reorderAlerts,
      tone: "neutral",
      isRecommendation: true,
      icon: <IconSpark />,
      onClick: () => router.push("/inventory/supplier-purchases/new"),
    },
  ];

  return rows.filter((row) => row.count > 0);
}

/* ─── Control Center: status strip (C2) ─── */

export function ControlCenterStatusStrip({
  attentionTotal,
  reorderAlerts,
  loading,
}: {
  attentionTotal: number;
  reorderAlerts: number;
  loading: boolean;
}) {
  let statusText = "הכול תקין · מלאי מנוטר";
  let statusTone: "quiet" | "active" = "quiet";

  if (!loading) {
    if (attentionTotal > 0) {
      statusTone = "active";
      statusText =
        reorderAlerts > 0
          ? `${attentionTotal} תורים פתוחים · ${reorderAlerts} המלצה`
          : `${attentionTotal} תורים פתוחים`;
    } else if (reorderAlerts > 0) {
      statusTone = "active";
      statusText = `${reorderAlerts} המלצה`;
    }
  }

  return (
    <div
      className={`inv-status-strip inv-status-strip--${statusTone}${loading ? " is-loading" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy={loading}
    >
      <span className="inv-status-strip__dot" aria-hidden />
      <span className="inv-status-strip__text">
        {loading ? "טוען מצב מלאי…" : statusText}
      </span>
    </div>
  );
}

/* ─── Control Center: work queue panel (C3) ─── */

export function ControlCenterWorkQueue({
  counts,
  onCriticalClick,
}: {
  counts: InventoryInboxCounts;
  onCriticalClick: () => void;
}) {
  const router = useRouter();
  const rows = buildWorkQueueRows(counts, router, onCriticalClick);
  const openCount = rows.reduce((sum, row) => sum + row.count, 0);

  return (
    <section className="inv-work-queue" aria-label="עבודה פתוחה">
      <header className="inv-work-queue__head">
        <h2 className="inv-work-queue__title">עבודה פתוחה</h2>
        <span className="inv-work-queue__meta">
          {counts.loading ? "…" : openCount}
        </span>
      </header>

      {counts.loading ? (
        <ul className="inv-work-queue__list" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <li key={i} className="inv-queue-row inv-queue-row--skeleton" />
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <div className="inv-work-queue__empty">
          <p className="inv-work-queue__empty-title">אין תורים פתוחים</p>
          <p className="inv-work-queue__empty-sub">מעקב מלאי פעיל</p>
        </div>
      ) : (
        <ul className="inv-work-queue__list">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={`inv-queue-row inv-queue-row--${row.tone}${row.isRecommendation ? " is-recommendation" : ""}`}
                onClick={row.onClick}
              >
                <span className="inv-queue-row__stripe" aria-hidden />
                <span className="inv-queue-row__icon">{row.icon}</span>
                <span className="inv-queue-row__body">
                  <span className="inv-queue-row__title-row">
                    <span className="inv-queue-row__title">{row.title}</span>
                    {row.isRecommendation ? (
                      <span className="inv-queue-row__tag">המלצה</span>
                    ) : null}
                  </span>
                  <span className="inv-queue-row__meta">{row.meta}</span>
                </span>
                <span className="inv-queue-row__count">{row.count}</span>
                <span className="inv-queue-row__chev" aria-hidden>
                  <IconChevronEnd size={16} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ─── Control Center: execute strip (C4) ─── */

export function ControlCenterExecuteStrip({
  counts,
  onMovement,
  onCriticalClick,
}: {
  counts: InventoryInboxCounts;
  onMovement: () => void;
  onCriticalClick: () => void;
}) {
  const router = useRouter();
  const primary = resolveOpsPrimaryAction(counts, router, onCriticalClick);

  const secondaries: Array<{
    id: string;
    label: string;
    onClick: () => void;
    icon: React.ReactNode;
  }> = [
    {
      id: "sale",
      label: "מכירה",
      icon: <IconCashRegister size={22} />,
      onClick: () => router.push("/inventory/sales/create"),
    },
    {
      id: "item",
      label: "פריט",
      icon: <IconBoxFilled size={22} />,
      onClick: () => router.push("/inventory/items/create"),
    },
    {
      id: "order",
      label: "הזמנה מספק",
      icon: <IconCart size={22} />,
      onClick: () => router.push("/inventory/supplier-purchases/new"),
    },
    {
      id: "receive",
      label: "קליטה",
      icon: <IconTruck size={22} />,
      onClick: () => router.push("/inventory/supplier-purchases/pending"),
    },
  ];
  const procurementLinks: Array<{
    id: string;
    label: string;
    href: string;
    count?: number;
  }> = [
    {
      id: "hub",
      label: "מרכז רכש",
      href: "/inventory/supplier-purchases",
    },
    {
      id: "pending",
      label: "תור קליטה",
      href: "/inventory/supplier-purchases/pending",
      count: counts.pendingOrders,
    },
    {
      id: "history",
      label: "היסטוריה",
      href: "/inventory/supplier-purchases/history",
    },
    {
      id: "import",
      label: "ייבוא",
      href: "/inventory/supplier-purchases/import",
    },
    {
      id: "integrations",
      label: "חיבורים",
      href: "/inventory/supplier-purchases/integrations",
    },
  ];

  return (
    <section className="inv-execute-strip" aria-label="ביצוע">
      <button
        type="button"
        className="inv-cc-primary"
        onClick={primary.onClick}
        data-stage-id={primary.stageId ?? "default"}
      >
        <span className="inv-cc-primary__label">{primary.label}</span>
        {primary.targetCount != null && primary.targetCount > 0 ? (
          <span className="inv-cc-primary__count">{primary.targetCount}</span>
        ) : null}
      </button>

      <div className="inv-execute-secondaries">
        {secondaries.map((action) => (
          <button
            key={action.id}
            type="button"
            className="inv-execute-secondary"
            data-action-id={action.id}
            onClick={action.onClick}
          >
            <span className="inv-execute-secondary__icon">{action.icon}</span>
            <span className="inv-execute-secondary__label">{action.label}</span>
          </button>
        ))}
      </div>

      <nav className="inv-execute-procurement" aria-label="גישה לרכש">
        {procurementLinks.map((link) => (
          <button
            key={link.id}
            type="button"
            className="inv-execute-procurement__link"
            onClick={() => router.push(link.href)}
          >
            <span>{link.label}</span>
            {link.count != null && link.count > 0 ? (
              <span className="inv-execute-procurement__count">{link.count}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <button
        type="button"
        className="inv-execute-movement"
        onClick={onMovement}
      >
        <span className="inv-execute-movement__icon">
          <IconArrows size={20} />
        </span>
        <span>תנועת מלאי</span>
      </button>
    </section>
  );
}

/* ─── Attention strip ─── */

type AttentionTone = "danger" | "warning" | "purple" | "info" | "success";

type AttentionCardDef = {
  id: string;
  label: string;
  count: number;
  tone: AttentionTone;
  icon: React.ReactNode;
  onClick: () => void;
};

function buildAttentionCards(
  counts: InventoryInboxCounts,
  router: ReturnType<typeof useRouter>,
  onCriticalClick: () => void
): AttentionCardDef[] {
  return [
    {
      id: "critical",
      label: "מלאי קריטי",
      count: counts.criticalStock,
      tone: "danger",
      icon: <IconAlert />,
      onClick: onCriticalClick,
    },
    {
      id: "pending",
      label: "הזמנות לקליטה",
      count: counts.pendingOrders,
      tone: "warning",
      icon: <IconBoxOutline />,
      onClick: () => router.push("/inventory/supplier-purchases/pending"),
    },
    {
      id: "drafts",
      label: "פריטים לבדיקה",
      count: counts.drafts,
      tone: "purple",
      icon: <IconClipboard />,
      onClick: () => router.push("/inventory/drafts"),
    },
    {
      id: "unmatched",
      label: "מוצרים שלא זוהו",
      count: counts.unmatched,
      tone: "info",
      icon: <IconQuestion />,
      onClick: () => router.push("/inventory/unmatched"),
    },
    {
      id: "reorder",
      label: "המלצת הזמנה",
      count: counts.reorderAlerts,
      tone: "success",
      icon: <IconSpark />,
      onClick: () => router.push("/inventory/supplier-purchases/new"),
    },
  ];
}

export function AttentionStrip({
  counts,
  onCriticalClick,
}: {
  counts: InventoryInboxCounts;
  onCriticalClick: () => void;
}) {
  const router = useRouter();
  const cards = buildAttentionCards(counts, router, onCriticalClick);
  const total = cards.reduce((s, c) => s + c.count, 0);

  return (
    <section className="inv-attention" aria-label="התראות תפעוליות">
      <header className="inv-section-head">
        <h2 className="inv-section-title">
          מה צריך את תשומת הלב שלי
          {total > 0 ? <span className="inv-section-total">{total}</span> : null}
        </h2>
      </header>

      <div className="inv-attention__grid">
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            className={`inv-attention-card inv-attention-card--${card.tone}${card.count === 0 ? " is-empty" : ""}`}
            onClick={card.onClick}
            aria-label={`${card.label}: ${card.count} פריטים`}
          >
            <div className="inv-attention-card__head">
              <span className="inv-attention-card__label">{card.label}</span>
              <span className="inv-attention-card__icon">{card.icon}</span>
            </div>
            <div className="inv-attention-card__body">
              <span className="inv-attention-card__number">{card.count}</span>
              <span className="inv-attention-card__unit">פריטים</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ─── Primary-action resolver (preserved for compatibility) ─── */

export type OpsPrimaryAction = {
  label: string;
  onClick: () => void;
  targetCount?: number;
  stageId?: string;
};

export function resolveOpsPrimaryAction(
  counts: InventoryInboxCounts,
  router: ReturnType<typeof useRouter>,
  onCriticalClick: () => void
): OpsPrimaryAction {
  if (counts.unmatched > 0) {
    return {
      stageId: "unmatched",
      label: "לסגור מכירות שלא זוהו",
      targetCount: counts.unmatched,
      onClick: () => router.push("/inventory/unmatched"),
    };
  }
  if (counts.drafts > 0) {
    return {
      stageId: "drafts",
      label: "לסיים בדיקת פריטים",
      targetCount: counts.drafts,
      onClick: () => router.push("/inventory/drafts"),
    };
  }
  if (counts.pendingOrders > 0) {
    return {
      stageId: "pending",
      label: "לקלוט הזמנות ממתינות",
      targetCount: counts.pendingOrders,
      onClick: () => router.push("/inventory/supplier-purchases/pending"),
    };
  }
  if (counts.criticalStock > 0) {
    return {
      stageId: "critical",
      label: "לטפל בהתראות מלאי",
      targetCount: counts.criticalStock,
      onClick: onCriticalClick,
    };
  }
  if (counts.reorderAlerts > 0) {
    return {
      stageId: "reorder",
      label: "ליצור הזמנה מומלצת",
      targetCount: counts.reorderAlerts,
      onClick: () => router.push("/inventory/supplier-purchases/new"),
    };
  }
  return {
    label: "רישום מכירה",
    onClick: () => router.push("/inventory/sales/create"),
  };
}

/* ─── Quick actions ─── */

type ActionDef = {
  id: string;
  label: string;
  tone: "sale" | "item" | "order" | "receive" | "movement";
  icon: React.ReactNode;
  onClick: () => void;
};

export function QuickActions({
  onMovement,
  counts,
}: {
  onMovement: () => void;
  counts?: InventoryInboxCounts;
}) {
  const router = useRouter();

  const actions: ActionDef[] = [
    {
      id: "sale",
      label: "רישום מכירה",
      tone: "sale",
      icon: <IconCashRegister />,
      onClick: () => router.push("/inventory/sales/create"),
    },
    {
      id: "item",
      label: "הוספת פריט",
      tone: "item",
      icon: <IconBoxFilled />,
      onClick: () => router.push("/inventory/items/create"),
    },
    {
      id: "order",
      label: "הזמנה מספק",
      tone: "order",
      icon: <IconCart />,
      onClick: () => router.push("/inventory/supplier-purchases/new"),
    },
    {
      id: "receive",
      label: "קליטת סחורה",
      tone: "receive",
      icon: <IconTruck />,
      onClick: () => router.push("/inventory/supplier-purchases/pending"),
    },
    {
      id: "movement",
      label: "תנועת מלאי",
      tone: "movement",
      icon: <IconArrows />,
      onClick: onMovement,
    },
  ];

  const secondaryLinks: Array<{
    id: string;
    label: string;
    href: string;
    count?: number;
  }> = [
    {
      id: "hub",
      label: "ניהול ספקים",
      href: "/inventory/supplier-purchases",
    },
    {
      id: "drafts",
      label: "פריטים לבדיקה",
      href: "/inventory/drafts",
      count: counts?.drafts,
    },
    {
      id: "unmatched",
      label: "מכירות שלא זוהו",
      href: "/inventory/unmatched",
      count: counts?.unmatched,
    },
    {
      id: "history",
      label: "הזמנות אחרונות",
      href: "/inventory/supplier-purchases/history",
    },
    {
      id: "integrations",
      label: "חיבורי ספקים",
      href: "/inventory/supplier-purchases/integrations",
    },
  ];

  return (
    <section className="inv-quick-actions" aria-label="פעולות מהירות">
      <header className="inv-section-head">
        <h2 className="inv-section-title">פעולות מהירות</h2>
        <nav className="inv-section-links" aria-label="פעולות משניות">
          {secondaryLinks.map((link, i) => (
            <span key={link.id} className="inv-section-links__item">
              {i > 0 ? (
                <span className="inv-section-links__sep" aria-hidden>·</span>
              ) : null}
              <button
                type="button"
                className="inv-section-links__btn"
                onClick={() => router.push(link.href)}
              >
                {link.label}
                {link.count != null && link.count > 0 ? (
                  <span className="inv-section-links__count" aria-label={`${link.count} ממתינים`}>
                    {link.count}
                  </span>
                ) : null}
              </button>
            </span>
          ))}
        </nav>
      </header>

      <div className="inv-quick-actions__grid">
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`inv-action-tile inv-action-tile--${a.tone}`}
            data-action-id={a.id}
            onClick={a.onClick}
          >
            <span className="inv-action-tile__icon">{a.icon}</span>
            <span className="inv-action-tile__label">{a.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ─── Quick view (inventory monitor) ─── */

const MONITOR_COLLAPSED_MOBILE = 4;
const MONITOR_COLLAPSED_DESKTOP = 8;

export function QuickView({
  items,
  loading,
  panelRef,
}: {
  items: InventoryItemDTO[];
  loading: boolean;
  panelRef?: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const collapsedLimit = isDesktop
    ? MONITOR_COLLAPSED_DESKTOP
    : MONITOR_COLLAPSED_MOBILE;
  const visible = items.slice(0, collapsedLimit);
  const total = items.length;
  const hasAttentionItems = items.some((item) => getStockTone(item) !== "ok");
  const showAllLink = total > collapsedLimit || total > 0;

  return (
    <section
      className="inv-quick-view inv-inventory-monitor"
      ref={panelRef}
      aria-label="מבט מלאי"
    >
      <header className="inv-quick-view__head">
        <h2 className="inv-section-title">
          <span className="inv-section-title__icon">
            <IconBoxFilled size={14} />
          </span>
          מבט מלאי
        </h2>
        <div className="inv-quick-view__head-actions">
          {hasAttentionItems ? (
            <span className="inv-monitor-chip">דורש תשומת לב</span>
          ) : null}
          {showAllLink ? (
            <Link href="/inventory/items" className="inv-section-link">
              כל הפריטים{total > 0 ? ` (${total})` : ""}
              <IconChevronEnd size={14} />
            </Link>
          ) : null}
        </div>
      </header>

      {loading ? (
        <ul className="inv-quick-view__list" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="inv-quick-view__row inv-quick-view__row--skeleton" />
          ))}
        </ul>
      ) : visible.length === 0 ? (
        <div className="inv-quick-view__empty">
          <p className="inv-quick-view__empty-title">אין פריטים במלאי</p>
          <button
            type="button"
            className="inv-quick-view__empty-btn"
            onClick={() => router.push("/inventory/items/create")}
          >
            הוספת פריט ראשון
          </button>
        </div>
      ) : (
        <ul className="inv-quick-view__list">
          {visible.map((item) => (
            <li key={item.id}>
              <InventoryItemRow item={item} classPrefix="inv-quick-view" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
