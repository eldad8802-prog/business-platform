"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties, type ReactNode } from "react";

import {
  IconArrowDown,
  IconArrowUp,
  IconBell,
  IconCalendarPlus,
  IconCalendarSimple,
  IconCardSimple,
  IconCash,
  IconChat,
  IconFileCheck,
  IconIncoming,
  IconLeads,
  IconMail,
  IconNet,
  IconOutgoing,
  IconReceiptPlus,
  IconScan,
  IconSearch,
  IconSparkle,
  IconUserPlus,
  type IconComponent,
} from "@/components/navigation/nav-icons";

import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";

import { CashflowCard } from "./cashflow-card";
import {
  ActivityList,
  CARD,
  DIVIDER,
  INK,
  InsightCard,

  LINE,
  MUTED,
  Note,
  SkeletonBlock,
  TEAL,
  CountPill,
  WaitingRow,
  IdentityPromptRow,
  OtherCurrenciesMark,
} from "./home-parts";
import { RecommendationCard } from "./recommendation-card";
import type { HomeView } from "./home-v3";
import { identityPromptDue, moneyFirstTime } from "./home-first-time";
import { showsFirstTime, whatsAppAction } from "@/lib/services/home/home-history-model";
import {
  buildStockRows,
  buildUpcomingRows,
  channelLabel,
  countText,
  dateChip,
  formatShekel,
  netOf,
  sourceLabel,
  toNumber,
  waitingSentence,
  type WaitingKind,
} from "./home-v3-model";
import { ComingSoonPill } from "@/components/ui/coming-soon/ComingSoonPill";

/**
 * Desktop Home (≥1280) — "גרסה 3 מאובזרת", per the approved desktop reference.
 * Every row wraps (flex-wrap), so a narrow desktop window stacks panels rather
 * than clipping them.
 */
export function DesktopHome({ view }: { view: HomeView }) {
  return (
    <main style={{ boxSizing: "border-box", padding: "22px clamp(16px, 2.4vw, 32px) 40px" }}>
      <div style={{ maxWidth: 1360, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <TopBar view={view} />
        <Kpis view={view} />

        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "stretch" }}>
          <CashflowCard
            variant="desktop"
            day={view.day}
            week={view.week}
            period={view.period}
            onPeriodChange={view.onPeriodChange}
            firstTime={moneyFirstTime(view)}
            style={{ flex: "999 1 560px", boxSizing: "content-box" }}
          />
          <WaitingPanel view={view} />
        </div>

        <RecommendationCard recommendation={view.data.recommendation} wide />

        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "stretch" }}>
          <ObligationsPanel view={view} />
          <CollectionPanel view={view} />
          <DocumentsPanel view={view} />
          <LeadsPanel view={view} />
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "stretch" }}>
          <ConversationsPanel view={view} />
          <StockPanel view={view} />
          <div style={{ flex: "1 1 358px", minWidth: 0, display: "flex", flexDirection: "column" }}>
            <ActivityList activity={view.activity} variant="timeline" when={view.when} />
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "stretch" }}>
          <InsightCard insight={view.data.insight} wide style={{ flex: "999 1 520px", boxSizing: "content-box" }} />
          <Shortcuts />
        </div>
      </div>
    </main>
  );
}

/* --------------------------------------------------------------- top bar -- */

function TopBar({ view }: { view: HomeView }) {
  const router = useRouter();
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const sentence = view.waiting.state === "ready" ? waitingSentence(view.waiting.value, t) : null;
  return (
    <header style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
      <div style={{ flex: "1 1 240px", display: "flex", flexDirection: "column", gap: 2 }}>
        <h1 style={{ margin: 0, fontSize: 27, fontWeight: 600, letterSpacing: -0.4 }}>{view.greeting}</h1>
        <div style={{ fontSize: 14, color: MUTED }}>
          {view.dateLine}
          {sentence ? ` · ${sentence}` : null}
        </div>
      </div>

      {/*
        The only search the product has matches vendor and category on
        financial records (GET /api/search). The field says exactly that, and
        hands the query to /search — it does not pretend to search all of Dubiz.
        TODO(future): a global search across customers, documents and stock.
      */}
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const term = q.trim();
          router.push(term ? `/search?q=${encodeURIComponent(term)}` : "/search");
        }}
        style={{ flex: "1 1 300px", maxWidth: 420, minWidth: 0 }}
      >
        <label
          style={{
            height: 46,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 14px",
            borderRadius: 14,
            background: CARD,
            border: `1px solid ${LINE}`,
            color: MUTED,
          }}
        >
          <IconSearch size={18} strokeWidth={2} />
          <span className="sr-only">{t("home.desktop.searchLabel")}</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("home.desktop.searchPlaceholder")}
            style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", fontSize: 14, color: INK, outline: "none", fontFamily: "inherit" }}
          />
        </label>
      </form>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Link
          href="/billing?create=1"
          prefetch={false}
          style={{
            height: 46,
            padding: "0 16px",
            borderRadius: 14,
            border: "1px solid #CFE0DE",
            background: "#FFFFFF",
            color: "#1D5552",
            fontSize: 14,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 8,
            textDecoration: "none",
            boxSizing: "border-box",
          }}
        >
          <IconReceiptPlus size={17} strokeWidth={2} />
          {t("home.desktop.newInvoice")}
        </Link>
        <Link
          href="/notifications"
          prefetch={false}
          aria-label={view.hasUnread ? t("home.desktop.notificationsUnread") : t("home.desktop.notifications")}
          style={{
            width: 46,
            height: 46,
            borderRadius: 14,
            border: `1px solid ${LINE}`,
            background: CARD,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            color: INK,
            boxSizing: "border-box",
          }}
        >
          <IconBell size={20} />
          {view.hasUnread ? (
            <span style={{ position: "absolute", top: 11, insetInlineEnd: 12, width: 8, height: 8, borderRadius: 999, background: "#D2553D", border: `2px solid ${CARD}` }} />
          ) : null}
        </Link>
        <Link
          href="/settings/account"
          prefetch={false}
          aria-label={t("home.desktop.myAccount")}
          style={{
            width: 46,
            height: 46,
            borderRadius: 999,
            background: "#ECE9F7",
            color: "#5B4FA8",
            fontSize: 16,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textDecoration: "none",
          }}
        >
          {view.ownerInitial}
        </Link>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ KPIs -- */

function Kpi({
  label,
  value,
  note,
  extra = null,
  icon: Icon,
  tone,
  quiet = false,
}: {
  /** No history for this figure: a muted dash, never ₪0. */
  quiet?: boolean;
  label: string;
  value: string | null;
  note?: string | null;
  /** Shown after the value (never while loading or quiet): money in other currencies. */
  extra?: ReactNode;
  icon: IconComponent;
  tone: "plain-in" | "plain-out" | "solid" | "fresh" | "urgent";
}) {
  const t = {
    "plain-in": { bg: CARD, border: LINE, label: MUTED, chipBg: "#E3F2F0", chip: TEAL, ink: INK, note: MUTED },
    "plain-out": { bg: CARD, border: LINE, label: MUTED, chipBg: "#FBEEDD", chip: "#A0601F", ink: INK, note: MUTED },
    solid: { bg: TEAL, border: null, label: "#CFE3E2", chipBg: "rgba(255,255,255,0.14)", chip: "#FFFFFF", ink: "#FFFFFF", note: "#CFE3E2" },
    fresh: { bg: "#EEF7F5", border: "#D4E9E5", label: "#1D5552", chipBg: "#FFFFFF", chip: TEAL, ink: INK, note: "#1D5552" },
    urgent: { bg: "#FDF0EC", border: "#F4D8CE", label: "#8E3A28", chipBg: "#FFFFFF", chip: "#B4432F", ink: INK, note: "#8E3A28" },
  }[tone];
  return (
    <div
      style={{
        flex: "1 1 170px",
        borderRadius: 18,
        padding: 16,
        background: t.bg,
        border: t.border ? `1px solid ${t.border}` : undefined,
        color: t.ink,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minWidth: 0,
        boxSizing: "content-box",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, color: t.label }}>{label}</span>
        <span style={{ width: 30, height: 30, borderRadius: 9, background: t.chipBg, color: t.chip, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon size={16} strokeWidth={2} />
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 25, fontWeight: 600, letterSpacing: -0.4, opacity: quiet ? 0.45 : 1 }}>
          {quiet ? "—" : value === null ? <SkeletonBlock h={26} r={8} style={{ width: 90, display: "inline-block" }} /> : value}
          {quiet || value === null ? null : extra}
        </span>
        {note && !quiet ? <span style={{ fontSize: 12, color: t.note }}>{note}</span> : null}
      </span>
    </div>
  );
}

/** The five figures. Always today's, whatever period the chart shows. */
function Kpis({ view }: { view: HomeView }) {
  const { t, locale } = useI18n();
  const formatMoney = (n: number) => formatShekel(n, locale);
  const d = view.day;
  const day = d.state === "ready" ? d.value : null;
  const dash = "—";
  const income = d.state === "loading" ? null : day ? formatMoney(day.income) : dash;
  const expense = d.state === "loading" ? null : day && day.expense !== null ? formatMoney(day.expense) : dash;
  const netValue = day ? netOf(day) : null;
  const net = d.state === "loading" ? null : netValue !== null ? formatMoney(netValue) : dash;

  const p = view.data.pending;
  const pending = p.state === "loading" ? null : p.state === "ready" ? formatMoney(toNumber(p.value.amount) ?? 0) : dash;

  const c = view.data.cost;
  const out = c.state === "ready" ? c.value.upcoming.next7Days : null;
  const outValue = c.state === "loading" ? null : out ? formatMoney(toNumber(out.total) ?? 0) : dash;
  const outCount = out ? out.items.length : 0;

  // A tile turns quiet only when history KNOWS there was never such money and
  // the tile has nothing of its own today — never because today reads 0.
  const h = view.history;
  const incomeToday = day ? Number(day.income) > 0 : false;
  const expenseToday = day && day.expense !== null ? Number(day.expense) > 0 : false;
  const quietIncome = showsFirstTime(h, "income", incomeToday);
  const quietExpense = showsFirstTime(h, "expenses", expenseToday);
  const quietPending = showsFirstTime(h, "collection", p.state === "ready" && (toNumber(p.value.amount) ?? 0) > 0);
  const quietOut = showsFirstTime(h, "obligations", outCount > 0);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }} role="group" aria-label={t("home.desktop.kpiAria")}>
      <Kpi label={t("home.desktop.incomeToday")} value={income} extra={day ? <OtherCurrenciesMark others={day.incomeOtherCurrencies} /> : null} icon={IconArrowUp} tone="plain-in" quiet={quietIncome} />
      <Kpi label={t("home.desktop.expensesToday")} value={expense} icon={IconArrowDown} tone="plain-out" quiet={quietExpense} />
      <Kpi label={t("home.desktop.netToday")} value={net} icon={IconNet} tone="solid" quiet={quietIncome && quietExpense} />
      <Kpi label={t("home.desktop.expectedIn")} value={pending} extra={p.state === "ready" ? <OtherCurrenciesMark others={p.value.otherCurrencies} /> : null} note={p.state === "ready" ? t("home.desktop.awaitingCollection") : null} icon={IconIncoming} tone="fresh" quiet={quietPending} />
      <Kpi
        quiet={quietOut}
        label={t("home.desktop.dueOut")}
        value={outValue}
        note={out ? (outCount === 1 ? t("home.desktop.paymentOne") : t("home.desktop.paymentMany", { count: outCount })) : null}
        icon={IconOutgoing}
        tone="urgent"
      />
    </div>
  );
}

/* ------------------------------------------------------- what's waiting -- */

const CHIP_STYLE: Record<WaitingKind, { label: MessageKey; color: string; background: string }> = {
  payment: { label: "home.desktop.chip.payment", color: "#8E3A28", background: "#FDF0EC" },
  stock: { label: "home.desktop.chip.stock", color: "#8A4F16", background: "#FDF4E7" },
  collection: { label: "home.desktop.chip.collection", color: "#1D5552", background: "#EEF7F5" },
  lead: { label: "home.desktop.chip.lead", color: "#5B4FA8", background: "#F2F0FA" },
};
const KIND_ORDER: WaitingKind[] = ["payment", "stock", "collection", "lead"];
const ROWS_SHOWN = 3;

function WaitingPanel({ view }: { view: HomeView }) {
  const [filter, setFilter] = useState<WaitingKind | "all">("all");
  const { t } = useI18n();
  const w = view.waiting;

  let body: ReactNode;
  if (w.state === "loading") {
    body = (
      <>
        <SkeletonBlock h={62} />
        <SkeletonBlock h={62} />
        <SkeletonBlock h={62} />
      </>
    );
  } else if (w.state === "failed") {
    body = <Note>{t("home.layout.waitingFailed")}</Note>;
  } else {
    const model = w.value;
    const kinds = KIND_ORDER.filter((k) => model.byKind[k].n > 0);
    const active = filter !== "all" && model.byKind[filter].n > 0 ? filter : "all";
    const list = active === "all" ? model.items : model.items.filter((i) => i.kind === active);
    const claim = active === "all" ? model.total : model.byKind[active];
    const rest = list.length - ROWS_SHOWN;
    const prompt = identityPromptDue(view) ? <IdentityPromptRow /> : null;
    body =
      model.items.length === 0 ? (
        prompt ?? <Note>{model.total.exact ? t("home.layout.nothingWaitingExact") : t("home.layout.nothingWaitingFound")}</Note>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="group" aria-label={t("home.desktop.filterAria")}>
            <Chip on={active === "all"} onClick={() => setFilter("all")} label={t("home.desktop.chipAll", { count: countText(model.total) })} color={CHIP_STYLE.payment.color} background="transparent" neutral />
            {kinds.map((k) => (
              <Chip
                key={k}
                on={active === k}
                onClick={() => setFilter(k)}
                label={t("home.desktop.chipKind", { label: t(CHIP_STYLE[k].label), count: countText(model.byKind[k]) })}
                color={CHIP_STYLE[k].color}
                background={CHIP_STYLE[k].background}
              />
            ))}
          </div>
          {list.slice(0, ROWS_SHOWN).map((item) => (
            <WaitingRow key={item.id} item={item} />
          ))}
          {active === "all" && list.length < ROWS_SHOWN ? prompt : null}
          {rest > 0 || !claim.exact ? (
            <Link
              href="/attention"
              prefetch={false}
              className="dzh-link"
              style={{ fontSize: 13, fontWeight: 500, textDecoration: "none", textAlign: "center", padding: "8px 0" }}
            >
              {claim.exact ? (rest === 1 ? t("home.desktop.moreOne") : t("home.desktop.moreMany", { count: rest })) : t("home.desktop.moreSome")}
            </Link>
          ) : null}
        </>
      );
  }

  return (
    <section
      aria-label={t("home.desktop.waitingTitle")}
      style={{
        flex: "1 1 380px",
        minWidth: 0,
        borderRadius: 26,
        padding: 20,
        background: CARD,
        border: `1px solid ${LINE}`,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        boxSizing: "content-box",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              width: 42,
              height: 42,
              borderRadius: 13,
              background: "radial-gradient(circle at 30% 30%, #9BE4E3, #3D9C9A 60%, #246966)",
              color: "#FFFFFF",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <IconSparkle size={19} strokeWidth={2} />
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t("home.desktop.waitingTitle")}</h2>
              {w.state === "ready" && w.value.total.n > 0 ? <CountPill claim={w.value.total} /> : null}
            </span>
            <span style={{ fontSize: 12, color: MUTED }}>{t("home.desktop.waitingSub")}</span>
          </span>
        </div>
        <Link href="/attention" prefetch={false} className="dzh-link" style={{ fontSize: 13, fontWeight: 500, textDecoration: "none", padding: "10px 0" }}>
          {t("home.desktop.showAll")}
        </Link>
      </div>
      {body}
      {view.waitingPartial ? <Note style={{ padding: 0 }}>{t("home.layout.waitingPartial")}</Note> : null}
    </section>
  );
}

function Chip({
  on,
  onClick,
  label,
  color,
  background,
  neutral,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  color: string;
  background: string;
  neutral?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      style={{
        fontSize: 12,
        fontWeight: on ? 600 : 500,
        color: on ? "#FFFFFF" : neutral ? INK : color,
        background: on ? INK : neutral ? "#F3E8DA" : background,
        borderRadius: 999,
        padding: "5px 12px",
        border: 0,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {label}
    </button>
  );
}

/* ---------------------------------------------------------------- panels -- */

function Panel({
  title,
  icon,
  link,
  basis,
  gap = 4,
  children,
}: {
  title: string;
  icon?: { Icon: IconComponent; color: string; bg: string };
  link: { href: string; label: string };
  basis: string;
  gap?: number;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      style={{
        flex: `1 1 ${basis}`,
        minWidth: 0,
        borderRadius: 22,
        padding: 18,
        background: CARD,
        border: `1px solid ${LINE}`,
        display: "flex",
        flexDirection: "column",
        gap,
        // The reference sizes flex items content-box (basis excludes padding).
        boxSizing: "content-box",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {icon ? (
            <span style={{ width: 30, height: 30, borderRadius: 9, background: icon.bg, color: icon.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <icon.Icon size={16} strokeWidth={2} />
            </span>
          ) : null}
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
        </span>
        <Link href={link.href} prefetch={false} className="dzh-link" style={{ fontSize: 12, fontWeight: 500, textDecoration: "none", padding: "10px 0" }}>
          {link.label}
        </Link>
      </div>
      {children}
    </section>
  );
}

function Rows({ children }: { children: ReactNode[] }) {
  return (
    <>
      {children.map((child, i) => (
        <div key={i}>
          {i > 0 ? <div style={{ height: 1, background: DIVIDER }} /> : null}
          {child}
        </div>
      ))}
    </>
  );
}

const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "9px 0", textDecoration: "none", color: INK };
const titleStyle: CSSProperties = { fontSize: 14, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const subStyle: CSSProperties = { fontSize: 12, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const tagStyle = (color: string, background: string): CSSProperties => ({
  fontSize: 11,
  fontWeight: 600,
  color,
  background,
  borderRadius: 999,
  padding: "1px 8px",
  whiteSpace: "nowrap",
});

function PanelSkeleton() {
  return (
    <>
      <SkeletonBlock h={44} r={12} style={{ marginTop: 6 }} />
      <SkeletonBlock h={44} r={12} style={{ marginTop: 6 }} />
    </>
  );
}

function ObligationsPanel({ view }: { view: HomeView }) {
  const { t, locale } = useI18n();
  const c = view.data.cost;
  let body: ReactNode;
  if (c.state === "loading") body = <PanelSkeleton />;
  else if (c.state === "failed") body = <Note>{t("home.desktop.obligations.failed")}</Note>;
  else {
    const items = buildUpcomingRows(c.value, 3);
    body =
      items.length === 0 ? (
        <Note>{showsFirstTime(view.history, "obligations", false) ? t("home.desktop.obligations.none") : t("home.desktop.obligations.empty")}</Note>
      ) : (
        <Rows>
          {items.map((it, i) => {
            const chip = dateChip(it.dueDate, locale);
            const amount = toNumber(it.amount);
            // A date already past must not look like one still ahead: a solid
            // chip and an explicit "באיחור" tag (the urgent tag of the design).
            const chipBg = it.overdue ? "#C24A33" : "#FDF0EC";
            const chipInk = it.overdue ? "#FFFFFF" : "#8E3A28";
            return (
              <Link
                key={`${it.dueDate}:${i}`}
                href="/payables"
                prefetch={false}
                className="dzh-row"
                style={rowStyle}
                data-overdue={it.overdue ? "1" : undefined}
              >
                <span style={{ width: 44, flexShrink: 0, borderRadius: 10, background: chipBg, padding: "5px 0", display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: chipInk }}>{chip?.month ?? ""}</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: chipInk }}>{chip?.day ?? ""}</span>
                </span>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span style={titleStyle}>{it.title}</span>
                    {it.overdue ? <span style={tagStyle("#FFFFFF", "#C24A33")}>{t("home.desktop.obligations.overdue")}</span> : null}
                  </span>
                  <span style={subStyle}>{amount !== null ? formatShekel(amount, locale) : ""}</span>
                </span>
              </Link>
            );
          })}
        </Rows>
      );
  }
  return (
    <Panel title={t("home.desktop.obligations.title")} icon={{ Icon: IconCalendarSimple, color: "#B4432F", bg: "#FDF0EC" }} link={{ href: "/payables", label: t("home.desktop.all") }} basis="250px">
      {body}
    </Panel>
  );
}

function CollectionPanel({ view }: { view: HomeView }) {
  const { t, locale } = useI18n();
  const c = view.data.collection;
  let body: ReactNode;
  if (c.state === "loading") body = <PanelSkeleton />;
  else if (c.state === "failed") body = <Note>{t("home.desktop.collection.failed")}</Note>;
  else {
    // The only two collection truths: waiting (ממתין) and verified (נגבה ואומת).
    const rows = [
      ...c.value.waiting.slice(0, 2).map((w) => ({ ...w, verified: false, key: `w${w.requestId}` })),
      ...c.value.paid.slice(0, 1).map((p) => ({ ...p, verified: true, key: `p${p.requestId}` })),
    ];
    body =
      rows.length === 0 ? (
        <Note>{showsFirstTime(view.history, "collection", false) ? t("home.desktop.collection.none") : t("home.desktop.collection.empty")}</Note>
      ) : (
        <Rows>
          {rows.map((r) => (
            <Link key={r.key} href="/collection" prefetch={false} className="dzh-row" style={rowStyle}>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={titleStyle}>{r.customerName?.trim() || t("home.desktop.collection.noCustomer")}</span>
                <span style={subStyle}>{r.invoiceNumber ? t("home.desktop.collection.invoice", { number: r.invoiceNumber }) : t("home.desktop.collection.request")}</span>
              </span>
              <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{formatShekel(toNumber(r.amount) ?? 0, locale)}</span>
                {r.verified ? (
                  <span style={tagStyle("#1D5552", "#D3ECE8")}>{t("home.desktop.collection.verified")}</span>
                ) : (
                  <span style={tagStyle("#8A4F16", "#F6E0C2")}>{t("home.desktop.collection.waiting")}</span>
                )}
              </span>
            </Link>
          ))}
        </Rows>
      );
  }
  return (
    <Panel title={t("home.desktop.collection.title")} icon={{ Icon: IconCash, color: TEAL, bg: "#E3F2F0" }} link={{ href: "/collection", label: t("home.desktop.collection.link") }} basis="250px">
      {body}
    </Panel>
  );
}

const SOURCE_TAG: Record<string, { color: string; background: string }> = {
  email: { color: "#5B4FA8", background: "#ECE9F7" },
  file: { color: "#A0601F", background: "#FBEEDD" },
  whatsapp: { color: "#1D5552", background: "#D3ECE8" },
};

function DocumentsPanel({ view }: { view: HomeView }) {
  const { t, locale } = useI18n();
  const d = view.data.documents;
  let body: ReactNode;
  if (d.state === "loading") body = <PanelSkeleton />;
  else if (d.state === "failed") body = <Note>{t("home.desktop.documents.failed")}</Note>;
  else {
    const pending = d.value.items.filter((i) => i.status === "needs_review");
    const shown = pending.slice(0, 2);
    const more = d.value.totalPendingReview - shown.length;
    body =
      d.value.totalPendingReview === 0 ? (
        <Note>{showsFirstTime(view.history, "documents", false) ? t("home.desktop.documents.none") : t("home.desktop.documents.empty")}</Note>
      ) : (
        <>
          <Rows>
            {shown.map((doc) => {
              const amount = toNumber(doc.extracted?.amount ?? null);
              const src = doc.source ?? "";
              const tag = SOURCE_TAG[src];
              const srcLabel = sourceLabel(src, t);
              return (
                <Link key={doc.documentId} href={`/documents/review/${doc.documentId}`} prefetch={false} className="dzh-row" style={rowStyle}>
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                    <span style={titleStyle}>{doc.extracted?.vendorName?.trim() || t("home.desktop.documents.noVendor")}</span>
                    <span style={subStyle}>{amount !== null ? t("home.desktop.documents.withAmount", { amount: formatShekel(amount, locale) }) : t("home.desktop.documents.parsing")}</span>
                  </span>
                  {tag && srcLabel ? <span style={{ ...tagStyle(tag.color, tag.background), padding: "2px 8px" }}>{srcLabel}</span> : null}
                </Link>
              );
            })}
          </Rows>
          {more > 0 ? (
            <Link href="/documents/inbox" prefetch={false} className="dzh-link" style={{ fontSize: 12, fontWeight: 500, textDecoration: "none", padding: "6px 0" }}>
              {more === 1 ? t("home.desktop.documents.moreOne") : t("home.desktop.documents.moreMany", { count: more })}
            </Link>
          ) : null}
        </>
      );
  }
  return (
    <Panel title={t("home.desktop.documents.title")} icon={{ Icon: IconFileCheck, color: "#5B4FA8", bg: "#ECE9F7" }} link={{ href: "/documents/inbox", label: t("home.desktop.all") }} basis="250px">
      {body}
    </Panel>
  );
}

/**
 * No new leads to show. A business that never had a lead hears where they will
 * come from; the WhatsApp action follows the connection's real state (never
 * "disconnected" while inbound still arrives) and is absent once connected.
 */
function LeadsEmpty({ view }: { view: HomeView }) {
  const { t } = useI18n();
  const first = showsFirstTime(view.history, "leads", false);
  const action = view.history ? whatsAppAction(view.history.whatsapp, t) : null;
  // A disconnected number receives nothing until it is reconnected — the line
  // must not promise messages that cannot arrive.
  const firstLeadLine = view.history?.whatsapp === "DISCONNECTED" ? t("home.desktop.leads.noneYet") : t("home.desktop.leads.firstFromWhatsApp");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Note>{first ? firstLeadLine : t("home.desktop.leads.empty")}</Note>
      {/* Connecting WhatsApp Business is not open yet: the action stays, inactive, marked "בקרוב". */}
      {action ? (
        <span aria-disabled="true" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, padding: "4px 0 8px", alignSelf: "flex-start", opacity: 0.6, cursor: "not-allowed" }}>
          {action.label}
          <ComingSoonPill />
        </span>
      ) : null}
    </div>
  );
}

function LeadsPanel({ view }: { view: HomeView }) {
  const { t } = useI18n();
  const l = view.data.leads;
  let body: ReactNode;
  if (l.state === "loading") body = <PanelSkeleton />;
  else if (l.state === "failed") body = <Note>{t("home.desktop.leads.failed")}</Note>;
  else {
    const shown = l.value.slice(0, 2);
    body =
      shown.length === 0 ? (
        <LeadsEmpty view={view} />
      ) : (
        <>
          <Rows>
            {shown.map((lead) => (
              <Link key={lead.id} href={`/leads/${lead.id}`} prefetch={false} className="dzh-row" style={rowStyle}>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                  <span style={titleStyle}>{lead.name?.trim() || t("home.desktop.leads.noName")}</span>
                  <span style={subStyle}>{lead.phone || lead.sourceChannel || view.when(lead.createdAt)}</span>
                </span>
                <span style={{ ...tagStyle("#1D5552", "#D3ECE8"), padding: "2px 8px" }}>{t("home.desktop.leads.fresh")}</span>
              </Link>
            ))}
          </Rows>
          <div style={{ flex: 1 }} />
          <Link
            href={`/leads/${shown[0].id}`}
            prefetch={false}
            style={{
              height: 38,
              borderRadius: 11,
              border: "1px solid #CFE0DE",
              background: "#FFFFFF",
              color: "#1D5552",
              fontSize: 13,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              textDecoration: "none",
              boxSizing: "border-box",
            }}
          >
            {t("home.desktop.leads.backToLead")}
          </Link>
        </>
      );
  }
  return (
    <Panel title={t("home.desktop.leads.title")} icon={{ Icon: IconLeads, color: "#5B4FA8", bg: "#F2F0FA" }} link={{ href: "/leads", label: t("home.desktop.all") }} basis="250px">
      {body}
    </Panel>
  );
}

function ConversationsPanel({ view }: { view: HomeView }) {
  const { t } = useI18n();
  const c = view.data.conversations;
  let body: ReactNode;
  if (c.state === "loading") body = <PanelSkeleton />;
  else if (c.state === "failed") body = <Note>{t("home.desktop.conversations.failed")}</Note>;
  else {
    const shown = c.value.slice(0, 2);
    body =
      shown.length === 0 ? (
        <Note>{showsFirstTime(view.history, "conversations", false) ? t("home.desktop.conversations.none") : t("home.desktop.conversations.empty")}</Note>
      ) : (
        <Rows>
          {shown.map((conv) => {
            const email = conv.channel === "EMAIL";
            const Icon = email ? IconMail : IconChat;
            return (
              <Link key={conv.conversationId} href="/inbox" prefetch={false} className="dzh-row" style={{ ...rowStyle, gap: 12 }}>
                <span
                  style={{
                    width: 38,
                    height: 38,
                    flexShrink: 0,
                    borderRadius: 999,
                    background: email ? "#ECE9F7" : "#E3F2F0",
                    color: email ? "#5B4FA8" : TEAL,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon size={17} />
                </span>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                  <span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
                    <span style={{ ...titleStyle, fontWeight: 600 }}>{conv.customerName?.trim() || t("home.desktop.conversations.noName")}</span>
                    <span style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>· {channelLabel(conv.channel, t)}</span>
                  </span>
                  {conv.lastRelevantMessageText ? <span style={subStyle}>{conv.lastRelevantMessageText}</span> : null}
                </span>
                <span style={{ fontSize: 11, color: MUTED, flexShrink: 0 }}>{view.when(conv.relevantAt)}</span>
              </Link>
            );
          })}
        </Rows>
      );
  }
  return (
    <Panel title={t("home.desktop.conversations.title")} link={{ href: "/inbox", label: t("home.desktop.conversations.link") }} basis="320px">
      {body}
    </Panel>
  );
}

const STOCK_TONE = {
  critical: { bar: "#C24A33", label: "#B4432F", word: "home.desktop.stock.critical" },
  low: { bar: "#A0601F", label: "#8A4F16", word: "home.desktop.stock.low" },
  ok: { bar: "#3D9C9A", label: MUTED, word: null },
} as const satisfies Record<string, { bar: string; label: string; word: MessageKey | null }>;

function StockPanel({ view }: { view: HomeView }) {
  const { t } = useI18n();
  const inv = view.data.inventory;
  let body: ReactNode;
  if (inv.state === "loading") body = <PanelSkeleton />;
  else if (inv.state === "failed") body = <Note>{t("home.desktop.stock.failed")}</Note>;
  else {
    const rows = buildStockRows(inv.value, view.now, 3, t);
    body =
      rows.length === 0 ? (
        <Note>{showsFirstTime(view.history, "inventory", inv.value.length > 0) ? t("home.desktop.stock.none") : t("home.desktop.stock.empty")}</Note>
      ) : (
        rows.map((r) => {
          const tone = STOCK_TONE[r.state];
          const label = tone.word
            ? t("home.desktop.stock.withWord", { word: t(tone.word), qty: r.quantityText })
            : r.updatedToday
              ? t("home.desktop.stock.updatedToday", { qty: r.quantityText })
              : r.quantityText;
          return (
            <Link key={r.id} href={`/inventory/items/${r.id}`} prefetch={false} className="dzh-row" style={{ display: "flex", flexDirection: "column", gap: 6, textDecoration: "none", color: INK }}>
              <span style={{ display: "flex", justifyContent: "space-between", fontSize: 14, gap: 8 }}>
                <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                <span style={{ fontSize: 12, fontWeight: tone.word ? 600 : 400, color: tone.label, whiteSpace: "nowrap" }}>{label}</span>
              </span>
              <span
                role="img"
                aria-label={t("home.desktop.stock.barAria", { name: r.name, percent: Math.round(r.fill * 200) })}
                style={{ height: 8, borderRadius: 999, background: "#F3E8DA", overflow: "hidden", display: "block" }}
              >
                <span style={{ display: "block", width: `${Math.round(r.fill * 100)}%`, height: "100%", borderRadius: 999, background: tone.bar }} />
              </span>
            </Link>
          );
        })
      );
  }
  return (
    <Panel title={t("home.desktop.stock.title")} link={{ href: "/inventory", label: t("home.desktop.stock.link") }} basis="320px" gap={10}>
      {body}
      <div style={{ flex: 1 }} />
      <Link
        href="/inventory/supplier-purchases/new"
        prefetch={false}
        style={{
          height: 38,
          borderRadius: 11,
          border: "1px solid #CFE0DE",
          background: "#FFFFFF",
          color: "#1D5552",
          fontSize: 13,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textDecoration: "none",
          boxSizing: "border-box",
        }}
      >
        {t("home.desktop.stock.order")}
      </Link>
    </Panel>
  );
}

/* ------------------------------------------------------------ shortcuts -- */

const SHORTCUTS: Array<{ label: MessageKey; href: string; Icon: IconComponent; color: string; bg: string }> = [
  { label: "home.desktop.shortcuts.paymentLink", href: "/collection/new", Icon: IconCardSimple, color: TEAL, bg: "#E3F2F0" },
  { label: "home.desktop.shortcuts.newObligation", href: "/secretary?screen=bank", Icon: IconCalendarPlus, color: "#B4432F", bg: "#FDF0EC" },
  { label: "home.desktop.shortcuts.newCustomer", href: "/customers?new=1", Icon: IconUserPlus, color: "#5B4FA8", bg: "#ECE9F7" },
  { label: "home.desktop.shortcuts.uploadDocument", href: "/documents/upload", Icon: IconScan, color: "#A0601F", bg: "#FBEEDD" },
];

function Shortcuts() {
  const { t } = useI18n();
  return (
    <section
      aria-label={t("home.desktop.shortcuts.aria")}
      style={{ flex: "1 1 380px", minWidth: 0, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}
    >
      {SHORTCUTS.map((s) => (
        <Link
          key={s.href}
          href={s.href}
          prefetch={false}
          className="dzh-tile"
          style={{
            height: 54,
            borderRadius: 15,
            border: `1px solid ${LINE}`,
            background: CARD,
            color: INK,
            fontSize: 14,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 12px",
            textDecoration: "none",
            boxSizing: "border-box",
            minWidth: 0,
          }}
        >
          <span style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 10, background: s.bg, color: s.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <s.Icon size={16} strokeWidth={1.9} />
          </span>
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t(s.label)}</span>
        </Link>
      ))}
    </section>
  );
}

