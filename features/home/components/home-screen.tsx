"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { DubizLogo } from "@/components/ui/dubiz-logo";
import { FamilyIcon, type IconEntity } from "@/components/ui/entity/family-icon";
import { FamilyMark, type FamilyMarkKey } from "@/components/ui/entity/family-mark";
import { formatAmount } from "@/features/home/lib/home-model";
import type { AttentionObject } from "@/features/home/lib/home-attention";
import {
  comparisonSentence,
  legendLabels,
  PERIOD_TABS,
  type CollectionView,
  type HomePeriodKey,
} from "@/features/home/lib/home-collection-view";
import { InsightCard } from "@/features/home/components/insight-card";
import { categoryHref, HOME_ROUTES, TOOL_GROUPS, type ToolGroup } from "@/lib/navigation/home-routes";

/**
 * HOME.
 *
 * Three things, in the order the owner needs them:
 *
 *   COLLECTION   what came in, against the same slice of the period before it.
 *                It sits directly on the page — no card, no frame, no receipt
 *                treatment. The number is the loudest thing on the screen and
 *                the chart is its evidence, not a dashboard panel.
 *   RECEIPTS     what needs the owner, as a swipeable row of real objects.
 *                Each one is a different kind of thing and opens its own owner.
 *   בדוביז       where the business is managed. Quiet, last.
 *
 * WHAT HOME IS NOT: a dashboard, a report, or a second navigation system. There
 * is no counter grid, no Secretary banner, no fixed quick action ("+" owns
 * creation) and no "all tools" gateway.
 *
 * TRUTH: LOADING ≠ FAILED ≠ ZERO, everywhere. A source that failed says so and
 * never renders as ₪0; a real zero renders as a real zero and takes less room
 * than a busy day, because there is less to say.
 */

export type HomeIdentity = "dubiz" | "business";

export type HomeOverdueView =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; amount: number; customers: number };

export type HomeView = {
  businessName: string;
  businessLogoDataUrl: string | null;
  collection: CollectionView;
  period: HomePeriodKey;
  onPeriodChange: (next: HomePeriodKey) => void;
  overdue: HomeOverdueView;
  /** null while loading, or when the sources behind it could not be read. */
  objects: AttentionObject[] | null;
  objectsFailed: boolean;
  loading: boolean;
};

export function HomeScreen({
  view,
  identity,
  onIdentityChange,
}: {
  view: HomeView;
  identity: HomeIdentity;
  onIdentityChange: (next: HomeIdentity) => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const canShowBusinessLogo = Boolean(view.businessLogoDataUrl);
  const showingBusiness = identity === "business" && canShowBusinessLogo;

  return (
    <main className="dzhome" data-page-intent="content" dir="rtl">
      <style>{HOME_CSS}</style>
      <div className="w">
        <header className="top">
          <Link href={HOME_ROUTES.settings} className="gear" aria-label="הגדרות">
            <GearGlyph />
          </Link>
          <span className="brand">
            {showingBusiness ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data: URL the business already owns; the optimiser has nothing to fetch.
              <img className="brand-logo" src={view.businessLogoDataUrl ?? ""} alt="" />
            ) : (
              <DubizLogo height={21} />
            )}
            <button
              type="button"
              className="bizname"
              onClick={() => setSheetOpen(true)}
              aria-haspopup="dialog"
              aria-label="הזהות שמוצגת כאן"
            >
              {view.businessName}
              <span className="bizname-chev" aria-hidden>
                ⌄
              </span>
            </button>
          </span>
          <span className="gear ghost" aria-hidden />
        </header>

        <Collection view={view} />
        <Receipts view={view} />

        <section className="dz" aria-labelledby="dz-h">
          <h2 id="dz-h">בדוביז</h2>
          <div className="fams">
            {TOOL_GROUPS.map((group) => (
              <FamilyTile key={group.key} group={group} />
            ))}
          </div>
        </section>

        {/* What Dubiz has noticed. Nothing has been derived yet, and the card
            says exactly that rather than inventing an example. */}
        <InsightCard view={{ state: "learning" }} />
      </div>

      {sheetOpen ? (
        <IdentitySheet
          identity={identity}
          hasBusinessLogo={canShowBusinessLogo}
          onChoose={(next) => {
            onIdentityChange(next);
            setSheetOpen(false);
          }}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </main>
  );
}

/* ------------------------------------------------------- collection -- */

function Collection({ view }: { view: HomeView }) {
  return (
    <section className="col" aria-label="גבייה">
      <div className="col-grid">
        <div className="col-head">
          <h1>
            גבייה
            <BarsGlyph />
          </h1>
          <p className="col-sub">כך נראית הגבייה שלך</p>
          <CollectionHeadline view={view.collection} />
        </div>

        <div className="col-chart">
          <div className="seg" role="tablist" aria-label="תקופה">
            {PERIOD_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={view.period === tab.key}
                className={`seg-b${view.period === tab.key ? " on" : ""}`}
                onClick={() => view.onPeriodChange(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <ComparisonChart view={view.collection} />
        </div>
      </div>

      <FigureRow view={view} />
    </section>
  );
}

function CollectionHeadline({ view }: { view: CollectionView }) {
  if (view.state === "loading") {
    return (
      <>
        <span className="sk" style={{ width: 128, height: 38, margin: "8px 0 10px" }} />
        <span className="sk" style={{ width: 96, height: 15 }} />
      </>
    );
  }
  if (view.state === "failed") {
    return <p className="col-off">נתוני הגבייה לא נטענו כרגע</p>;
  }
  const sentence = comparisonSentence(view);
  return (
    <>
      <p className="col-amt">{formatAmount(String(view.total), "ILS")}</p>
      {view.changePct !== null ? (
        <span className={`delta${view.changePct >= 0 ? "" : " down"}`}>
          <span aria-hidden>{view.changePct >= 0 ? "↑" : "↓"}</span>
          {Math.abs(view.changePct)}%
        </span>
      ) : null}
      {sentence ? <p className="col-cmp">{sentence}</p> : null}
      {view.changePct === null && view.total > 0 ? (
        <p className="col-cmp">אין תקופה קודמת להשוות אליה</p>
      ) : null}
    </>
  );
}

/**
 * The comparison chart.
 *
 * Two lines and nothing else: this period in Dubiz teal with a light fill, the
 * period before it as a thin dashed line. No grid, no frame, no card. The teal
 * line STOPS at the point the period has actually reached — a future the
 * business has not lived is not drawn, faintly or otherwise.
 */
function ComparisonChart({ view }: { view: CollectionView }) {
  if (view.state === "loading") return <span className="sk chart-sk" />;
  if (view.state === "failed") return <div className="chart-off" aria-hidden />;

  const previousTotal = view.previousPoints[view.previousPoints.length - 1] ?? 0;
  // A period with nothing on either side does not get a full-height empty
  // chart; the composition shrinks to the size of what there is to say.
  if (view.total === 0 && previousTotal === 0) {
    return <p className="chart-none">לא נגבה כסף בתקופה הזו דרך Dubiz.</p>;
  }

  const legend = legendLabels(view.period);
  const lived = view.points.slice(0, Math.max(1, view.elapsedPoints));
  const peak = niceCeiling(Math.max(...lived, ...view.previousPoints, 1));

  const W = 210;
  const H = 92;
  const at = (index: number) => (index / Math.max(1, view.points.length - 1)) * W;
  const y = (value: number) => H - (value / peak) * (H - 10);
  const path = (values: number[]) => smoothPath(values.map((v, i) => [at(i), y(v)] as const));

  const livedPath = path(lived);
  const endX = at(lived.length - 1);
  const endY = y(lived[lived.length - 1] ?? 0);
  const area = `${livedPath} L${endX.toFixed(1)},${H} L0,${H} Z`;
  const ticks = view.granularity === "hour" ? ["00", "06", "12", "18", "24"] : view.dayLabels;

  return (
    <div className="chart">
      <div className="chart-rail">
        <svg
          viewBox={`0 0 ${W} ${H + 2}`}
          className="chart-svg"
          role="img"
          aria-label={`גבייה מצטברת: ${formatAmount(String(view.total), "ILS")}`}
        >
          <path d={area} fill="rgba(31,74,70,.13)" />
          {previousTotal > 0 ? (
            <path
              d={path(view.previousPoints)}
              fill="none"
              stroke="rgba(31,42,38,.32)"
              strokeWidth="1.4"
              strokeDasharray="3 3"
              strokeLinejoin="round"
            />
          ) : null}
          <path d={livedPath} fill="none" stroke="#1f4a46" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={endX} cy={endY} r="3.6" fill="#1f4a46" />
        </svg>
        <div className="chart-y" aria-hidden>
          <span>{shortMoney(peak)}</span>
          <span>{shortMoney((peak * 2) / 3)}</span>
          <span>{shortMoney(peak / 3)}</span>
          <span>0</span>
        </div>
      </div>
      <div className="chart-x" aria-hidden>
        {ticks.map((tick, index) => (
          <span key={`${tick}-${index}`}>{tick}</span>
        ))}
      </div>
      <p className="chart-lg" aria-hidden>
        <span className="lg-cur" />
        {legend.current}
        <span className="lg-prev" />
        {legend.previous}
      </p>
    </div>
  );
}

/** "1.2K" — an axis label, never an amount the owner is asked to act on. */
function shortMoney(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (value >= 100) return String(Math.round(value / 10) * 10);
  return String(Math.round(value));
}

/**
 * A top of scale a person would have chosen: 1.2K rather than 1,168.
 * The axis is furniture, so it should read as round numbers; the exact figure
 * is always the headline, which is never rounded.
 */
function niceCeiling(peak: number): number {
  if (peak <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(peak)));
  for (const step of [1, 1.2, 1.5, 2, 2.4, 3, 4, 5, 6, 7.5, 9, 10]) {
    const candidate = step * magnitude;
    // Thirds of the ceiling are what the axis labels, so prefer one that
    // divides cleanly enough to print.
    if (candidate >= peak) return candidate;
  }
  return 10 * magnitude;
}

/**
 * A curve through the points that cannot lie.
 *
 * The control points only ever move horizontally, so the line is smooth but
 * never rises above a point or dips below the one before it — a cumulative
 * total that appeared to fall would be reporting money leaving the business.
 */
function smoothPath(points: readonly (readonly [number, number])[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const mid = (x0 + x1) / 2;
    d += ` C${mid.toFixed(1)},${y0.toFixed(1)} ${mid.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

/** Two supporting figures, side by side under a hairline. */
function FigureRow({ view }: { view: HomeView }) {
  const overdue = view.overdue;
  const month = view.collection.state === "ready" ? view.collection.month : null;
  const overdueReady = overdue.state === "ready" && overdue.amount > 0;
  if (overdue.state !== "loading" && !overdueReady && !month) return null;

  return (
    <div className="figs">
      {month ? (
        <Link href={HOME_ROUTES.collectionCenter} className="fig">
          <span className="fig-ic" aria-hidden>
            <WalletGlyph />
          </span>
          <span className="fig-tx">
            <b>{formatAmount(String(month.amount), "ILS")}</b>
            <span>גבייה החודש</span>
          </span>
          {month.changePct !== null ? (
            <span className={`delta sm${month.changePct >= 0 ? "" : " down"}`}>
              <span aria-hidden>{month.changePct >= 0 ? "↑" : "↓"}</span>
              {Math.abs(month.changePct)}%
            </span>
          ) : null}
        </Link>
      ) : (
        <span />
      )}

      {overdue.state === "loading" ? (
        <span className="sk" style={{ width: "76%", height: 38 }} />
      ) : overdueReady && overdue.state === "ready" ? (
        <Link href={HOME_ROUTES.collectionCenter} className="fig trail">
          <span className="fig-tx">
            <b>{formatAmount(String(overdue.amount), "ILS")}</b>
            <span>חשבוניות באיחור</span>
            <span className="fig-sub">
              {overdue.customers === 1 ? "לקוח אחד" : `${overdue.customers} לקוחות`}
            </span>
          </span>
          <span className="fig-ic urgent" aria-hidden>
            <ClockGlyph size={19} />
          </span>
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}

/* --------------------------------------------------------- receipts -- */

const KIND_LABEL: Record<string, string> = {
  obligation: "לתשלום",
  document: "מסמך לבדיקה",
  lead: "ליד ממתין",
  inventory: "מלאי",
  other: "לטיפול",
};

/** A quiet tint per kind, so a chip says WHAT this is before it is read. */
const KIND_TINT: Record<string, string> = {
  obligation: "rgba(169,117,28,.13)",
  document: "rgba(62,122,99,.13)",
  lead: "rgba(124,92,191,.12)",
  inventory: "rgba(124,92,191,.12)",
  other: "rgba(31,42,38,.07)",
};

const KIND_ICON: Record<string, IconEntity> = {
  obligation: "payables",
  document: "documents",
  lead: "leads",
  inventory: "inventory",
  other: "documents",
};

/**
 * The receipt carousel — what needs the owner, one object at a time.
 *
 * Each receipt is a different KIND of real thing (money the business owes, a
 * document waiting to be checked, a lead nobody answered, a stock problem),
 * carries its own colour, and opens its OWN owner — never one generic page.
 * It is a priority subset on purpose: the full list lives where it belongs.
 */
function Receipts({ view }: { view: HomeView }) {
  const rail = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(0);
  const shown = (view.objects ?? []).slice(0, 5);

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const onScroll = () => {
      const middle = el.scrollLeft + el.clientWidth / 2;
      let best = 0;
      let bestDistance = Infinity;
      Array.from(el.children).forEach((child, index) => {
        const node = child as HTMLElement;
        const centre = node.offsetLeft + node.offsetWidth / 2;
        const distance = Math.abs(centre - middle);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      });
      setFocused(best);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [shown.length]);

  if (view.objectsFailed) {
    return <p className="rc-quiet">לא הצלחתי לבדוק כרגע מה מחכה לך.</p>;
  }
  if (view.loading || view.objects === null) {
    return (
      <div className="rc" aria-busy="true">
        <div className="rc-rail">
          <span className="sk rc-sk" />
        </div>
      </div>
    );
  }
  if (shown.length === 0) {
    return (
      <Link href={HOME_ROUTES.secretary} className="rc-calm">
        <FamilyIcon entity="collection" size={26} />
        אין כרגע משהו שמחכה לך.
      </Link>
    );
  }

  return (
    <div className="rc">
      <div className="rc-rail" ref={rail}>
        {shown.map((object, index) => (
          <Receipt key={object.key} object={object} focused={index === focused} />
        ))}
      </div>
      {shown.length > 1 ? (
        <div className="rc-dots" aria-hidden>
          {shown.map((object, index) => (
            <span key={object.key} className={index === focused ? "on" : undefined} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Receipt({ object, focused }: { object: AttentionObject; focused: boolean }) {
  const urgent = Boolean(object.chip?.urgent);
  const cta = object.kind === "document" ? "לבדיקה" : "לטיפול";
  return (
    <article className={`rc-item${focused ? " on" : ""}`}>
      <span className="rc-back" aria-hidden />
      <Link href={object.href} className="rc-paper">
        <span className="rc-top">
          {object.chip ? (
            <span
              className={`rc-chip${urgent ? " urgent" : ""}`}
              style={urgent ? undefined : { background: KIND_TINT[object.kind] ?? KIND_TINT.other }}
            >
              {urgent ? <ClockGlyph size={14} /> : null}
              {object.chip.label}
            </span>
          ) : (
            <span />
          )}
          <span className="rc-kind">
            {KIND_LABEL[object.kind] ?? KIND_LABEL.other}
            <FamilyIcon entity={KIND_ICON[object.kind] ?? "documents"} size={20} />
          </span>
        </span>

        <span className="rc-body">
          <span className="rc-title">{object.title}</span>
          {object.meta ? <span className="rc-meta">{object.meta}</span> : null}
        </span>

        <span className="rc-bottom">
          <span className="rc-cta">{cta}</span>
          {object.amount ? <span className="rc-amt">{object.amount}</span> : null}
        </span>
        <TornEdge />
      </Link>
    </article>
  );
}

/* --------------------------------------------------------- families -- */

/**
 * A family tile.
 *
 * Three of them in one row, compact enough to survive 360px. The whole surface
 * is the target; the mark carries the personality and the tint stays quiet, so
 * the families never compete with the money or the receipts above them.
 */
function FamilyTile({ group }: { group: ToolGroup }) {
  return (
    <Link href={categoryHref(group)} className={`fam fam-${group.key}`}>
      <span className="fam-ic" aria-hidden>
        <FamilyMark family={group.key as FamilyMarkKey} height={30} />
      </span>
      <span className="fam-t">{group.label}</span>
      <span className="fam-l">{bindSeparators(group.capabilityLine)}</span>
    </Link>
  );
}

/**
 * Keeps the "·" with the word it follows.
 *
 * A capability line wraps inside a narrow tile, and left to itself it breaks
 * BEFORE the separator — so a line opens with a floating dot. Binding the
 * separator to the preceding word with a no-break space moves every break to
 * the gap after it, which is where a reader expects one.
 */
function bindSeparators(line: string): string {
  return line.split(" · ").join(" · ");
}

/* ------------------------------------------------------------ parts -- */

function IdentitySheet({
  identity,
  hasBusinessLogo,
  onChoose,
  onClose,
}: {
  identity: HomeIdentity;
  hasBusinessLogo: boolean;
  onChoose: (next: HomeIdentity) => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet" role="dialog" aria-label="הזהות שמוצגת">
      <div className="sheet-in">
        <p className="sheet-t">מה יוצג כאן?</p>
        <button
          type="button"
          className={`sheet-o${identity === "dubiz" ? " on" : ""}`}
          onClick={() => onChoose("dubiz")}
        >
          <DubizLogo height={16} /> הלוגו של Dubiz
        </button>
        {hasBusinessLogo ? (
          <button
            type="button"
            className={`sheet-o${identity === "business" ? " on" : ""}`}
            onClick={() => onChoose("business")}
          >
            הלוגו של העסק
          </button>
        ) : (
          <p className="sheet-note">עוד לא הועלה לוגו לעסק.</p>
        )}
        <Link href="/settings/business" className="sheet-o sheet-link" onClick={onClose}>
          {hasBusinessLogo ? "החלפת הלוגו של העסק ›" : "העלאת לוגו לעסק ›"}
        </Link>
        <button type="button" className="sheet-x" onClick={onClose}>
          סגירה
        </button>
      </div>
    </div>
  );
}

function GearGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#3d4944" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.9 14.4a1.7 1.7 0 0 0 .34 1.87l.06.06a2.1 2.1 0 1 1-2.97 2.97l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55v.17a2.1 2.1 0 1 1-4.2 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2.1 2.1 0 1 1-2.97-2.97l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1.03H2.8a2.1 2.1 0 1 1 0-4.2h.09A1.7 1.7 0 0 0 4.44 8.2a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.1 2.1 0 1 1 7.01 3.3l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10.05 2.2V2.1a2.1 2.1 0 1 1 4.2 0v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2.1 2.1 0 1 1 2.97 2.97l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.55 1.03h.17a2.1 2.1 0 1 1 0 4.2h-.09a1.7 1.7 0 0 0-1.55 1.03z" />
    </svg>
  );
}

function BarsGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#1f4a46" strokeWidth="2.3" strokeLinecap="round" aria-hidden>
      <path d="M6 15.5V19M12 9.5V19M18 5v14" />
    </svg>
  );
}

function ClockGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3 1.8" />
    </svg>
  );
}

function WalletGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.4 7.6a2 2 0 0 1 2-2h11.2a2 2 0 0 1 2 2v1.2" />
      <path d="M3.4 7.6v9.2a2 2 0 0 0 2 2h13.2a2 2 0 0 0 2-2v-2.2" />
      <path d="M20.6 9.4v4.4h-4a2.2 2.2 0 0 1 0-4.4z" />
    </svg>
  );
}

/** The torn edge that makes a receipt a slip of paper rather than a card. */
function TornEdge() {
  const teeth = 20;
  const points: string[] = [];
  for (let i = 0; i <= teeth; i += 1) points.push(`${(i * 100) / teeth},${i % 2 === 0 ? 1 : 7}`);
  return (
    <svg className="rc-torn" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden>
      <polygon points={`0,0 ${points.join(" ")} 100,0`} fill="#fffdf8" />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="#1f2a26"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const HOME_CSS = `
.dzhome{
  --ink:#1f2a26; --ink2:#55605a; --ink3:#8a938d; --teal:#1f4a46; --action:#2f615c;
  --paper:#f7f4ed; --white:#fffdf8; --hair:rgba(31,42,38,.13);
  --coral:#c2553a; --coral-tint:#fbe3dc; --ochre:#eccd86; --good:#2f7a5c; --good-tint:#dff0e4;
  direction:rtl; min-height:100dvh; color:var(--ink); background:var(--paper);
  font-family:var(--font-heebo),'Heebo',system-ui,sans-serif; -webkit-font-smoothing:antialiased;
}
.dzhome a{color:inherit;text-decoration:none;-webkit-tap-highlight-color:transparent}
.dzhome a:focus-visible,.dzhome button:focus-visible{outline:3px solid var(--action);outline-offset:3px;border-radius:12px}
.dzhome .w{max-width:480px;margin:0 auto;padding:calc(6px + var(--dz-safe-top,0px)) 18px 20px}
.dzhome .sk{display:block;border-radius:8px;background:rgba(31,42,38,.08)}

/* header */
.dzhome .top{display:grid;grid-template-columns:44px 1fr 44px;align-items:start;min-height:54px}
.dzhome .gear{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;order:3}
.dzhome .gear svg{width:23px;height:23px}
.dzhome .gear.ghost{order:1}
.dzhome .brand{order:2;justify-self:center;display:flex;flex-direction:column;align-items:center;gap:1px;padding-top:6px}
.dzhome .brand-logo{max-height:24px;max-width:130px;object-fit:contain;display:block}
.dzhome .bizname{display:inline-flex;align-items:center;gap:5px;min-height:44px;margin:-8px 0;padding:0 10px;border:0;background:none;
  font:inherit;font-size:13.5px;font-weight:700;color:var(--ink2);cursor:pointer}
.dzhome .bizname-chev{font-size:12px;line-height:1;color:var(--ink3)}

/* collection — sits on the page, never in a card */
.dzhome .col{margin-top:10px}
.dzhome .col-grid{display:grid;grid-template-columns:minmax(0,.84fr) minmax(0,1.16fr);gap:10px;align-items:start}
.dzhome .col-head h1{display:flex;align-items:center;gap:6px;margin:0;font-size:19px;font-weight:800;line-height:1.1}
.dzhome .col-sub{margin:3px 0 0;font-size:12px;font-weight:600;color:var(--ink2)}
.dzhome .col-amt{margin:8px 0 0;font-size:38px;font-weight:800;letter-spacing:-.035em;line-height:1;font-variant-numeric:tabular-nums}
.dzhome .col-off{margin:10px 0 0;font-size:15px;font-weight:700;color:var(--ink2);line-height:1.35}
.dzhome .delta{display:inline-flex;align-items:center;gap:3px;margin-top:9px;padding:3px 9px;border-radius:999px;
  background:var(--good-tint);color:var(--good);font-size:12.5px;font-weight:800;font-variant-numeric:tabular-nums}
.dzhome .delta.down{background:var(--coral-tint);color:var(--coral)}
.dzhome .delta.sm{margin:0;font-size:11.5px;padding:2px 7px}
.dzhome .col-cmp{margin:7px 0 0;font-size:11.5px;font-weight:600;color:var(--ink2);line-height:1.35;text-wrap:balance}

/* segmented period selector */
.dzhome .seg{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;padding:3px;border-radius:999px;background:rgba(31,42,38,.06)}
.dzhome .seg-b{line-height:1.1}
.dzhome .seg-b{min-height:44px;border:0;border-radius:999px;background:none;font:inherit;font-size:12.5px;font-weight:700;
  color:var(--ink2);cursor:pointer;padding:0 2px}
.dzhome .seg-b.on{background:var(--teal);color:#fffdf8;font-weight:800}

/* chart */
.dzhome .chart{margin-top:10px}
.dzhome .chart-sk{height:116px;border-radius:10px;margin-top:10px}
.dzhome .chart-off{height:92px;margin-top:10px;border-bottom:1.4px solid var(--hair);opacity:.35}
.dzhome .chart-none{margin:14px 0 0;font-size:12.5px;font-weight:600;color:var(--ink2);line-height:1.4}
.dzhome .chart-rail{display:flex;align-items:stretch;gap:5px;direction:ltr}
.dzhome .chart-svg{flex:1;min-width:0;height:92px;overflow:visible}
.dzhome .chart-y{display:flex;flex-direction:column;justify-content:space-between;font-size:9.5px;font-weight:700;
  color:var(--ink3);font-variant-numeric:tabular-nums;padding:0 1px 2px}
.dzhome .chart-x{display:flex;justify-content:space-between;margin-top:4px;padding-inline-end:26px;direction:ltr;
  font-size:9.5px;font-weight:700;color:var(--ink3);font-variant-numeric:tabular-nums}
.dzhome .chart-lg{display:flex;align-items:center;gap:5px;margin:7px 0 0;direction:ltr;justify-content:flex-start;
  font-size:10.5px;font-weight:700;color:var(--ink2)}
.dzhome .lg-cur{width:9px;height:9px;border-radius:50%;background:var(--teal)}
.dzhome .lg-prev{width:13px;height:0;border-top:1.6px dashed rgba(31,42,38,.45);margin-inline-start:7px}

/* two supporting figures */
.dzhome .figs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--hair)}
.dzhome .fig{display:flex;align-items:center;gap:8px;min-height:52px}
.dzhome .fig.trail{justify-content:flex-end}
.dzhome .figs .fig+.fig{border-inline-start:1px solid var(--hair);padding-inline-start:10px}
.dzhome .fig-ic{display:flex;color:#1f6f6b}
.dzhome .fig-ic.urgent{color:var(--coral)}
.dzhome .fig-tx{display:flex;flex-direction:column;gap:0;min-width:0}
.dzhome .fig-tx b{font-size:16px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.dzhome .fig-tx span{font-size:11.5px;font-weight:600;color:var(--ink2);line-height:1.3}
.dzhome .fig-sub{color:var(--ink3)}

/* receipts */
.dzhome .rc{margin:16px -18px 0}
.dzhome .rc-rail{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding:6px 18px 4px;
  scrollbar-width:none;-ms-overflow-style:none}
.dzhome .rc-rail::-webkit-scrollbar{display:none}
.dzhome .rc-sk{flex:0 0 74%;height:164px;border-radius:14px;scroll-snap-align:center}
.dzhome .rc-item{position:relative;flex:0 0 74%;scroll-snap-align:center;padding-bottom:9px;
  transform:scale(.955);transform-origin:center bottom;transition:transform .18s ease,opacity .18s ease;opacity:.84}
.dzhome .rc-item.on{transform:scale(1);opacity:1}
.dzhome .rc-back{position:absolute;inset:10px -6px 0 6px;border-radius:13px;background:var(--ochre)}
.dzhome .rc-paper{position:relative;display:flex;flex-direction:column;gap:9px;min-height:148px;padding:12px 13px 14px;
  background:var(--white);border:2px solid var(--ink);border-bottom:none;border-radius:13px 13px 0 0}
.dzhome .rc-torn{position:absolute;left:-2px;right:-2px;bottom:-8px;width:calc(100% + 4px);height:8px}
.dzhome .rc-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dzhome .rc-kind{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:800;color:var(--ink2)}
.dzhome .rc-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;border-radius:999px;
  background:rgba(31,42,38,.07);color:var(--ink2);font-size:11.5px;font-weight:800}
.dzhome .rc-chip.urgent{background:var(--coral-tint);color:var(--coral)}
.dzhome .rc-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.dzhome .rc-title{font-size:18px;font-weight:800;line-height:1.2;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.dzhome .rc-meta{font-size:12px;font-weight:600;color:var(--ink2);line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.dzhome .rc-bottom{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:auto}
.dzhome .rc-amt{font-size:25px;font-weight:800;letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums}
.dzhome .rc-cta{display:inline-flex;align-items:center;height:40px;padding:0 20px;border-radius:11px;
  background:var(--action);color:#fffdf8;font-size:14.5px;font-weight:800}
.dzhome .rc-dots{display:flex;justify-content:center;gap:6px;margin-top:8px}
.dzhome .rc-dots span{width:6px;height:6px;border-radius:50%;background:rgba(31,42,38,.2)}
.dzhome .rc-dots span.on{background:var(--teal);width:7px;height:7px}
.dzhome .rc-quiet{margin:16px 0 0;font-size:14px;color:var(--ink2)}
.dzhome .rc-calm{display:flex;align-items:center;gap:10px;margin-top:16px;min-height:52px;font-size:15px;font-weight:700;color:var(--ink2)}

/* families — three quiet tiles, one row, the mark doing the talking */
/*
 * The floating accessibility control rests over the bottom-inline-start corner
 * of the viewport. The families answer that with VERTICAL room, never by
 * giving up width: the tiles keep the page's full content width and stay
 * symmetrical, and the section carries a clear zone below them so the control
 * always has somewhere to sit that is not on top of a word.
 */
.dzhome .dz{margin-top:6px}
.dzhome .dz h2{margin:0 0 5px;font-size:18px;font-weight:800}
.dzhome .fams{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
/* Fixed zones: the mark, the name and the line each get the same room in all
   three tiles, so the three read as one row rather than three cards that
   happen to sit together. */
.dzhome .fam{display:flex;flex-direction:column;gap:5px;padding:9px 10px 10px;
  border:1px solid rgba(31,42,38,.11);border-radius:15px}
.dzhome .fam-ic{display:flex;align-items:flex-end;height:30px}
.dzhome .fam-t{font-size:13px;font-weight:800;line-height:1.15;min-height:15px}
.dzhome .fam-l{font-size:11px;font-weight:600;line-height:1.32;color:var(--ink2);min-height:29px;text-wrap:balance}
/* Tints from the same page: sand, mint, sage-stone. Nothing saturated. */
.dzhome .fam-money{background:#f1e6d2}
.dzhome .fam-customers{background:#e2ece4}
.dzhome .fam-operations{background:#e4e9e0}

/* insights — the third voice, and the quietest of the three */
.dzhome .ins{margin-top:12px;margin-inline-end:62px;margin-bottom:26px;padding:11px 13px 13px;
  background:#e7f0ea;border:1px solid rgba(31,42,38,.1);border-radius:16px}
.dzhome .ins-eyebrow{display:flex;align-items:center;gap:6px;margin:0;font-size:11px;font-weight:800;color:#1f6f6b}
.dzhome .ins-t{margin:5px 0 0;font-size:15px;font-weight:800;line-height:1.25}
.dzhome .ins-b{margin:4px 0 0;font-size:11.5px;font-weight:600;line-height:1.45;color:var(--ink2);text-wrap:pretty}

/* identity sheet */
.dzhome .sheet{position:fixed;inset:0;z-index:160;background:rgba(31,42,38,.35);display:flex;align-items:flex-end}
.dzhome .sheet-in{width:100%;max-width:480px;margin:0 auto;background:var(--white);border-radius:22px 22px 0 0;
  padding:18px 18px calc(22px + var(--dz-safe-bottom,0px));display:flex;flex-direction:column;gap:8px}
.dzhome .sheet-t{margin:0 0 4px;font-size:15px;font-weight:800}
.dzhome .sheet-o{display:flex;align-items:center;gap:10px;min-height:52px;padding:0 14px;border:1.5px solid var(--hair);
  border-radius:14px;background:var(--paper);font:inherit;font-size:14.5px;font-weight:700;cursor:pointer;text-align:start}
.dzhome .sheet-o.on{border-color:var(--action);box-shadow:inset 0 0 0 1px var(--action)}
.dzhome .sheet-note{margin:0;padding:0 4px;font-size:13px;color:var(--ink2)}
.dzhome .sheet-link{color:var(--action)}
.dzhome .sheet-x{min-height:48px;border:0;background:none;font:inherit;font-size:14px;font-weight:800;color:var(--ink2);cursor:pointer}

@media (max-width:374px){
  .dzhome .w{padding-left:14px;padding-right:14px}
  .dzhome .col-amt{font-size:33px}
  .dzhome .rc{margin-left:-14px;margin-right:-14px}
  .dzhome .rc-rail{padding-left:14px;padding-right:14px}
  .dzhome .fams{gap:8px}
  .dzhome .fam{padding:9px 8px 10px}
  .dzhome .fam-t{font-size:12.5px}
}
@media (min-width:768px){
  .dzhome .w{max-width:620px}
}
`;
