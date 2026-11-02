"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";

import BackButton from "@/components/ui/back-button";
import { EntityIcon } from "@/components/ui/entity/entity-icon";
import { ComingSoonPill } from "@/components/ui/coming-soon/ComingSoonPill";
import { categoryToneCss } from "@/features/tools/category-tones";
import { getClientAuthToken, redirectToLogin } from "@/lib/client-session";
import { IMPORT_EXPORT_RELEASED, IMPORT_EXPORT_ROUTE } from "@/components/settings/import-export/import-export-release";
import type { AttentionItem, BankMode, HistoryEntry, UploadsOverview } from "@/lib/money-uploads/uploads-overview";

/**
 * העלאת דוחות וקבצים — /money/uploads (S1-B M3), a tool of the money family.
 *
 * A work screen with one job: "what do I bring in, and where". It is NOT an upload mechanism. Every card opens
 * the screen that already does the work (bank statement, documents, import); the history and "דורש טיפול" are
 * read-only and come from GET /api/money/uploads. Hebrew only (owner rule for new screens).
 *
 * Stages, from server state:
 *   loading   cards visible, the bank card a skeleton (its route is the server's decision, never a guess)
 *   signed-out the read answered 401 (no session on this address) — said so, with the way to sign in; the bank
 *             card has no link, because its route is the server's decision and the server did not answer
 *   error     cards still usable; the bank card says it could not check, with a retry
 *   partial   the history could not be read (historyAvailable: false) — said so with a retry; the bank card
 *             still follows the server's flag decision
 *   empty     no upload yet → the cards are the next step, the bank card first
 *   ready     attention (when any) above the cards, recent uploads below
 */

type Load =
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "error" }
  | { state: "ready"; data: UploadsOverview };

export function UploadsScreen() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  // A retry shows the loading state again (set here, in the event, not inside the effect).
  const retry = useCallback(() => {
    setLoad({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const token = getClientAuthToken();
    fetch("/api/money/uploads", {
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (res) => {
        // 401 is not a failure to read: there is no session on this address. Say so instead of "could not check".
        if (res.status === 401) {
          if (!cancelled) setLoad({ state: "signed-out" });
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as UploadsOverview;
        if (!cancelled) setLoad({ state: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Absent (an older server answer) reads as OFF: only the server's explicit ON opens a card.
  const revenueCards =
    load.state === "ready" && load.data.revenueReports ? load.data.revenueReports : { z: false, settlement: false };

  const bankMode: BankCardMode =
    load.state === "ready"
      ? load.data.bank.mode
      : load.state === "error"
        ? "unknown"
        : load.state === "signed-out"
          ? "signed-out"
          : null;

  return (
    <main data-page-intent="content" className="dzup tone-money" dir="rtl">
      <style>{categoryToneCss(".dzup")}</style>
      <style>{UPLOADS_CSS}</style>

      <div className="uwrap">
        <div className="uback">
          <BackButton />
        </div>

        <header className="uhead">
          <span className="uhead-ic" aria-hidden>
            <EntityIcon entity="upload" size={28} />
          </span>
          <div>
            <h1>העלאת דוחות וקבצים</h1>
            <p>דפי בנק, דוחות מהקופה ומסמכים — בוחרים מה להעלות, וכל קובץ נקלט במסך שמטפל בו.</p>
          </div>
        </header>

        {load.state === "signed-out" ? (
          <div className="uerr" role="alert">
            <span>צריך להתחבר כדי לראות את ההעלאות ואיך להעלות דף בנק לעסק.</span>
            <button type="button" className="ubtn" onClick={redirectToLogin}>
              להתחברות
            </button>
          </div>
        ) : null}

        {load.state === "error" || (load.state === "ready" && !load.data.historyAvailable) ? (
          <div className="uerr" role="alert">
            <span>
              {load.state === "error"
                ? "לא הצלחנו לטעון את ההעלאות האחרונות."
                : "לא הצלחנו לטעון את ההעלאות האחרונות ומה שדורש טיפול. אפשר להמשיך להעלות מהכרטיסים."}
            </span>
            <button type="button" className="ubtn" onClick={retry}>
              לנסות שוב
            </button>
          </div>
        ) : null}

        {load.state === "ready" && load.data.attention.length > 0 ? (
          <AttentionSection items={load.data.attention} />
        ) : null}

        <section aria-labelledby="up-what">
          <h2 className="ulabel" id="up-what">
            מה להעלות
          </h2>
          <ul className="ucards">
            <li>
              {/* When the whole read failed, the banner above carries the one retry. */}
              <BankCard mode={bankMode} onRetry={load.state === "ready" ? retry : undefined} />
            </li>
            {/* Z / settlement: a link only when the server says the feature is ON for this business; otherwise —
                OFF, unknown, still loading, signed out — the inactive "בקרוב" card, never a guessed link. */}
            <li>
              {revenueCards.z ? (
                <LinkCard
                  href="/money/revenue-reports/z/upload"
                  entity="invoice"
                  name="דוח Z מהקופה"
                  desc="סיכום יומי מהקופה הרושמת · בדיקה לפני קליטה · הקובץ עצמו לא נשמר"
                />
              ) : (
                <SoonCard entity="invoice" name="דוח Z מהקופה" desc="סיכום יומי מהקופה הרושמת" />
              )}
            </li>
            <li>
              {revenueCards.settlement ? (
                <LinkCard
                  href="/money/revenue-reports/settlement/upload"
                  entity="payment-request"
                  name="דוח סליקה"
                  desc="דוח מחברת האשראי על הזיכויים והעמלות · בדיקה לפני קליטה · הקובץ עצמו לא נשמר"
                />
              ) : (
                <SoonCard entity="payment-request" name="דוח סליקה" desc="דוח מחברת האשראי על העסקאות והעמלות" />
              )}
            </li>
            {revenueCards.z || revenueCards.settlement ? (
              <li>
                <LinkCard
                  href="/money/revenue-reports"
                  entity="collection"
                  name="סגירות קופה ודוחות סליקה"
                  desc="מה שנקלט מדוחות Z ומדוחות סליקה · דוחות, לא רישומי הכנסה"
                />
              </li>
            ) : null}
            <li>
              <LinkCard
                href="/documents/upload"
                entity="documents"
                name="חשבוניות וקבלות"
                desc="PDF או תמונה · נקלטים למסמכים של העסק"
              />
            </li>
            {IMPORT_EXPORT_RELEASED ? (
              <li>
                <LinkCard
                  href={IMPORT_EXPORT_ROUTE}
                  entity="connections"
                  name="נתונים והיסטוריה ממערכת אחרת"
                  desc="לקוחות, ספקים, מלאי ומסמכים מהמערכת הקודמת"
                />
              </li>
            ) : null}
          </ul>
        </section>

        <section aria-labelledby="up-recent" className="urecent">
          <h2 className="ulabel" id="up-recent">
            העלאות אחרונות
          </h2>
          <RecentUploads load={load} />
        </section>
      </div>
    </main>
  );
}

/* ─────────────────────────────── attention ─────────────────────────────── */

function AttentionSection({ items }: { items: AttentionItem[] }) {
  return (
    <section aria-labelledby="up-attn" className="uattn">
      <h2 className="ulabel" id="up-attn">
        דורש טיפול
      </h2>
      <ul>
        {items.map((item) => (
          <li key={item.id} className={`uattn-row uattn-${item.kind}`}>
            <span className="uattn-tx">
              <span className="uattn-title">{item.title}</span>
              <span className="uattn-detail">{item.detail}</span>
            </span>
            {item.kind === "action" && item.action ? (
              <Link href={item.action.href} className="ubtn ubtn-primary">
                {item.action.label}
              </Link>
            ) : (
              <span className="uattn-tag">לידיעה</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ──────────────────────────────── cards ──────────────────────────────── */

function CardBody({ entity, name, desc, end }: { entity: string; name: string; desc: ReactNode; end: ReactNode }) {
  return (
    <>
      <span className="ucard-ic" aria-hidden>
        <EntityIcon entity={entity} size={26} />
      </span>
      <span className="ucard-tx">
        <span className="ucard-name">{name}</span>
        <span className="ucard-desc">{desc}</span>
      </span>
      {end}
    </>
  );
}

const Chevron = () => (
  <span className="ucard-chev" aria-hidden>
    ‹
  </span>
);

function LinkCard({ href, entity, name, desc }: { href: string; entity: string; name: string; desc: string }) {
  return (
    <Link href={href} className="ucard">
      <CardBody entity={entity} name={name} desc={desc} end={<Chevron />} />
    </Link>
  );
}

/** Not open yet: visible, inactive, no link and no upload. */
function SoonCard({ entity, name, desc }: { entity: string; name: string; desc: string }) {
  return (
    <div className="ucard ucard-soon" aria-disabled="true">
      <CardBody entity={entity} name={name} desc={desc} end={<ComingSoonPill />} />
    </div>
  );
}

/**
 * The bank statement card. Where it leads is the server's decision (bank_file_import ON / OFF / unknown) —
 * while that is loading the card holds a skeleton, and when it cannot be known there is no link at all: the
 * old upload refuses in that state too, so a link would only lead to an error. Never "בקרוב".
 */
type BankCardMode = BankMode | "signed-out" | null;

function BankCard({ mode, onRetry }: { mode: BankCardMode; onRetry?: () => void }) {
  const name = "דף חשבון בנק";
  if (mode === "legacy") {
    return (
      <Link href="/payables/bank" className="ucard ucard-main" data-bank-mode="legacy">
        <CardBody
          entity="upload"
          name={name}
          desc="קובץ CSV מהבנק · בלי תצוגה מקדימה לפני קליטה · הקובץ עצמו לא נשמר"
          end={<Chevron />}
        />
      </Link>
    );
  }
  if (mode === "b1") {
    return (
      <Link href="/payables/bank/import" className="ucard ucard-main" data-bank-mode="b1">
        <CardBody
          entity="upload"
          name={name}
          desc="CSV או Excel · בדיקה לפני קליטה · הקובץ עצמו לא נשמר"
          end={<Chevron />}
        />
      </Link>
    );
  }
  if (mode === "signed-out") {
    return (
      <div className="ucard ucard-main" data-bank-mode="signed-out">
        <CardBody entity="upload" name={name} desc="יש להתחבר כדי לראות איך להעלות דף בנק לעסק." end={<span />} />
      </div>
    );
  }
  if (mode === "unknown") {
    return (
      <div className="ucard ucard-main ucard-unknown" data-bank-mode="unknown">
        <CardBody
          entity="upload"
          name={name}
          desc="לא הצלחנו לבדוק כרגע איך להעלות דף בנק לעסק."
          end={
            onRetry ? (
              <button type="button" className="ubtn" onClick={onRetry}>
                לבדוק שוב
              </button>
            ) : (
              <span />
            )
          }
        />
      </div>
    );
  }
  return (
    <div className="ucard ucard-main" aria-busy="true" data-bank-mode="loading">
      <CardBody entity="upload" name={name} desc={<span className="usk usk-line" />} end={<span />} />
    </div>
  );
}

/* ─────────────────────────────── history ─────────────────────────────── */

const dateFmt = new Intl.DateTimeFormat("he-IL", {
  day: "numeric",
  month: "numeric",
  year: "numeric",
  timeZone: "Asia/Jerusalem",
});
const timeFmt = new Intl.DateTimeFormat("he-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });

function whenText(iso: string): string {
  const d = new Date(iso);
  return `${dateFmt.format(d)} · ${timeFmt.format(d)}`;
}

/** "2026-09-01" → "1.9.2026" — a transaction date, no time zone involved. */
function dayText(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d}.${m}.${y}`;
}

function countsText(e: HistoryEntry): string {
  if (e.source === "legacy_bank_upload") {
    const n = e.counts.created ?? 0;
    return n === 1 ? "שורה חדשה אחת" : `${n} שורות חדשות`;
  }
  const { total, created, skipped, failed } = e.counts;
  if (created == null) return total === 1 ? "שורה אחת בקובץ" : `${total ?? 0} שורות בקובץ`;
  const parts = [`${created} נקלטו`];
  if (skipped) parts.push(`${skipped} דולגו`);
  if (failed) parts.push(`${failed} לא נקלטו`);
  return parts.join(" · ");
}

const STATUS_TONE: Record<HistoryEntry["status"], string> = {
  COMPLETED: "ok",
  RECORDED: "ok",
  PARTIAL: "warn",
  FAILED: "bad",
  EXECUTING: "info",
};

function RecentUploads({ load }: { load: Load }) {
  if (load.state === "loading") {
    return (
      <ul className="uhist" aria-busy="true" aria-label="טוען">
        {[0, 1, 2].map((i) => (
          <li key={i} className="uhist-row">
            <span className="usk usk-line" />
            <span className="usk usk-short" />
          </li>
        ))}
      </ul>
    );
  }
  // A history that could not be read is said so — never shown as "nothing uploaded yet".
  if (load.state === "signed-out") {
    return <p className="uempty">ההעלאות האחרונות יוצגו אחרי התחברות.</p>;
  }
  if (load.state === "error" || !load.data.historyAvailable) {
    return <p className="uempty">ההעלאות האחרונות לא נטענו. אפשר להמשיך להעלות מהכרטיסים למעלה.</p>;
  }
  const entries = load.data.history;
  if (entries.length === 0) {
    return (
      <p className="uempty">
        עוד לא הועלו דוחות. כדאי להתחיל מדף חשבון הבנק — ההעלאות יופיעו כאן.
      </p>
    );
  }
  return (
    <ul className="uhist">
      {entries.map((e) => (
        <li key={e.id} className="uhist-row" data-source={e.source}>
          <div className="uhist-top">
            <span className="uhist-type">{e.typeLabel}</span>
            <span className={`upill upill-${STATUS_TONE[e.status]}`}>{e.statusLabel}</span>
          </div>
          <div className="uhist-meta">
            <span>{whenText(e.at)}</span>
            <span aria-hidden>·</span>
            <span>{countsText(e)}</span>
          </div>
          {e.period || e.account || e.legacyPath ? (
            <div className="uhist-meta">
              {e.period ? (
                <span>
                  תנועות מ־{dayText(e.period.from)} עד {dayText(e.period.to)}
                </span>
              ) : null}
              {e.account ? (
                <span>
                  {e.account.label} <bdi dir="ltr">••••{e.account.last4}</bdi>
                </span>
              ) : null}
              {e.legacyPath ? <span>דרך ההעלאה הישנה במסך תנועות הבנק</span> : null}
            </div>
          ) : null}
          {!e.sourceFileStored ? <div className="uhist-note">קובץ המקור לא נשמר בדוביז</div> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Scoped styles. The family tone comes from category-tones.ts (the colour the owner tapped on Home and on
 * /tools/money); everything else is a Mist token. The card rows follow the family screen's rows.
 */
const UPLOADS_CSS = `
.dzup{
  min-height:100dvh;color:var(--dz-text-primary);
  font-family:var(--font-heebo),'Heebo','Assistant',system-ui,sans-serif;
  background:var(--dz-background);
  padding:calc(12px + var(--dz-safe-top,0px)) 16px 32px;
  -webkit-font-smoothing:antialiased;
}
.dzup .uwrap{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:22px}
.dzup a{text-decoration:none;color:inherit;-webkit-tap-highlight-color:transparent}
.dzup .uback{display:flex;justify-content:flex-start;margin-bottom:-8px}

.dzup .uhead{display:flex;align-items:flex-start;gap:14px}
.dzup .uhead-ic{flex:0 0 auto;width:52px;height:52px;border-radius:16px;display:flex;align-items:center;justify-content:center;
  background:var(--ct-tint)}
.dzup .uhead h1{margin:0;font-family:var(--font-rubik),'Rubik',sans-serif;font-size:22px;font-weight:700;line-height:1.25;letter-spacing:-.01em}
.dzup .uhead p{margin:4px 0 0;font-size:13.5px;font-weight:500;line-height:1.5;color:var(--dz-text-secondary);text-wrap:balance}

.dzup .ulabel{margin:0 4px 10px;font-size:13px;font-weight:700;color:var(--dz-text-secondary)}

.dzup .ubtn{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 14px;border-radius:12px;
  font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;white-space:nowrap;
  color:var(--dz-action-secondary-text);background:var(--dz-action-secondary-bg);border:1px solid var(--dz-action-secondary-border)}
.dzup .ubtn:hover{background:var(--dz-action-secondary-hover)}
.dzup .ubtn-primary{color:var(--dz-action-primary-text);background:var(--dz-action-primary);border-color:transparent}
.dzup .ubtn-primary:hover{background:var(--dz-action-primary-hover)}
.dzup .ubtn:focus-visible,.dzup .ucard:focus-visible{outline:3px solid var(--ct-a);outline-offset:-3px}

.dzup .uerr{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-radius:16px;
  font-size:14px;font-weight:600;color:var(--dz-danger);background:var(--dz-danger-bg-soft);border:1px solid var(--dz-danger-border)}

/* דורש טיפול: actions first, then information; each row says which it is. */
.dzup .uattn ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.dzup .uattn-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-radius:18px;
  background:var(--dz-surface);border:1px solid var(--dz-border);box-shadow:var(--dz-shadow-card)}
.dzup .uattn-action{border-color:var(--dz-warning-border);background:var(--dz-warning-bg-soft)}
.dzup .uattn-tx{min-width:0;display:flex;flex-direction:column;gap:3px}
.dzup .uattn-title{font-size:14.5px;font-weight:700;line-height:1.35}
.dzup .uattn-detail{font-size:13px;line-height:1.45;color:var(--dz-text-secondary)}
.dzup .uattn-tag{flex:0 0 auto;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;
  color:var(--dz-info);background:var(--dz-info-bg-soft)}

/* מה להעלות: one grouped surface, one row per kind of file — like the family screen. */
.dzup .ucards{list-style:none;margin:0;padding:4px 0;border-radius:22px;overflow:hidden;
  background:var(--dz-surface);border:1px solid var(--dz-border);box-shadow:var(--dz-shadow-card)}
.dzup .ucards li+li{position:relative}
.dzup .ucards li+li::before{content:"";position:absolute;top:0;inset-inline-start:78px;inset-inline-end:18px;height:1px;background:var(--dz-border)}
.dzup .ucard{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;column-gap:14px;
  min-height:80px;padding-block:15px;padding-inline:18px 14px;transition:background .14s ease}
.dzup a.ucard:active{background:var(--dz-control-hover)}
@media (hover:hover){.dzup a.ucard:hover{background:var(--dz-control-hover)}}
.dzup .ucard-soon{opacity:.6;cursor:not-allowed}
.dzup .ucard-ic{width:50px;height:50px;border-radius:15px;display:flex;align-items:center;justify-content:center;background:var(--ct-tint)}
.dzup .ucard-main .ucard-name{color:var(--ct-deep)}
.dzup .ucard-tx{min-width:0;display:flex;flex-direction:column;gap:3px}
.dzup .ucard-name{font-size:16.5px;font-weight:700;line-height:1.3}
.dzup .ucard-desc{font-size:13px;font-weight:500;line-height:1.45;color:var(--dz-text-secondary);text-wrap:balance}
.dzup .ucard-unknown .ucard-desc{color:var(--dz-danger)}
.dzup .ucard-chev{width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:22px;line-height:1;color:var(--dz-text-muted)}

/* העלאות אחרונות: read-only rows, no links (there is no detail screen to open). */
.dzup .uhist{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.dzup .uhist-row{display:flex;flex-direction:column;gap:5px;padding:14px 16px;border-radius:18px;
  background:var(--dz-surface);border:1px solid var(--dz-border)}
.dzup .uhist-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dzup .uhist-type{font-size:15px;font-weight:700}
.dzup .uhist-meta{display:flex;flex-wrap:wrap;gap:4px 8px;font-size:13px;line-height:1.45;color:var(--dz-text-secondary)}
.dzup .uhist-note{font-size:12px;color:var(--dz-text-muted)}
.dzup .upill{flex:0 0 auto;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;line-height:1.5}
.dzup .upill-ok{color:var(--dz-success);background:var(--dz-success-bg-soft)}
.dzup .upill-warn{color:var(--dz-warning);background:var(--dz-warning-bg-soft)}
.dzup .upill-bad{color:var(--dz-danger);background:var(--dz-danger-bg-soft)}
.dzup .upill-info{color:var(--dz-info);background:var(--dz-info-bg-soft)}
.dzup .uempty{margin:0;padding:18px 16px;border-radius:18px;font-size:14px;line-height:1.5;color:var(--dz-text-secondary);
  background:var(--dz-surface);border:1px dashed var(--dz-border-strong)}

.dzup .usk{display:block;border-radius:8px;background:var(--dz-surface-muted)}
.dzup .usk-line{width:70%;height:14px}
.dzup .usk-short{width:40%;height:12px}

@media (min-width:768px){
  .dzup .uwrap{max-width:720px}
  .dzup .ucards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0;
    background:none;border:0;box-shadow:none;border-radius:0;overflow:visible}
  .dzup .ucards li+li::before{display:none}
  .dzup .ucard{height:100%;border-radius:20px;background:var(--dz-surface);border:1px solid var(--dz-border);box-shadow:var(--dz-shadow-card)}
}
@media (min-width:1024px){
  .dzup{padding:calc(12px + var(--dz-safe-top,0px)) 32px 32px}
  .dzup .uwrap{max-width:960px}
  .dzup .ucards{grid-template-columns:repeat(3,minmax(0,1fr))}
  .dzup .ucards li:first-child{grid-column:span 2}
}
`;
