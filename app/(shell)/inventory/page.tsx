"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { InventoryBottomNav } from "@/components/inventory/inventory-design";
import { useInventoryInboxCounts } from "@/components/inventory/use-inventory-inbox-counts";
import { getClientAuthToken, redirectToLogin } from "@/lib/client-session";

type AttentionTask = {
  title: string;
  description: string;
  href: string;
  tone: "red" | "orange" | "blue" | "green";
  icon: ReactNode;
  count: number;
};

type QuickLink = {
  title: string;
  description: string;
  href: string;
  tone: "blue" | "green" | "purple";
  icon: ReactNode;
};

const inventoryAttentionCss = `
[data-inventory-attention] {
  min-height: 100vh;
  background: #f8fafc;
  color: #0f172a;
  direction: rtl;
  padding: 22px 16px calc(112px + env(safe-area-inset-bottom));
}

.inv-attention-page {
  width: min(100%, 520px);
  margin: 0 auto;
}

.inv-attention-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 22px;
}

.inv-attention-header h1 {
  margin: 0;
  font-size: 1.45rem;
  line-height: 1.15;
  font-weight: 800;
  letter-spacing: 0;
  color: #0f172a;
}

.inv-attention-header p {
  margin: 7px 0 0;
  color: #64748b;
  font-size: 0.92rem;
  line-height: 1.5;
}

.inv-attention-icon-button {
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 16px;
  background: #ffffff;
  color: #0f172a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
}

.inv-attention-list {
  display: grid;
  gap: 12px;
}

.inv-attention-card {
  width: 100%;
  min-height: 84px;
  border: 1px solid rgba(226, 232, 240, 0.95);
  border-radius: 18px;
  background: #ffffff;
  padding: 14px;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 28px;
  align-items: center;
  gap: 12px;
  text-align: right;
  color: inherit;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.04);
  cursor: pointer;
}

.inv-attention-card:focus-visible,
.inv-quick-card:focus-visible,
.inv-attention-icon-button:focus-visible {
  outline: 3px solid rgba(37, 99, 235, 0.25);
  outline-offset: 2px;
}

.inv-attention-card__icon {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.inv-attention-card__icon--red {
  background: #fff1f2;
  color: #ef4444;
}

.inv-attention-card__icon--orange {
  background: #fff7ed;
  color: #f97316;
}

.inv-attention-card__icon--blue {
  background: #eff6ff;
  color: #2563eb;
}

.inv-attention-card__icon--green {
  background: #ecfdf5;
  color: #16a34a;
}

.inv-attention-card__copy {
  min-width: 0;
}

.inv-attention-card__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.inv-attention-card__title {
  font-size: 0.98rem;
  line-height: 1.35;
  font-weight: 800;
  color: #111827;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inv-attention-card__badge {
  min-width: 24px;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: #fee2e2;
  color: #dc2626;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.82rem;
  font-weight: 800;
  flex: 0 0 auto;
}

.inv-attention-card__badge--orange {
  background: #ffedd5;
  color: #ea580c;
}

.inv-attention-card__badge--blue {
  background: #dbeafe;
  color: #2563eb;
}

.inv-attention-card__badge--green {
  background: #dcfce7;
  color: #16a34a;
}

.inv-attention-card__badge.is-loading {
  width: 26px;
  color: transparent;
  background: linear-gradient(90deg, #e2e8f0 25%, #f8fafc 37%, #e2e8f0 63%);
  background-size: 400% 100%;
  animation: inv-attention-loading 1.2s ease-in-out infinite;
}

.inv-attention-card__description {
  display: block;
  margin-top: 4px;
  color: #64748b;
  font-size: 0.84rem;
  line-height: 1.45;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inv-attention-card__chevron {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #334155;
}

.inv-quick-section {
  margin-top: 30px;
}

.inv-quick-section h2 {
  margin: 0 0 12px;
  font-size: 1rem;
  line-height: 1.3;
  font-weight: 800;
  color: #0f172a;
}

.inv-quick-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.inv-quick-card {
  min-height: 104px;
  border: 1px solid rgba(226, 232, 240, 0.95);
  border-radius: 18px;
  background: #ffffff;
  padding: 12px 8px;
  color: inherit;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.04);
  cursor: pointer;
}

.inv-quick-card__icon {
  width: 44px;
  height: 44px;
  border-radius: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.inv-quick-card__icon--blue {
  background: #eff6ff;
  color: #2563eb;
}

.inv-quick-card__icon--green {
  background: #ecfdf5;
  color: #16a34a;
}

.inv-quick-card__icon--purple {
  background: #f5f3ff;
  color: #7c3aed;
}

.inv-quick-card strong {
  color: #0f172a;
  font-size: 0.9rem;
  line-height: 1.25;
}

.inv-quick-card span:last-child {
  color: #64748b;
  font-size: 0.76rem;
  line-height: 1.35;
}

@keyframes inv-attention-loading {
  0% { background-position: 100% 0; }
  100% { background-position: 0 0; }
}

@media (min-width: 768px) {
  [data-inventory-attention] {
    padding-top: 34px;
  }

  .inv-attention-page {
    width: min(100%, 620px);
  }

  .inv-attention-card {
    min-height: 92px;
    padding: 16px;
  }
}

@media (max-width: 360px) {
  .inv-quick-grid {
    grid-template-columns: 1fr;
  }
}
`;

export default function InventoryPage() {
  const router = useRouter();
  const { counts } = useInventoryInboxCounts();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!getClientAuthToken()) {
        redirectToLogin();
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  const stockAttentionCount = counts.criticalStock + counts.reorderAlerts;
  const attentionTasks: AttentionTask[] = [
    {
      title: "פריטים לאישור",
      description: "מוצרים שזוהו וממתינים לבדיקה",
      href: "/inventory/drafts",
      tone: "red",
      icon: <BoxIcon />,
      count: counts.drafts,
    },
    {
      title: "מכירות שלא זוהו",
      description: "פריטים ממכירה שצריך לשייך",
      href: "/inventory/unmatched",
      tone: "orange",
      icon: <WarningIcon />,
      count: counts.unmatched,
    },
    {
      title: "הזמנות שמחכות לקליטה",
      description: "ספקים וסחורה שממתינים לאישור",
      href: "/inventory/supplier-purchases/pending",
      tone: "blue",
      icon: <TruckIcon />,
      count: counts.pendingOrders,
    },
    {
      title: "מוצרים שעומדים להיגמר",
      description: "פריטים שכדאי לבדוק לפני שנגמרים",
      href: "/inventory/items",
      tone: "green",
      icon: <TagIcon />,
      count: stockAttentionCount,
    },
  ];

  const quickLinks: QuickLink[] = [
    {
      title: "מלאי",
      description: "מה יש לי",
      href: "/inventory/items",
      tone: "blue",
      icon: <BoxIcon />,
    },
    {
      title: "רכש",
      description: "מחזור הרכש",
      href: "/inventory/supplier-purchases",
      tone: "green",
      icon: <CartIcon />,
    },
    {
      title: "מכירות",
      description: "דיווח והתאמות",
      href: "/inventory/sales/create",
      tone: "purple",
      icon: <ChartIcon />,
    },
  ];

  return (
    <div data-inventory-attention>
      <style>{inventoryAttentionCss}</style>

      <main className="inv-attention-page" aria-label="טיפול עכשיו במלאי">
        <header className="inv-attention-header">
          <button type="button" className="inv-attention-icon-button" aria-label="התראות">
            <BellIcon />
          </button>
          <div>
            <h1>טיפול עכשיו</h1>
            <p>מה דורש את תשומת הלב שלך</p>
          </div>
        </header>

        <section className="inv-attention-list" aria-label="משימות לטיפול">
          {attentionTasks.map((task) => (
            <button
              key={task.href}
              type="button"
              className="inv-attention-card"
              onClick={() => router.push(task.href)}
            >
              <span className={`inv-attention-card__icon inv-attention-card__icon--${task.tone}`}>
                {task.icon}
              </span>
              <span className="inv-attention-card__copy">
                <span className="inv-attention-card__title-row">
                  <span className="inv-attention-card__title">{task.title}</span>
                  <span
                    className={`inv-attention-card__badge inv-attention-card__badge--${task.tone}${
                      counts.loading ? " is-loading" : ""
                    }`}
                    aria-label={counts.loading ? "טוען כמות" : `${task.count} פריטים`}
                  >
                    {counts.loading ? "" : task.count}
                  </span>
                </span>
                <span className="inv-attention-card__description">{task.description}</span>
              </span>
              <span className="inv-attention-card__chevron" aria-hidden>
                <ChevronLeftIcon />
              </span>
            </button>
          ))}
        </section>

        <section className="inv-quick-section" aria-label="מעבר מהיר">
          <h2>מעבר מהיר</h2>
          <div className="inv-quick-grid">
            {quickLinks.map((link) => (
              <button
                key={link.href}
                type="button"
                className="inv-quick-card"
                onClick={() => router.push(link.href)}
              >
                <span className={`inv-quick-card__icon inv-quick-card__icon--${link.tone}`}>
                  {link.icon}
                </span>
                <strong>{link.title}</strong>
                <span>{link.description}</span>
              </button>
            ))}
          </div>
        </section>
      </main>

      <InventoryBottomNav active="home" />
    </div>
  );
}

function Svg({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

function BellIcon() {
  return (
    <Svg size={20}>
      <path
        d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M14 21a2.3 2.3 0 01-4 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

function BoxIcon() {
  return (
    <Svg size={24}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </Svg>
  );
}

function WarningIcon() {
  return (
    <Svg size={24}>
      <path d="M12 4l9 16H3L12 4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M12 10v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17.5" r="1.1" fill="currentColor" />
    </Svg>
  );
}

function TruckIcon() {
  return (
    <Svg size={24}>
      <path d="M3 7h11v9H3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M14 10h4l3 3v3h-7" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="7" cy="18" r="1.8" fill="currentColor" />
      <circle cx="18" cy="18" r="1.8" fill="currentColor" />
    </Svg>
  );
}

function TagIcon() {
  return (
    <Svg size={24}>
      <path d="M20 12l-8 8-8-8V4h8l8 8z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" />
    </Svg>
  );
}

function CartIcon() {
  return (
    <Svg size={24}>
      <path
        d="M4 5h2l2.3 10.5a2 2 0 002 1.5h6.7a2 2 0 002-1.5L21 9H7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="20" r="1.5" fill="currentColor" />
      <circle cx="18" cy="20" r="1.5" fill="currentColor" />
    </Svg>
  );
}

function ChartIcon() {
  return (
    <Svg size={24}>
      <path d="M5 20V10M12 20V5M19 20v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

function ChevronLeftIcon() {
  return (
    <Svg size={18}>
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
