import type { ReactNode } from "react";

import { toneOfEntity, type EntityTone } from "@/lib/design/entity-tones";

/**
 * The Dubiz entity icons.
 *
 * One drawn object per thing the business deals with, carrying its SEMANTIC
 * role colour as the dominant fill: one fill + at most one accent + the ink
 * outline, so at 24px the role reads before the detail does.
 *
 * Paper stays the neutral material for anything document-shaped, so it is the
 * role colour — not the drawing — that separates a document the business
 * ISSUES (sand) from one that ARRIVED (slate) from a ledger of what it OWES
 * (ochre).
 */

const INK = "#1f2a26";
const PAPER = "#fffdf8";
const S = { stroke: INK, strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const DRAW: Record<string, (t: EntityTone) => ReactNode> = {
  // billing — a sheet we issue, with a Sand band and seal
  invoice: (t) => (
    <>
      <path d="M9 4h10l5 5v18.2a.8.8 0 0 1-.8.8H9a.8.8 0 0 1-.8-.8V4.8A.8.8 0 0 1 9 4z" fill={PAPER} {...S} />
      <path d="M19 4v5h5z" fill={t.solid} {...S} />
      <rect x="11" y="12" width="9" height="3" rx=".8" fill={t.solid} />
      <path d="M11 18.5h9M11 22h6" {...S} />
      <circle cx="21" cy="23.4" r="2.8" fill={t.solid} {...S} />
    </>
  ),
  // money in — a banknote, Teal
  collection: (t) => (
    <>
      <rect x="3.5" y="9" width="25" height="15" rx="2" fill={t.tint} {...S} />
      <circle cx="16" cy="16.5" r="4.4" fill={t.solid} {...S} />
      <path d="M7.5 13v.01M24.5 20v.01" {...S} strokeWidth={2.4} />
    </>
  ),
  // money in — a receipt with a Teal coin arriving
  "payment-request": (t) => (
    <>
      <path d="M9 4h15v22.5l-2.5-1.8-2.5 1.8-2.5-1.8-2.5 1.8-2.5-1.8L9 26.5z" fill={PAPER} {...S} />
      <path d="M13 10h7M13 14h5" {...S} />
      <circle cx="10.5" cy="21" r="5.2" fill={t.solid} {...S} />
      <path d="M10.5 18.6v4.8M8.1 21h4.8" stroke={PAPER} strokeWidth={2} strokeLinecap="round" />
    </>
  ),
  // money out — a ledger of what we owe, Ochre
  payables: (t) => (
    <>
      <rect x="6.5" y="4" width="18" height="24" rx="2" fill={t.tint} {...S} />
      <path d="M10.5 10h10M10.5 14h7" {...S} />
      <circle cx="21.5" cy="22" r="5.4" fill={t.solid} {...S} />
      <path d="M19.2 22l1.6 1.6 3-3.2" {...S} />
    </>
  ),
  // money out — the Secretary who reminds about it
  secretary: (t) => (
    <>
      <path d="M5 7.5A2.5 2.5 0 0 1 7.5 5h17A2.5 2.5 0 0 1 27 7.5v12a2.5 2.5 0 0 1-2.5 2.5H13l-5.5 4.5V22A2.5 2.5 0 0 1 5 19.5z" fill={t.tint} {...S} />
      <path d="M16 8.6l1.5 3 3.3.5-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.4-2.3 3.3-.5z" fill={t.solid} {...S} strokeWidth={1.4} />
    </>
  ),
  // document arriving — Sky sheets
  documents: (t) => (
    <>
      <rect x="11" y="3.5" width="15" height="19" rx="1.6" fill={t.solid} {...S} />
      <rect x="6" y="8.5" width="15" height="19" rx="1.6" fill={PAPER} {...S} />
      <path d="M9.5 14h8M9.5 18h8M9.5 22h5" {...S} />
    </>
  ),
  "documents-email": (t) => (
    <>
      <rect x="9" y="4" width="14" height="13" rx="1.4" fill={PAPER} {...S} />
      <path d="M12 8h8M12 11.5h5" {...S} />
      <path d="M4 13.5l12 7.5 12-7.5V26a1.2 1.2 0 0 1-1.2 1.2H5.2A1.2 1.2 0 0 1 4 26z" fill={t.solid} {...S} />
    </>
  ),
  upload: (t) => (
    <>
      <rect x="7" y="6" width="18" height="22" rx="1.8" fill={PAPER} {...S} />
      <circle cx="16" cy="15" r="6.2" fill={t.solid} {...S} />
      <path d="M16 18.2v-6.4M13.4 14.2L16 11.6l2.6 2.6" stroke={PAPER} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 24h10" {...S} />
    </>
  ),
  // people — Coral
  leads: (t) => (
    <>
      <circle cx="12" cy="10" r="4.4" fill={t.solid} {...S} />
      <path d="M4.5 26a7.5 7.5 0 0 1 15 0z" fill={t.tint} {...S} />
      <path d="M21.5 8.5a5 5 0 0 1 0 7M24.5 5.5a9.5 9.5 0 0 1 0 13" {...S} />
    </>
  ),
  customers: (t) => (
    <>
      <rect x="3.5" y="7" width="25" height="18" rx="2.4" fill={PAPER} {...S} />
      <circle cx="11" cy="14" r="3.4" fill={t.solid} {...S} />
      <path d="M6.3 21.6a4.7 4.7 0 0 1 9.4 0" {...S} />
      <path d="M19 13h6M19 17h4" {...S} />
    </>
  ),
  conversations: (t) => (
    <>
      <path d="M4 7a2.4 2.4 0 0 1 2.4-2.4h12.2A2.4 2.4 0 0 1 21 7v7.5a2.4 2.4 0 0 1-2.4 2.4H10l-4.5 3.5v-3.5A2.4 2.4 0 0 1 4 14.5z" fill={t.solid} {...S} />
      <path d="M13 15a2.4 2.4 0 0 1 2.4-2.4h10.2A2.4 2.4 0 0 1 28 15v6.5a2.4 2.4 0 0 1-2.4 2.4H25v3.5l-4.5-3.5h-5.1A2.4 2.4 0 0 1 13 21.5z" fill={PAPER} {...S} />
    </>
  ),
  bots: (t) => (
    <>
      <path d="M16 5.5v4" {...S} />
      <circle cx="16" cy="5" r="2" fill={t.solid} {...S} />
      <rect x="6.5" y="9.5" width="19" height="15" rx="4" fill={t.tint} {...S} />
      <path d="M12 16v1.2M20 16v1.2M13 20.5h6" {...S} />
      <path d="M4 15v4M28 15v4" {...S} />
    </>
  ),
  coupons: (t) => (
    <>
      <path d="M4 10a2 2 0 0 1 2-2h20a2 2 0 0 1 2 2v3a3 3 0 0 0 0 6v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a3 3 0 0 0 0-6z" fill={t.solid} {...S} />
      <path d="M12 9.5v13" {...S} strokeDasharray="1.6 2.4" />
      <path d="M16.5 13.5h6M16.5 18h4" {...S} />
    </>
  ),
  // operations — Sage
  inventory: (t) => (
    <>
      <path d="M16 4l11 5.5L16 15 5 9.5z" fill={t.solid} {...S} />
      <path d="M5 9.5V22l11 5.5V15z" fill={PAPER} {...S} />
      <path d="M27 9.5V22l-11 5.5V15z" fill={t.tint} {...S} />
    </>
  ),
  suppliers: (t) => (
    <>
      <rect x="3" y="8" width="15" height="13" rx="1.4" fill={t.solid} {...S} />
      <path d="M18 12h5l4.5 4.5V21H18z" fill={PAPER} {...S} />
      <circle cx="8.5" cy="23" r="2.6" fill={PAPER} {...S} />
      <circle cx="22.5" cy="23" r="2.6" fill={PAPER} {...S} />
    </>
  ),
  pricing: (t) => (
    <>
      <path d="M15.5 4.5h9a2 2 0 0 1 2 2v9L15 27a2 2 0 0 1-2.8 0L5 19.8A2 2 0 0 1 5 17z" fill={t.solid} {...S} />
      <circle cx="21" cy="10" r="2.2" fill={PAPER} {...S} />
      <path d="M11.5 17.5l5-5" {...S} />
    </>
  ),
  connections: (t) => (
    <>
      <rect x="3.5" y="12" width="14" height="8" rx="4" transform="rotate(-35 10.5 16)" fill={t.tint} {...S} />
      <rect x="14.5" y="12" width="14" height="8" rx="4" transform="rotate(-35 21.5 16)" fill={t.tint} {...S} />
      <path d="M12.5 17.5l7-3" {...S} />
    </>
  ),
  // the calm mark — money-in green, because a calm day is a settled one
  stamp: (t) => (
    <>
      <circle cx="16" cy="16" r="12.5" fill={PAPER} {...S} />
      <circle cx="16" cy="16" r="9" fill={t.tint} stroke={INK} strokeWidth={1.2} strokeDasharray="1.4 2" />
      <path d="M11.8 16.2l2.9 2.9 5.6-6" {...S} strokeWidth={2.2} />
    </>
  ),
};

const ALIAS: Record<string, string> = { invoices: "invoice", payment: "payment-request", obligation: "payables", document: "documents", lead: "leads", marketing: "coupons" };

/** An entity glyph, coloured by its semantic role. */
export function EntityIcon({ entity, size = 28, tone }: { entity: string; size?: number; tone?: EntityTone }) {
  const key = ALIAS[entity] ?? entity;
  const draw = DRAW[key];
  const t = tone ?? toneOfEntity(entity);
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none" aria-hidden style={{ display: "block", flex: "0 0 auto" }}>
      {draw ? draw(t) : null}
    </svg>
  );
}

export const ENTITY_ICON_KEYS = Object.keys(DRAW);
