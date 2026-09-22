"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";

import { DubizLogo } from "@/components/ui/dubiz-logo";
import { EntityIcon } from "@/components/ui/entity/entity-icon";
import { toneOfEntity, URGENT } from "@/lib/design/entity-tones";
import { formatAmount } from "@/features/home/lib/home-model";
import type { AttentionObject } from "@/features/home/lib/home-attention";
import {
  categoryHref,
  HOME_ROUTES,
  TOOL_GROUPS,
  type ToolGroup,
} from "@/lib/navigation/home-routes";
import { dayLabel, type DayNavigation, type HomeDayView } from "@/features/home/lib/home-day-view";

/**
 * HOME.
 *
 * One screen, three layers, in the order the owner's attention actually moves:
 *
 *   THE DAY        what came in through Dubiz today, hour by hour, and the
 *                  month it sits inside. The business's own voice.
 *   THE SECRETARY  what needs the owner. Her own slot, her own objects.
 *   DUBIZ          the three families — quiet, last, never competing with the
 *                  live state above them.
 *
 * WHAT HOME IS NOT: a dashboard. There is no counter grid, no feature banner,
 * no fixed quick action ("+" owns creation), no "all tools" gateway, and no
 * fact stated four times. Each fact appears once, at the level where it means
 * something.
 *
 * TRUTH: every figure carries its own load state. LOADING ≠ FAILED ≠ ZERO — a
 * source that failed says so and never renders as ₪0, and a real zero renders
 * as a real zero.
 */

export type HomeIdentity = "dubiz" | "business";

export type HomeOverdueView =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; amount: number; customers: number };

export type HomeView = {
  businessName: string;
  /** The business logo, when one is configured. */
  businessLogoDataUrl: string | null;
  day: HomeDayView;
  nav: DayNavigation;
  /** null while loading, or when the briefing / status could not be read. */
  objects: AttentionObject[] | null;
  objectsFailed: boolean;
  watching: number;
  overdue: HomeOverdueView;
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
  const objects = view.objects ?? [];
  const label = useMemo(() => dayLabel(view.nav.offset), [view.nav.offset]);
  const canShowBusinessLogo = Boolean(view.businessLogoDataUrl);
  const showingBusiness = identity === "business" && canShowBusinessLogo;

  return (
    <main className="dzhome" data-page-intent="content" dir="rtl">
      <style>{HOME_CSS}</style>
      <div className="w">
        {/* Settings on the left, identity centred, the business under it. */}
        <header className="top">
          <Link href={HOME_ROUTES.settings} className="gear" aria-label="הגדרות">
            <GearGlyph />
          </Link>
          <button
            type="button"
            className="ident"
            onClick={() => setSheetOpen(true)}
            aria-haspopup="dialog"
            aria-label="הזהות שמוצגת כאן"
          >
            {showingBusiness ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data: URL the business already owns; the image optimiser has nothing to fetch.
              <img className="ident-logo" src={view.businessLogoDataUrl ?? ""} alt="" />
            ) : (
              <DubizLogo height={18} />
            )}
          </button>
          <span className="gear ghost" aria-hidden />
        </header>
        <p className="bizname">{view.businessName}</p>

        {/* LAYER 1 — the day */}
        <section className="day" aria-label="נגבה דרך Dubiz">
          <div className="daynav">
            <button type="button" className="dn" onClick={view.nav.goEarlier} aria-label="היום הקודם">
              ›
            </button>
            <span className="dn-t">{label.short}</span>
            <button
              type="button"
              className="dn"
              onClick={view.nav.goLater}
              disabled={view.nav.offset === 0}
              aria-label="היום הבא"
            >
              ‹
            </button>
            {view.nav.offset !== 0 ? (
              <button type="button" className="dn-today" onClick={view.nav.goToday}>
                חזרה להיום
              </button>
            ) : null}
          </div>

          <p className="day-l">{label.title}</p>
          <DayAmount day={view.day} />
          <HourGraph day={view.day} />
          <FinancialContext day={view.day} overdue={view.overdue} />
        </section>

        {/* "עוד היום" describes TODAY; an earlier day must not imply it. */}
        {view.nav.offset === 0 ? <Activity day={view.day} /> : null}

        {/* LAYER 2 — the Secretary */}
        <section className="sec" aria-label="המזכירה — מה צריך אותך">
          <div className="sec-head">
            <span className="por">
              {view.loading ? (
                <span className="sk" style={{ width: "100%", height: "100%", borderRadius: "50%" }} />
              ) : (
                <Image src="/secretary-avatar.jpg" alt="" width={36} height={36} />
              )}
            </span>
            <span className="sec-name">המזכירה</span>
            {!view.loading && objects.length > 0 ? (
              <span className="sec-ctx">
                {objects.length === 1 ? "דבר אחד" : `${objects.length} דברים`}
              </span>
            ) : null}
            <span className="sec-rule" aria-hidden />
          </div>
          <Attention view={view} />
        </section>

        {/* LAYER 3 — the product */}
        <section className="dz" aria-labelledby="dz-h">
          <h2 id="dz-h">בדוביז</h2>
          <ul>
            {TOOL_GROUPS.map((group) => (
              <li key={group.key}>
                <FamilyRow group={group} />
              </li>
            ))}
          </ul>
        </section>
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

/* ----------------------------------------------------------- the day -- */

function DayAmount({ day }: { day: HomeDayView }) {
  if (day.state === "loading") return <span className="sk" style={{ width: 180, height: 44, margin: "4px 0" }} />;
  if (day.state === "failed") return <p className="day-off">נתוני הגבייה לא נטענו כרגע</p>;
  return (
    <p className="day-amt">
      {formatAmount(String(day.total), "ILS")}
      {day.count > 0 ? (
        <span className="day-n">{day.count === 1 ? "תשלום אחד" : `${day.count} תשלומים`}</span>
      ) : null}
    </p>
  );
}

/**
 * Hourly BUCKETS, not a cumulative line.
 *
 * With a handful of payments a day, a bar at 09:00 says "a payment came in at
 * nine". A cumulative curve would draw a continuous climb across hours in which
 * nothing happened, implying activity the business did not have. Anchors at
 * 00 / 06 / 12 / 18 / 24 only — this is the business's day, not an analytics
 * screen. On today, hours that have not arrived yet are drawn fainter, so an
 * empty evening reads as "not yet" instead of "nothing".
 */
function HourGraph({ day }: { day: HomeDayView }) {
  if (day.state === "loading") return <span className="sk" style={{ display: "block", height: 74, borderRadius: 10 }} />;
  if (day.state === "failed") return <div className="hg empty" aria-hidden />;
  const max = Math.max(...day.hours, 1);
  const empty = day.total === 0;
  return (
    <div className="hg">
      <div
        className="hg-bars"
        role="img"
        aria-label={empty ? "אין גבייה ביום הזה" : `גבייה לפי שעות: ${formatAmount(String(day.total), "ILS")}`}
      >
        {day.hours.map((value, hour) => (
          <span
            key={hour}
            className={`hg-b${value > 0 ? " on" : ""}${day.elapsedHours !== null && hour > day.elapsedHours ? " ahead" : ""}`}
            style={value > 0 ? { height: `${Math.max(8, (value / max) * 100)}%` } : undefined}
          />
        ))}
      </div>
      <div className="hg-ax" aria-hidden>
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      {empty ? <p className="hg-none">לא נגבה כסף ביום הזה דרך Dubiz.</p> : null}
    </div>
  );
}

/**
 * FINANCIAL CONTEXT — the numbers read first, the words explain them.
 *
 * Two figure groups with a hairline between them and a semantic rule above
 * each. Secondary to the day's own amount by size and weight; never a KPI grid.
 */
function FinancialContext({ day, overdue }: { day: HomeDayView; overdue: HomeOverdueView }) {
  if (day.state === "loading" || overdue.state === "loading") {
    return (
      <div className="fc" aria-busy="true">
        <span className="sk" style={{ width: "80%", height: 46 }} />
        <span className="sk" style={{ width: "80%", height: 46 }} />
      </div>
    );
  }
  const month = day.state === "ready" ? day.month : null;
  const showOverdue = overdue.state === "ready" && overdue.amount > 0;
  if (!month && !showOverdue) return null;
  return (
    <div className="fc">
      {month ? (
        <Link href={HOME_ROUTES.collectionCenter} className="fc-g">
          <span className="fc-rule" style={{ background: toneOfEntity("collection").ink }} aria-hidden />
          <span className="fc-n">
            {formatAmount(String(month.amount), "ILS")}
            {month.changePct !== null ? (
              <span className={`fc-tr${month.changePct >= 0 ? "" : " down"}`}>
                {month.changePct >= 0 ? "+" : "−"}
                {Math.abs(month.changePct)}%
              </span>
            ) : null}
          </span>
          <span className="fc-l">
            {month.changePct !== null ? "נגבה החודש · מול החודש שעבר" : "נגבה החודש"}
          </span>
        </Link>
      ) : null}
      {overdue.state === "ready" && overdue.amount > 0 ? (
        <Link href={HOME_ROUTES.collectionCenter} className="fc-g">
          <span className="fc-rule" style={{ background: toneOfEntity("invoice").ink }} aria-hidden />
          <span className="fc-n">
            {formatAmount(String(overdue.amount), "ILS")}
            <span className="fc-sub">
              {overdue.customers === 1 ? "לקוח אחד" : `${overdue.customers} לקוחות`}
            </span>
          </span>
          <span className="fc-l">בחשבוניות באיחור</span>
        </Link>
      ) : null}
    </div>
  );
}

/** What else happened today — each fact as its own small entity object. */
function Activity({ day }: { day: HomeDayView }) {
  if (day.state !== "ready" || !day.activity) return null;
  const items: { key: string; entity: string; label: string; href: string }[] = [];
  if (day.activity.invoicesIssued > 0) {
    items.push({
      key: "invoices",
      entity: "invoice",
      label:
        day.activity.invoicesIssued === 1
          ? "חשבונית הופקה"
          : `${day.activity.invoicesIssued} חשבוניות הופקו`,
      href: "/billing",
    });
  }
  if (day.activity.newLeads > 0) {
    items.push({
      key: "leads",
      entity: "leads",
      label: day.activity.newLeads === 1 ? "ליד חדש" : `${day.activity.newLeads} לידים חדשים`,
      href: "/leads",
    });
  }
  if (items.length === 0) return null;
  return (
    <div className="act">
      <span className="act-l">עוד היום</span>
      {items.map((item) => {
        const tone = toneOfEntity(item.entity);
        return (
          <Link key={item.key} href={item.href} className="act-o" style={{ background: tone.tint }}>
            <EntityIcon entity={item.entity} size={22} />
            <span style={{ color: tone.ink }}>{item.label}</span>
          </Link>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------- secretary -- */

function Attention({ view }: { view: HomeView }) {
  if (view.objectsFailed) return <p className="sec-quiet">לא הצלחתי לבדוק כרגע מה מחכה לך.</p>;

  if (view.loading || view.objects === null) {
    return (
      <div className="stage" aria-busy="true">
        <span className="slab" style={{ background: toneOfEntity("payables").solid }} aria-hidden />
        <div className="obj sk-obj">
          <span className="sk" style={{ width: 120, height: 12 }} />
          <span className="sk" style={{ width: "65%", height: 22 }} />
          <span className="sk" style={{ width: 130, height: 30 }} />
        </div>
      </div>
    );
  }

  if (view.objects.length === 0) {
    return (
      <Link href={HOME_ROUTES.secretary} className="calm">
        <EntityIcon entity="collection" size={32} />
        <span>
          <b>אין היום משהו שמחכה לך.</b>
          {view.watching > 0 ? (
            <span>
              {view.watching === 1
                ? "אני משגיחה על התחייבות אחת."
                : `אני משגיחה על ${view.watching} התחייבויות.`}
            </span>
          ) : null}
        </span>
      </Link>
    );
  }

  const [primary, ...rest] = view.objects;
  const support = rest.slice(0, 2);
  // What is left over is linked to its OWNER, not to one convenient page: the
  // Secretary holds obligations, the exception list holds everything else.
  // Sending both to /attention was the original defect — it pointed at a page
  // that does not contain an obligation.
  const overflow = rest.slice(support.length);
  const moreObligations = overflow.filter((o) => o.kind === 'obligation').length;
  const moreExceptions = overflow.length - moreObligations;

  return (
    <>
      <PrimaryObject object={primary} />
      {support.length ? (
        <ul className="sup">
          {support.map((object) => {
            const tone = toneOfEntity(object.entity);
            return (
              <li key={object.key}>
                {/* Equal priority ⇒ identical geometry; only the colour differs. */}
                <Link href={object.href} className="slip" style={{ background: tone.tint }}>
                  <span className="slip-top">
                    <EntityIcon entity={object.entity} size={20} />
                    <span className="slip-k" style={{ color: tone.ink }}>
                      {object.kindWord}
                    </span>
                  </span>
                  <span className="slip-t">{object.title}</span>
                  <span className="slip-m">
                    {object.amount ? <b>{object.amount}</b> : null}
                    {object.chip ? <span> {object.chip.label}</span> : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      {moreObligations > 0 ? (
        <Link href={HOME_ROUTES.secretaryToday} className="more">
          ועוד {moreObligations} אצל המזכירה ›
        </Link>
      ) : null}
      {moreExceptions > 0 ? (
        <Link href={HOME_ROUTES.attention} className="more">
          ועוד {moreExceptions} שדורשים תשומת לב ›
        </Link>
      ) : null}
    </>
  );
}

function PrimaryObject({ object }: { object: AttentionObject }) {
  const tone = toneOfEntity(object.entity);
  const chipTone = object.chip?.urgent ? URGENT : tone;
  return (
    <div className="stage">
      <span className="slab" style={{ background: tone.solid }} aria-hidden />
      <Link href={object.href} className={`obj${object.kind === "obligation" ? " torn" : ""}`}>
        <span className="obj-top">
          <span className="obj-kind" style={{ color: tone.ink }}>
            <EntityIcon entity={object.entity} size={22} />
            {object.kindWord}
          </span>
          {object.chip ? (
            <span className="obj-chip" style={{ background: chipTone.tint, color: chipTone.ink }}>
              {object.chip.label}
            </span>
          ) : null}
        </span>
        <span className="obj-t">{object.title}</span>
        <span className="obj-bot">
          {object.amount ? (
            <span className="amt">{object.amount}</span>
          ) : (
            <span className="obj-meta">{object.meta}</span>
          )}
          <span className="cta">לטיפול</span>
        </span>
        {object.kind === "obligation" ? <TornEdge /> : null}
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------ parts -- */

/**
 * A family: a small cluster of coloured Dubiz icons, the family name, a short
 * capability line and a way in.
 *
 * No counts. A count ("7 כלים") describes our information architecture rather
 * than what the owner gets, and it goes stale the moment a tool moves. The
 * icons carry the breadth instead, and the line names exactly those icons.
 */
function FamilyRow({ group }: { group: ToolGroup }) {
  return (
    <Link href={categoryHref(group)} className="fam">
      <span className="fam-cl" aria-hidden>
        {group.icons.map((entity) => (
          <span key={entity} className="fam-i">
            <EntityIcon entity={entity} size={24} />
          </span>
        ))}
      </span>
      <span className="fam-tx">
        <span className="fam-t">{group.label}</span>
        <span className="fam-l">{group.capabilityLine}</span>
      </span>
      <span className="chev" aria-hidden>
        ‹
      </span>
    </Link>
  );
}

/**
 * The identity choice.
 *
 * NO NEW STORAGE: the logo is the one the business already uploaded for its
 * invoices (`BusinessProfile.billingLogoDataUrl`), and which identity to show
 * is remembered per device. A schema column bought nothing here — the choice is
 * a view preference, not a business fact, and a migration for it would be a
 * permanent cost for a temporary opinion.
 */
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
    <svg viewBox="0 0 24 24" fill="none" stroke="#55605a" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.9 14.4a1.7 1.7 0 0 0 .34 1.87l.06.06a2.1 2.1 0 1 1-2.97 2.97l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55v.17a2.1 2.1 0 1 1-4.2 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2.1 2.1 0 1 1-2.97-2.97l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1.03H2.8a2.1 2.1 0 1 1 0-4.2h.09A1.7 1.7 0 0 0 4.44 8.2a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.1 2.1 0 1 1 7.01 3.3l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10.05 2.2V2.1a2.1 2.1 0 1 1 4.2 0v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2.1 2.1 0 1 1 2.97 2.97l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.55 1.03h.17a2.1 2.1 0 1 1 0 4.2h-.09a1.7 1.7 0 0 0-1.55 1.03z" />
    </svg>
  );
}

/** The torn edge that marks an obligation as a physical slip of paper. */
function TornEdge() {
  const teeth = 22;
  const points: string[] = [];
  for (let i = 0; i <= teeth; i += 1) points.push(`${(i * 100) / teeth},${i % 2 === 0 ? 1 : 7}`);
  return (
    <svg className="torn-edge" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden>
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
  --ink:#1f2a26; --ink2:#55605a; --teal:#1f4a46; --action:#2f615c;
  --paper:#f6f3ec; --white:#fffdf8; --hair:rgba(31,42,38,.12);
  direction:rtl; min-height:100dvh; color:var(--ink); background:var(--paper);
  font-family:var(--font-heebo),'Heebo',system-ui,sans-serif; -webkit-font-smoothing:antialiased;
}
.dzhome a{color:inherit;text-decoration:none;-webkit-tap-highlight-color:transparent}
.dzhome a:focus-visible,.dzhome button:focus-visible{outline:3px solid var(--action);outline-offset:3px;border-radius:12px}
.dzhome .w{max-width:480px;margin:0 auto;padding:calc(6px + var(--dz-safe-top,0px)) 20px 24px}
.dzhome .sk{display:block;border-radius:8px;background:rgba(31,42,38,.08)}

/* header: gear · identity · balance */
.dzhome .top{display:grid;grid-template-columns:44px 1fr 44px;align-items:center;height:44px}
.dzhome .gear{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;order:3}
.dzhome .gear svg{width:22px;height:22px}
.dzhome .gear.ghost{order:1}
.dzhome .ident{order:2;justify-self:center;display:flex;align-items:center;justify-content:center;min-height:44px;padding:0 10px;border:0;background:none;cursor:pointer}
.dzhome .ident-logo{max-height:26px;max-width:120px;object-fit:contain;display:block}
.dzhome .bizname{margin:0 0 10px;text-align:center;font-size:13.5px;font-weight:800;color:var(--ink2)}

/* the day */
.dzhome .day{margin-bottom:12px}
.dzhome .daynav{display:flex;align-items:center;gap:4px;margin-bottom:6px}
.dzhome .dn{width:44px;height:44px;border-radius:50%;border:0;background:none;color:rgba(31,42,38,.5);font-size:17px;font-weight:800;line-height:1;cursor:pointer}
.dzhome .dn:disabled{opacity:.3}
.dzhome .dn-t{font-size:14px;font-weight:800;min-width:84px;text-align:center}
.dzhome .dn-today{margin-inline-start:auto;min-height:44px;padding:0 12px;border:0;border-radius:999px;background:rgba(31,74,70,.1);color:var(--action);font:inherit;font-size:12.5px;font-weight:800;cursor:pointer}
.dzhome .day-l{margin:0;font-size:12.5px;font-weight:700;color:var(--ink2)}
.dzhome .day-amt{display:flex;align-items:baseline;gap:10px;margin:2px 0 4px;font-size:40px;font-weight:800;letter-spacing:-.03em;line-height:1.05;font-variant-numeric:tabular-nums}
.dzhome .day-n{font-size:13px;font-weight:700;color:var(--ink2);letter-spacing:0}
.dzhome .day-off{margin:4px 0 8px;font-size:17px;font-weight:700;color:var(--ink2)}

/* hourly buckets */
.dzhome .hg{margin-top:2px}
.dzhome .hg-bars{direction:ltr;display:flex;align-items:flex-end;gap:2px;height:60px;padding-bottom:6px;border-bottom:1.5px solid rgba(31,42,38,.18)}
.dzhome .hg-b{flex:1;min-width:0;height:4px;border-radius:3px;background:rgba(31,42,38,.09)}
.dzhome .hg-b.ahead{background:rgba(31,42,38,.045)}
.dzhome .hg-b.on{background:#1f4a46;border-radius:4px 4px 2px 2px}
.dzhome .hg.empty .hg-bars{opacity:.4}
.dzhome .hg-ax{display:flex;justify-content:space-between;margin-top:5px;font-size:10.5px;font-weight:700;color:rgba(31,42,38,.45);font-variant-numeric:tabular-nums;direction:ltr}
.dzhome .hg-none{margin:8px 0 0;font-size:13px;color:var(--ink2)}

/* financial context: the numbers first, one hairline between two groups */
.dzhome .fc{display:grid;grid-template-columns:1fr 1fr;margin-top:14px}
.dzhome .fc-g{display:flex;flex-direction:column;gap:2px;min-height:66px;padding:0 14px 2px 10px}
.dzhome .fc-g+.fc-g{border-inline-start:1px solid var(--hair)}
.dzhome .fc-g:first-child{padding-inline-start:2px}
.dzhome .fc-rule{width:26px;height:3px;border-radius:2px;margin-bottom:6px}
.dzhome .fc-n{display:flex;align-items:baseline;gap:7px;font-size:21px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.dzhome .fc-tr{font-size:13px;font-weight:800;color:#2f615c}
.dzhome .fc-tr.down{color:#9A5240}
.dzhome .fc-sub{font-size:12px;font-weight:700;color:var(--ink2)}
.dzhome .fc-l{font-size:11.5px;font-weight:600;color:var(--ink2);line-height:1.35;text-wrap:balance}

/* what else happened today: small entity objects, not a sentence */
.dzhome .act{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0 14px}
.dzhome .act-l{font-size:11.5px;font-weight:800;color:var(--ink2);margin-inline-end:2px}
.dzhome .act-o{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 13px 0 11px;border-radius:12px;font-size:13.5px;font-weight:800}

/* secretary */
.dzhome .sec{margin-bottom:20px}
.dzhome .sec-head{display:flex;align-items:center;gap:9px;margin-bottom:10px}
.dzhome .por{width:36px;height:36px;border-radius:50%;overflow:hidden;flex:0 0 auto;box-shadow:0 0 0 1.5px var(--ink)}
.dzhome .por img{width:100%;height:100%;object-fit:cover;display:block}
.dzhome .sec-name{font-size:13.5px;font-weight:800}
.dzhome .sec-ctx{font-size:12.5px;font-weight:700;color:var(--ink2)}
.dzhome .sec-rule{flex:1;height:1.5px;background:rgba(31,42,38,.25);border-radius:2px}
.dzhome .sec-quiet{margin:0;font-size:14px;color:var(--ink2)}
.dzhome .calm{display:flex;align-items:center;gap:12px;padding:2px}
.dzhome .calm span{display:flex;flex-direction:column;gap:3px}
.dzhome .calm b{font-size:17px;font-weight:800}
.dzhome .calm span span{font-size:13.5px;color:var(--ink2);font-weight:600}

.dzhome .stage{position:relative;margin:0 0 16px 12px}
.dzhome .slab{position:absolute;inset:16px -12px -12px 20px;border-radius:16px}
.dzhome .obj{position:relative;display:flex;flex-direction:column;gap:8px;padding:13px 15px 15px;background:var(--white);border:2px solid var(--ink);border-radius:12px}
.dzhome .obj.torn{border-bottom:none;border-radius:12px 12px 0 0;margin-bottom:8px}
.dzhome .sk-obj{min-height:126px}
.dzhome .torn-edge{position:absolute;left:-2px;right:-2px;bottom:-8px;width:calc(100% + 4px);height:8px}
.dzhome .obj-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dzhome .obj-kind{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:800}
.dzhome .obj-chip{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:800}
.dzhome .obj-t{font-size:18px;font-weight:800;line-height:1.25}
.dzhome .obj-bot{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin-top:2px}
.dzhome .amt{font-size:30px;font-weight:800;letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums}
.dzhome .obj-meta{font-size:14px;color:var(--ink2)}
.dzhome .cta{display:inline-flex;align-items:center;height:44px;padding:0 20px;border-radius:12px;background:var(--action);color:#fffdf8;font-size:15px;font-weight:800}

/* EQUAL PRIORITY ⇒ EQUAL GEOMETRY: one height, one padding, one radius. */
.dzhome .sup{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-items:stretch}
.dzhome .sup li{display:flex}
.dzhome .slip{flex:1;display:flex;flex-direction:column;gap:4px;height:96px;padding:11px 12px;border-radius:14px;box-sizing:border-box}
.dzhome .slip-top{display:flex;align-items:center;gap:7px}
.dzhome .slip-k{font-size:11.5px;font-weight:800}
.dzhome .slip-t{font-size:13.5px;font-weight:800;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.dzhome .slip-m{font-size:12.5px;font-weight:600;margin-top:auto}
.dzhome .slip-m b{font-weight:800}
.dzhome .more{display:inline-flex;align-items:center;min-height:44px;margin-top:2px;font-size:13.5px;font-weight:700;color:var(--action)}

/* families — quiet, and clear of the accessibility button */
.dzhome .dz{padding-inline-end:62px}
.dzhome .dz h2{margin:0 2px 2px;font-size:12px;font-weight:800;color:var(--ink2)}
.dzhome .dz ul{list-style:none;margin:0;padding:0}
.dzhome .dz li+li{border-top:1px solid var(--hair)}
.dzhome .fam{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:13px;min-height:62px;padding:7px 2px}
.dzhome .fam-cl{display:flex;align-items:center}
.dzhome .fam-i{display:flex;margin-inline-start:-8px;padding:2px;border-radius:50%;background:var(--paper)}
.dzhome .fam-i:first-child{margin-inline-start:0}
.dzhome .fam-tx{display:flex;flex-direction:column;gap:1px;min-width:0}
.dzhome .fam-t{font-size:15px;font-weight:800}
.dzhome .fam-l{font-size:12.5px;font-weight:600;color:var(--ink2)}
.dzhome .chev{font-size:18px;color:rgba(31,42,38,.35);line-height:1}

/* identity sheet */
.dzhome .sheet{position:fixed;inset:0;z-index:160;background:rgba(31,42,38,.35);display:flex;align-items:flex-end}
.dzhome .sheet-in{width:100%;max-width:480px;margin:0 auto;background:var(--white);border-radius:22px 22px 0 0;padding:18px 18px calc(22px + var(--dz-safe-bottom,0px));display:flex;flex-direction:column;gap:8px}
.dzhome .sheet-t{margin:0 0 4px;font-size:15px;font-weight:800}
.dzhome .sheet-o{display:flex;align-items:center;gap:10px;min-height:52px;padding:0 14px;border:1.5px solid var(--hair);border-radius:14px;background:var(--paper);font:inherit;font-size:14.5px;font-weight:700;cursor:pointer;text-align:start}
.dzhome .sheet-o.on{border-color:var(--action);box-shadow:inset 0 0 0 1px var(--action)}
.dzhome .sheet-note{margin:0;padding:0 4px;font-size:13px;color:var(--ink2)}
.dzhome .sheet-link{color:var(--action)}
.dzhome .sheet-x{min-height:48px;border:0;background:none;font:inherit;font-size:14px;font-weight:800;color:var(--ink2);cursor:pointer}

@media (min-width:768px){
  .dzhome .w{max-width:620px}
}
`;
