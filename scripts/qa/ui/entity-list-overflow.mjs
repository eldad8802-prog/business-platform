/**
 * Entity-list overflow harness — Customers / Leads / Suppliers / Inventory.
 *
 * WHY A BROWSER. The defect is a LAYOUT fact, not a source fact: on a
 * non-replaced inline box `overflow: hidden` and `text-overflow: ellipsis` are
 * silently ignored while `white-space: nowrap` still applies, so the declared
 * truncation never happened and the line ran out of the card. Nothing short of
 * real layout can tell you that.
 *
 * WHY IT DOES NOT TRUST THE SCROLLBAR. The app ships `body { overflow-x: hidden }`,
 * which means overflowing content produces NO horizontal scrollbar — it is
 * clipped instead, and in an RTL surface it is clipped off the LEFT edge. So
 * "there is no scrollbar" proves nothing at all. This harness therefore measures
 * BOXES: every piece of text must have its rectangle inside its own card's
 * content box, and every card inside the viewport. The scrollbar is checked too,
 * but only as a secondary signal, and with `overflow-x` left at its default so
 * the check can actually fail.
 *
 * WHAT IT RENDERS. The real stylesheets, read from disk, plus markup that
 * mirrors what the components emit. The colour theme is a geometry-neutral stub:
 * palette cannot move a box, and pulling the TS theme in would buy nothing.
 *
 *   node scripts/qa/ui/entity-list-overflow.mjs [--repo <dir>] [--markup legacy|current] [--json <file>]
 *
 * `--markup legacy` reproduces the pre-fix component output, so the same harness
 * can be pointed at the pre-fix stylesheets to show the defect rather than
 * asserting it existed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const REPO = path.resolve(argOf("--repo", process.cwd()));
const MARKUP = argOf("--markup", "current");
const JSON_OUT = argOf("--json", null);
// Geometry alone cannot say whether the result is READABLE. `--shots <dir>`
// writes a full-page capture per width so the layout can be looked at, which is
// the only way to tell "inside the card" from "inside the card and legible".
const SHOTS = argOf("--shots", null);
if (!["legacy", "current"].includes(MARKUP)) {
  console.error(`--markup must be "legacy" or "current" (got "${MARKUP}")`);
  process.exit(2);
}

const read = (p) => readFileSync(path.join(REPO, p), "utf8");
/** Pull the template literal out of a `export const X = \`…\`` CSS-in-TS module. */
const cssFromTs = (p) => {
  const src = read(p);
  const m = /=\s*`([\s\S]*)`;?\s*$/.exec(src.trim());
  if (!m) throw new Error(`no template literal found in ${p}`);
  return m[1];
};

const CRM_CSS = read("app/(shell)/customers/crm.css");
const INV_PRIMITIVES_CSS = cssFromTs("components/inventory/inventory-primitives.css.ts");
const INV_ITEMS_CSS = cssFromTs("components/inventory/inventory-items-list.css.ts");

// Geometry-neutral stand-ins for the CRM/inventory custom properties. Only the
// ones that can affect layout are given real values (weights, radii, spacing);
// colours are placeholders so a box is visible in a trace.
const THEME_STUB = `
:root, .crm-scope, [data-inventory-module], [data-inventory-items-list] {
  --crm-canvas:#faf8f4; --crm-card:#ffffff; --crm-surface2:#f1efe9;
  --crm-ink:#1c1a17; --crm-muted:#6b6660; --crm-tertiary:#9b968e;
  --crm-line:#e3ded4; --crm-accent:#1f7a6f; --crm-accent-grad:#1f7a6f;
  --crm-accent-grad-hover:#1a685f; --crm-on-accent:#ffffff;
  --crm-selection-bg:#eaf3f1; --crm-selection-text:#14544c; --crm-selection-border:#9cc7c0;
  --crm-success:#246b46; --crm-success-bg:#e6f2ea;
  --crm-warning:#8a5a12; --crm-warning-ink:#6f4a10; --crm-warning-bg:#fbf1dd;
  --crm-error:#9b2c2c; --crm-error-bg:#fbeaea; --crm-info:#1e5f8a; --crm-info-ink:#194c6e; --crm-info-bg:#e7f1f7;
  --crm-backdrop:rgba(0,0,0,.4); --crm-ring:rgba(31,122,111,.25);
  --crm-radius-card:14px; --crm-radius-button:12px; --crm-radius-field:10px;
  --crm-radius-pill:999px; --crm-radius-dialog:18px;
  --crm-shadow-card:0 1px 2px rgba(0,0,0,.05); --crm-shadow-card-hover:0 2px 6px rgba(0,0,0,.08);
  --crm-shadow-overlay:0 8px 30px rgba(0,0,0,.2); --crm-shadow-glow:0 1px 2px rgba(0,0,0,.08);
  --crm-w-medium:500; --crm-w-semibold:600;
  --dz-action-primary-active:#17564f; --dz-focus-ring-width:2px;
  --dz-focus-ring-color:#1f7a6f; --dz-focus-ring-offset:2px;
  --inv-text:#1c1a17; --inv-text-muted:#6b6660; --inv-text-tertiary:#9b968e;
  --inv-muted:#6b6660; --inv-dim:#9b968e; --inv-border:#e3ded4; --inv-border-soft:#efece5;
  --inv-surface:#ffffff; --inv-surface-2:#f1efe9; --inv-card-bg:#ffffff;
  --inv-primary:#1f7a6f; --inv-on-accent:#ffffff; --inv-radius-md:12px; --inv-radius-lg:16px;
  --inv-success:#246b46; --inv-success-bg:#e6f2ea; --inv-success-border:#bcd9c8;
  --inv-danger:#9b2c2c; --inv-danger-bg:#fbeaea; --inv-danger-border:#e6bcbc;
  --inv-warning:#8a5a12; --inv-warning-ink:#6f4a10; --inv-warning-bg:#fbf1dd; --inv-warning-border:#e6d2a8;
  --inv-content-max:720px; --inv-mono:ui-monospace,monospace;
  --dz-text-primary:#1c1a17; --dz-text-secondary:#6b6660; --dz-text-muted:#9b968e;
  --dz-border:#e3ded4; --dz-surface:#ffffff; --dz-surface-muted:#f1efe9;
}
/* Deliberately NOT \`body{overflow-x:hidden}\`: the app hides the symptom, and a
   harness that hides it too can only ever report a false PASS. */
html, body { margin: 0; padding: 0; }
body { font-family: "Heebo", "Segoe UI", system-ui, sans-serif; font-size: 14px; }
`;

// ----------------------------------------------------------------- fixtures

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Hostile but realistic records. Every one of these is a case the brief names:
 * very long names, Hebrew+Latin+digits in one record, long emails, phones,
 * city/address, missing values, long product names, statuses, and the long
 * QA/SYNTHETIC strings that seeded data actually carries.
 */
const PEOPLE = [
  {
    id: "long-hebrew",
    label: "שם עברי ארוך מאוד",
    name: "מרכז השיווק והפצת מוצרי הבנייה והתשתיות בע״מ סניף ראשי דרום",
    phone: "050-123-4567",
    email: "mercaz.hashivuk.vehafatzat@binyan-vetashtiyot-darom.co.il",
    city: "באר שבע",
    active: true,
  },
  {
    id: "mixed",
    label: "עברית + אנגלית + מספרים",
    name: "Globex Industries גלובקס תעשיות 2024 LTD",
    phone: "03-765-4321",
    email: "accounts.payable+invoices@globex-industries-international.com",
    city: "Tel Aviv תל אביב",
    active: true,
  },
  {
    id: "unbroken",
    label: "מחרוזת אחת בלי רווחים",
    name: "QASYNTHETICCUSTOMERRECORD00000000000000000000000000000000000000001",
    phone: "+1-415-555-0100",
    email: "qa.synthetic.fixture.address.000000000000001@qa-synthetic-tenant.example",
    city: "QASYNTHETICCITYNAMEWITHNOSPACES0000001",
    active: false,
  },
  {
    id: "sparse",
    label: "ערכים חסרים",
    name: "דנה",
    phone: null,
    email: null,
    city: null,
    active: true,
  },
  {
    id: "phone-only",
    label: "טלפון בלבד (RTL/LTR)",
    name: "ספק ללא פרטים",
    phone: "052-987-6543",
    email: null,
    city: null,
    active: true,
  },
];

const PRODUCTS = [
  {
    id: "long-product",
    label: "שם מוצר ארוך + מק״ט",
    name: "מסנן שמן מקורי לרכב מסחרי כבד דגם 2019-2024 כולל אטם וברגים תוצרת גרמניה",
    meta: "מק״ט OEM-45-9920-XL-REV3 · ברקוד 7290001234567 · מינימום 12 · במלאי 4",
    qty: 4,
    price: "₪1,249.90",
    tone: "critical",
  },
  {
    id: "product-unbroken",
    label: "מק״ט ללא רווחים",
    name: "QASYNTHETICPRODUCT000000000000000000000000000000000001",
    meta: "מק״ט QASYNTHETICSKU0000000000000000000001 · במלאי 0",
    qty: 0,
    price: "ללא מחיר",
    tone: "low",
  },
  {
    id: "product-plain",
    label: "מוצר רגיל",
    name: "דבק מגע 500 מ״ל",
    meta: "מינימום 10 · במלאי 42",
    qty: 42,
    price: "₪38",
    tone: "ok",
  },
];

// ------------------------------------------------------------------- markup
// Mirrors what the components render. `legacy` is the pre-fix shape, kept so the
// same harness can demonstrate the defect against the pre-fix stylesheets.

function crmRow(p) {
  const initials = p.name.trim().slice(0, 2);
  // legacy: the badge sat INSIDE the name. Kept so the harness can show what the
  // two-line clamp would have done to it (see the badge-clipped-away check).
  const legacyBadge = p.active
    ? ""
    : `<span class="crm-badge" style="margin-inline-start:8px;vertical-align:middle">לא פעיל</span>`;
  const badgeRow =
    p.active || MARKUP === "legacy"
      ? ""
      : `<span class="crm-row__badges"><span class="crm-badge">לא פעיל</span></span>`;
  const values = [p.phone, p.email, p.city].filter((v) => v && v.trim());

  const meta =
    MARKUP === "legacy"
      ? values.length
        ? `<span class="crm-row__meta">${esc(values.join(" · "))}</span>`
        : ""
      : values.length
        ? `<span class="crm-row__meta">${values
            .map((v) => `<span class="crm-row__meta-part">${esc(v)}</span>`)
            .join("")}</span>`
        : "";

  const name =
    MARKUP === "legacy"
      ? `<span class="crm-row__name">${esc(p.name)}${legacyBadge}</span>`
      : `<span class="crm-row__name"><bdi>${esc(p.name)}</bdi></span>`;

  return `<a class="crm-row" href="#" data-fixture="${p.id}">
    <span class="crm-row__avatar" aria-hidden>${esc(initials)}</span>
    <span class="crm-row__body">${name}${badgeRow}${meta}</span>
    <span class="crm-row__chevron" aria-hidden>‹</span>
  </a>`;
}

/** The Leads row adds badges and up to three meta lines. */
function leadRow(p) {
  const initials = p.name.trim().slice(0, 2);
  const values = [p.phone, "וואטסאפ", "פעילות אחרונה לפני 3 ימים"].filter(Boolean);
  const line = (cls, text) =>
    MARKUP === "legacy"
      ? `<span class="crm-row__meta" ${cls}>${esc(text)}</span>`
      : `<span class="crm-row__meta" ${cls}><span class="crm-row__meta-part">${esc(text)}</span></span>`;

  const meta =
    MARKUP === "legacy"
      ? `<span class="crm-row__meta">${esc(values.join(" · "))}</span>`
      : `<span class="crm-row__meta">${values
          .map((v) => `<span class="crm-row__meta-part">${esc(v)}</span>`)
          .join("")}</span>`;

  return `<a class="crm-row" href="#" data-fixture="lead-${p.id}">
    <span class="crm-row__avatar" aria-hidden>${esc(initials)}</span>
    <span class="crm-row__body">
      <span class="crm-row__name">${MARKUP === "legacy" ? esc(p.name) : `<bdi>${esc(p.name)}</bdi>`}</span>
      <span style="display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 2px">
        <span class="crm-badge">בטיפול</span><span class="crm-badge">מעקב עבר את הזמן</span>
      </span>
      ${line('style="color:var(--crm-ink);font-weight:600"', "🔥 חם · ממתין 18 דק׳")}
      ${line("", "3 הודעות ללא מענה · השיחה נראית משא ומתן")}
      ${meta}
    </span>
    <span class="crm-row__chevron" aria-hidden>‹</span>
  </a>`;
}

/** The detail card: head + identity grid + a section of items. */
function crmCard(p) {
  const fields = [
    ["טלפון", p.phone],
    ["אימייל", p.email],
    ["עיר", p.city],
    ["מספר עוסק / ח.פ.", "514123456"],
  ].filter(([, v]) => v && String(v).trim());

  const head =
    MARKUP === "legacy"
      ? `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
           <h1 class="crm-id__name">${esc(p.name)}</h1>
           <div style="display:flex;gap:8px;flex-shrink:0">
             <button class="crm-btn crm-btn--ghost">עריכה</button>
             <button class="crm-btn crm-btn--ghost">השבת לקוח</button>
           </div>
         </div>`
      : `<div class="crm-id__head">
           <h1 class="crm-id__name"><bdi>${esc(p.name)}</bdi></h1>
           <div class="crm-id__actions">
             <button class="crm-btn crm-btn--ghost">עריכה</button>
             <button class="crm-btn crm-btn--ghost">השבת לקוח</button>
           </div>
         </div>`;

  const value = (v) => (MARKUP === "legacy" ? esc(v) : `<bdi>${esc(v)}</bdi>`);

  return `<div class="crm-page crm-reading" data-fixture="card-${p.id}">
    <div class="crm-id">
      ${head}
      <div class="crm-id__grid">
        ${fields
          .map(
            ([l, v]) =>
              `<div class="crm-id__field"><div class="crm-id__label">${esc(l)}</div><div class="crm-id__value">${value(v)}</div></div>`,
          )
          .join("")}
      </div>
      <div class="crm-chips">
        <span class="crm-badge crm-badge--success">פעיל</span>
        <span class="crm-chip">עוסק מורשה</span>
        <span class="crm-chip">פעילות אחרונה · 12.09.2026</span>
      </div>
    </div>
    <div class="crm-section">
      <div class="crm-section__head"><h2 class="crm-section__title">מסמכי חיוב</h2><span class="crm-section__count">3</span></div>
      <div class="crm-list">
        <div class="crm-item">
          <div class="crm-item__main">
            <div class="crm-item__title">חשבונית מס · ${esc("QASYNTHETICDOCNUMBER00000000000000000012345")}</div>
            <div class="crm-item__meta"><span class="crm-badge crm-badge--success">הופק</span> · 12.09.2026</div>
          </div>
          <div class="crm-item__amount">₪12,480.00</div>
        </div>
        <div class="crm-item">
          <div class="crm-item__main">
            <div class="crm-item__title">${esc("חשבונית מס/קבלה עבור הזמנת ציוד ותשתיות לרבעון הרביעי 2026")}</div>
            <div class="crm-item__meta"><span class="crm-badge crm-badge--warning">ממתין לאישור</span> · 01.09.2026</div>
          </div>
          <div class="crm-item__amount">₪1,203,940.55</div>
        </div>
      </div>
    </div>
  </div>`;
}

/** The inventory items row: the seven-track grid. */
function invRow(p) {
  return `<li><button type="button" class="inv-items-list__row" data-tone="${p.tone}" data-fixture="inv-${p.id}">
    <span class="inv-items-list__thumb inv-items-list__thumb--ph">▣</span>
    <span class="inv-items-list__main">
      <span class="inv-items-list__name">${esc(p.name)}</span>
      <span class="inv-items-list__meta">${esc(p.meta)}</span>
    </span>
    <span class="inv-items-list__bar"><div></div></span>
    <span class="inv-items-list__price${p.price === "ללא מחיר" ? " inv-items-list__price--missing" : ""}">${esc(p.price)}</span>
    <span class="inv-items-list__badge-cell"><span class="inv-status-badge inv-status-badge--${p.tone}">${
      p.tone === "ok" ? "תקין" : p.tone === "low" ? "מלאי נמוך" : "מלאי קריטי"
    }</span></span>
    <span class="inv-trend inv-trend--${p.tone === "ok" ? "up" : "down"}" aria-hidden>↗</span>
    <span class="inv-items-list__qty">${p.qty}</span>
  </button></li>`;
}

/** The inventory order line — the other place the inline-span defect lived. */
function invOrderLine(p) {
  return `<div class="inv-oline" data-fixture="oline-${p.id}">
    <span class="inv-row__thumb" style="width:48px;height:48px;font-size:22px" aria-hidden>▣</span>
    <span class="inv-oline__mid">
      <span class="inv-oline__nm" dir="auto">${esc(p.name)}</span>
      <span class="inv-oline__sub">${esc(p.meta)}</span>
    </span>
  </div>`;
}

function page() {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<style>${THEME_STUB}</style>
<style>${CRM_CSS}</style>
<style>${INV_PRIMITIVES_CSS}</style>
<style>${INV_ITEMS_CSS}</style>
</head><body>
<!-- Customers / Suppliers master pane. 380px is the real desktop master width. -->
<section class="crm-scope" data-screen="customers" dir="rtl">
  <div data-pane style="max-width:380px">
    <div class="crm-page">
      <div class="crm-hd"><div><h1 class="crm-hd__title">לקוחות</h1><div class="crm-hd__sub">5 לקוחות</div></div>
        <button class="crm-btn crm-btn--primary">+ לקוח חדש</button></div>
      <div class="crm-rows">${PEOPLE.map(crmRow).join("")}</div>
    </div>
  </div>
</section>

<section class="crm-scope" data-screen="suppliers" dir="rtl">
  <div data-pane>
    <div class="crm-page">
      <div class="crm-hd"><div><h1 class="crm-hd__title">ספקים</h1><div class="crm-hd__sub">5 ספקים</div></div>
        <button class="crm-btn crm-btn--primary">+ ספק חדש</button></div>
      <div class="crm-rows">${PEOPLE.map(crmRow).join("")}</div>
    </div>
  </div>
</section>

<section class="crm-scope" data-screen="leads" dir="rtl">
  <div data-pane style="max-width:380px">
    <div class="crm-page">
      <div class="crm-hd"><div><h1 class="crm-hd__title">לידים</h1><div class="crm-hd__sub">5 לידים</div></div>
        <button class="crm-btn crm-btn--primary">+ ליד חדש</button></div>
      <div class="crm-rows">${PEOPLE.map(leadRow).join("")}</div>
    </div>
  </div>
</section>

<section class="crm-scope" data-screen="customer-card" dir="rtl">
  <div data-pane>${PEOPLE.map(crmCard).join("")}</div>
</section>

<section data-screen="inventory-items" data-inventory-items-list dir="rtl">
  <div data-pane>
    <div class="inv-items-list__panel"><ul class="inv-items-list__list">${PRODUCTS.map(invRow).join("")}</ul></div>
  </div>
</section>

<section data-screen="inventory-lines" data-inventory-module dir="rtl">
  <div data-pane>${PRODUCTS.map(invOrderLine).join("")}</div>
</section>
</body></html>`;
}

// --------------------------------------------------------------- assertions

const WIDTHS = [
  { w: 320, tier: "mobile", note: "narrowest phone still supported" },
  { w: 360, tier: "mobile", note: "common Android" },
  { w: 390, tier: "mobile", note: "iPhone design target" },
  { w: 768, tier: "tablet", note: "portrait tablet" },
  { w: 1024, tier: "tablet", note: "landscape tablet — still one pane" },
  { w: 1280, tier: "desktop", note: "two-pane threshold (LAYOUT.bp.wide)" },
  { w: 1920, tier: "desktop", note: "wide desktop" },
];

/**
 * Runs in the page. Everything is measured against the CARD, not the window:
 * a text box that leaves its card is the defect, whether or not the document
 * ends up scrolling.
 */
function measure() {
  const TOL = 1.0; // sub-pixel rounding only
  const findings = [];

  const cardOf = (el) => el.closest(".crm-row, .crm-item, .crm-id, .inv-items-list__row, .inv-oline");

  /** The card's content box — border + padding excluded, which is where text must live. */
  function contentBox(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const px = (v) => parseFloat(v) || 0;
    return {
      left: r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
      right: r.right - px(cs.borderRightWidth) - px(cs.paddingRight),
      top: r.top + px(cs.borderTopWidth) + px(cs.paddingTop),
      bottom: r.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom),
    };
  }

  const TEXT = [
    ".crm-row__name",
    ".crm-row__meta",
    ".crm-row__meta-part",
    ".crm-id__name",
    ".crm-id__value",
    ".crm-item__title",
    ".crm-item__meta",
    ".crm-item__amount",
    ".inv-items-list__name",
    ".inv-items-list__meta",
    ".inv-items-list__price",
    ".inv-oline__nm",
    ".inv-oline__sub",
  ].join(",");

  // 1 — no text escapes its card.
  for (const el of document.querySelectorAll(TEXT)) {
    const card = cardOf(el);
    if (!card) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const box = contentBox(card);
    const overRight = r.right - box.right;
    const overLeft = box.left - r.left;
    const over = Math.max(overRight, overLeft);
    if (over > TOL) {
      findings.push({
        kind: "text-escapes-card",
        screen: card.closest("[data-screen]")?.dataset.screen ?? "?",
        fixture: card.dataset.fixture ?? card.closest("[data-fixture]")?.dataset.fixture ?? "?",
        selector: el.className || el.tagName,
        overflowPx: Math.round(over * 10) / 10,
        text: (el.textContent || "").trim().slice(0, 48),
      });
    }
  }

  // 2 — no card escapes its pane.
  for (const card of document.querySelectorAll(".crm-row, .crm-item, .crm-id, .inv-items-list__row, .inv-oline")) {
    const pane = card.closest("[data-pane]");
    if (!pane) continue;
    const r = card.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    const over = Math.max(r.right - p.right, p.left - r.left);
    if (over > TOL) {
      findings.push({
        kind: "card-escapes-pane",
        screen: card.closest("[data-screen]")?.dataset.screen ?? "?",
        fixture: card.dataset.fixture ?? "?",
        overflowPx: Math.round(over * 10) / 10,
      });
    }
  }

  // 3 — nothing escapes the viewport (the app clips this; here it must not happen).
  for (const el of document.querySelectorAll("[data-screen] *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > window.innerWidth + TOL || r.left < -TOL) {
      findings.push({
        kind: "escapes-viewport",
        screen: el.closest("[data-screen]")?.dataset.screen ?? "?",
        selector: (el.className && String(el.className).slice(0, 60)) || el.tagName,
        overflowPx: Math.round(Math.max(r.right - window.innerWidth, -r.left) * 10) / 10,
      });
      break; // one report per width is enough to fail it
    }
  }

  // 4 — controls keep their footprint.
  for (const el of document.querySelectorAll(".crm-row__avatar")) {
    const r = el.getBoundingClientRect();
    if (r.width < 41 || r.height < 41) {
      findings.push({ kind: "control-crushed", selector: "crm-row__avatar", w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  for (const el of document.querySelectorAll(".crm-row__chevron")) {
    if (el.getBoundingClientRect().width < 4) {
      findings.push({ kind: "control-crushed", selector: "crm-row__chevron", w: 0 });
    }
  }
  for (const el of document.querySelectorAll(".crm-id__actions .crm-btn, .crm-hd > .crm-btn")) {
    const r = el.getBoundingClientRect();
    if (r.width < 60) {
      findings.push({ kind: "control-crushed", selector: "crm-btn", w: Math.round(r.width), text: (el.textContent || "").trim() });
    }
  }

  // 5 — the text column actually receives the leftover room.
  for (const body of document.querySelectorAll(".crm-row__body")) {
    const row = body.closest(".crm-row");
    const rowW = contentBox(row).right - contentBox(row).left;
    const bodyW = body.getBoundingClientRect().width;
    if (rowW > 0 && bodyW / rowW < 0.5) {
      findings.push({ kind: "text-column-starved", ratio: Math.round((bodyW / rowW) * 100) / 100 });
    }
  }

  // 6 — RTL reading order. The bug this replaces was not only geometric: a
  // joined `phone · email · city` run is re-ordered by the bidi algorithm, so
  // the values appeared in an order nobody wrote. Parts must read in the order
  // they were passed — in RTL that means each part starts at or below the
  // previous one, and on a shared line it starts to its LEFT (further along the
  // RTL flow). Measured, because this is exactly the class of defect that looks
  // fine until you compare it against the source order.
  for (const line of document.querySelectorAll(".crm-row__meta")) {
    const parts = [...line.querySelectorAll(".crm-row__meta-part")];
    for (let i = 1; i < parts.length; i += 1) {
      const a = parts[i - 1].getBoundingClientRect();
      const b = parts[i].getBoundingClientRect();
      const sameLine = Math.abs(a.top - b.top) < 2;
      const ordered = sameLine ? b.right <= a.left + TOL : b.top >= a.top - TOL;
      if (!ordered) {
        findings.push({
          kind: "bidi-order-broken",
          screen: line.closest("[data-screen]")?.dataset.screen ?? "?",
          selector: "crm-row__meta-part",
          text: `"${(parts[i - 1].textContent || "").trim()}" then "${(parts[i].textContent || "").trim()}"`,
        });
      }
    }
  }

  // 7 — nothing is CLIPPED AWAY by a clamp. Containment alone is not enough:
  // a two-line clamp bounds the row, but anything placed after the clamped text
  // simply stops being rendered. A status badge that vanishes on long names is
  // the same class of harm as text leaving the card, just harder to notice —
  // the row looks tidy and is missing the fact that the record is inactive.
  for (const badge of document.querySelectorAll(".crm-row .crm-badge, .inv-status-badge")) {
    let clip = badge.parentElement;
    while (clip && clip !== document.body) {
      const cs = getComputedStyle(clip);
      if (cs.overflow !== "visible" || cs.overflowY !== "visible") break;
      clip = clip.parentElement;
    }
    if (!clip || clip === document.body) continue;
    const b = badge.getBoundingClientRect();
    const c = clip.getBoundingClientRect();
    if (b.height === 0 || b.bottom > c.bottom + TOL || b.top < c.top - TOL) {
      findings.push({
        kind: "badge-clipped-away",
        screen: badge.closest("[data-screen]")?.dataset.screen ?? "?",
        selector: String(badge.className),
        text: (badge.textContent || "").trim(),
      });
    }
  }

  // 8 — information that must not be silently dropped.
  const hidden = [];
  for (const sel of [".inv-items-list__price", ".inv-items-list__badge-cell"]) {
    for (const el of document.querySelectorAll(sel)) {
      if (getComputedStyle(el).display === "none") { hidden.push(sel); break; }
    }
  }
  for (const sel of hidden) findings.push({ kind: "information-hidden", selector: sel });

  // 9 — a block box whose content is wider than its own padding box is ellipsised —
  // reported, not failed: a clamped name is legitimate, a clamped price is not.
  const truncated = [];
  for (const el of document.querySelectorAll(TEXT)) {
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      truncated.push({
        selector: String(el.className).split(" ")[0],
        text: (el.textContent || "").trim().slice(0, 40),
      });
    }
  }

  return {
    findings,
    truncated,
    docScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    rows: document.querySelectorAll(".crm-row").length,
    metaParts: document.querySelectorAll(".crm-row__meta-part").length,
  };
}

// --------------------------------------------------------------------- main

const browser = await chromium.launch();
const results = [];
let failures = 0;

console.log(`\nEntity-list overflow harness — markup: ${MARKUP}, repo: ${REPO}`);
console.log("Screens: Customers · Leads · Suppliers · Inventory (items list + order line)\n");

for (const { w, tier, note } of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(page(), { waitUntil: "load" });
  await p.evaluate(() => document.fonts?.ready);
  const r = await p.evaluate(measure);
  if (SHOTS) {
    await p.screenshot({ path: path.join(SHOTS, `${MARKUP}-${w}.png`), fullPage: true });
    // Per-screen captures too: a full page at 320px is unreadable at review size,
    // and "inside the card" still has to be checked against "legible".
    for (const el of await p.$$("[data-screen]")) {
      const name = await el.getAttribute("data-screen");
      await el.screenshot({ path: path.join(SHOTS, `${MARKUP}-${w}-${name}.png`) });
    }
  }

  const scrollOverflow = r.docScrollWidth > r.innerWidth + 1;
  const ok = r.findings.length === 0 && !scrollOverflow;
  if (!ok) failures += 1;

  results.push({ width: w, tier, note, ...r, scrollOverflow, ok });

  console.log(`${ok ? "PASS" : "FAIL"}  ${String(w).padStart(4)}px  ${tier.padEnd(7)} ${note}`);
  if (scrollOverflow) {
    console.log(`        document scrolls horizontally: ${r.docScrollWidth} > ${r.innerWidth}`);
  }
  const byKind = new Map();
  for (const f of r.findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  for (const [kind, n] of byKind) {
    const sample = r.findings.find((f) => f.kind === kind);
    console.log(
      `        ${kind} ×${n}` +
        (sample.overflowPx != null ? ` — worst ${Math.max(...r.findings.filter((f) => f.kind === kind).map((f) => f.overflowPx ?? 0))}px out` : "") +
        (sample.text ? ` — e.g. "${sample.text}"` : "") +
        (sample.selector && !sample.text ? ` — ${sample.selector}` : ""),
    );
  }
  if (r.truncated.length) {
    const names = [...new Set(r.truncated.map((t) => t.selector))].join(", ");
    console.log(`        (ellipsised, reported not failed: ${r.truncated.length} — ${names})`);
  }
  await ctx.close();
}

await browser.close();

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ markup: MARKUP, repo: REPO, results }, null, 2));
  console.log(`\nJSON written to ${JSON_OUT}`);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${WIDTHS.length - failures}/${WIDTHS.length} widths clean\n`);
process.exit(failures === 0 ? 0 : 1);
