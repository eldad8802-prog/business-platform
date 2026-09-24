/**
 * Dubiz outline icons.
 *
 * Flat, single-weight outlines that read at 22–26px, each carrying its entity's
 * colour. They are the quiet half of the icon system: where a receipt needs a
 * drawn object with paper and ink, a family row needs a mark that is recognised
 * before it is looked at.
 *
 * One stroke weight, no fills except where a shape needs a body, no gradients,
 * no emoji, no 3D. The colour is restrained on purpose — the tile or row behind
 * an icon is always weaker than the icon itself.
 */

export const ICON_TONES = {
  invoice: "#2F6B52",
  collection: "#1F6F6B",
  payables: "#A9751C",
  documents: "#3E7A63",
  customers: "#3B6FB5",
  leads: "#7C5CBF",
  conversations: "#4FA3D1",
  inventory: "#7C5CBF",
  suppliers: "#3FA89B",
  content: "#C2725A",
  bots: "#4FA3D1",
  coupons: "#C2725A",
  settings: "#5A6560",
} as const;

export type IconEntity = keyof typeof ICON_TONES;

const PATHS: Record<IconEntity, (t: string) => React.ReactNode> = {
  // A sheet with lines and a corner fold — a document the business issues.
  invoice: (t) => (
    <>
      <path d="M6 3.2h7.5L18 7.7v12.9a1.2 1.2 0 0 1-1.2 1.2H6a1.2 1.2 0 0 1-1.2-1.2V4.4A1.2 1.2 0 0 1 6 3.2z" stroke={t} />
      <path d="M13.5 3.2v4.5H18" stroke={t} />
      <path d="M7.8 11.5h7M7.8 14.8h7M7.8 18h4.4" stroke={t} />
    </>
  ),
  // A banknote — money that arrived.
  collection: (t) => (
    <>
      <rect x="2.6" y="6.4" width="18.8" height="11.2" rx="1.6" stroke={t} />
      <circle cx="12" cy="12" r="3" stroke={t} />
      <path d="M5.6 9.4h.01M18.4 14.6h.01" stroke={t} strokeWidth={2.2} />
    </>
  ),
  // A sheet with a seal — a commitment the business carries.
  payables: (t) => (
    <>
      <path d="M5.4 3.6h9L18.6 7.8v9.6" stroke={t} />
      <path d="M18.6 17.4v3a1.2 1.2 0 0 1-1.2 1.2H5.4a1.2 1.2 0 0 1-1.2-1.2V4.8a1.2 1.2 0 0 1 1.2-1.2" stroke={t} />
      <path d="M14.4 3.6v4.2h4.2" stroke={t} />
      <path d="M7.2 11.4h5.4M7.2 14.4h3.6" stroke={t} />
      <circle cx="15.6" cy="16.2" r="3.4" stroke={t} />
      <path d="M14.1 16.3l1.1 1.1 2.1-2.2" stroke={t} />
    </>
  ),
  // Two stacked sheets — documents that arrive.
  documents: (t) => (
    <>
      <path d="M8.4 2.8h6.2L18.4 6.6v10.2a1.2 1.2 0 0 1-1.2 1.2H8.4a1.2 1.2 0 0 1-1.2-1.2V4a1.2 1.2 0 0 1 1.2-1.2z" stroke={t} />
      <path d="M14.6 2.8v3.8h3.8" stroke={t} />
      <path d="M4.8 7v13a1.2 1.2 0 0 0 1.2 1.2h8.6" stroke={t} />
    </>
  ),
  // Two people — the customers themselves.
  customers: (t) => (
    <>
      <circle cx="9" cy="8.4" r="3.4" stroke={t} />
      <path d="M3.2 19.6a5.8 5.8 0 0 1 11.6 0" stroke={t} />
      <path d="M16.2 5.6a3.4 3.4 0 0 1 0 6.4M17.4 19.6a5.9 5.9 0 0 0-2.1-4.5" stroke={t} />
    </>
  ),
  // A funnel — enquiries narrowing into customers.
  leads: (t) => (
    <>
      <path d="M3.4 4.6h17.2l-6.6 7.7v6.6l-4 2.5v-9.1z" stroke={t} />
    </>
  ),
  // Two speech bubbles — the conversation.
  conversations: (t) => (
    <>
      <path d="M3.2 6.4a1.8 1.8 0 0 1 1.8-1.8h8.6a1.8 1.8 0 0 1 1.8 1.8v4.8a1.8 1.8 0 0 1-1.8 1.8H8l-3.4 2.6v-2.6a1.8 1.8 0 0 1-1.4-1.8z" stroke={t} />
      <path d="M9.6 15.4a1.8 1.8 0 0 0 1.8 1.8h3.4l3.4 2.6v-2.6a1.8 1.8 0 0 0 1.6-1.8v-3.2a1.8 1.8 0 0 0-1.8-1.8h-2" stroke={t} />
    </>
  ),
  // A box — stock that physically exists.
  inventory: (t) => (
    <>
      <path d="M12 2.8l8.4 4.2v9.9L12 21.2l-8.4-4.3V7z" stroke={t} />
      <path d="M3.6 7l8.4 4.3L20.4 7M12 11.3v9.9" stroke={t} />
    </>
  ),
  // A van — the people who bring it.
  suppliers: (t) => (
    <>
      <path d="M2.6 6.6h10.2v9.8H2.6z" stroke={t} />
      <path d="M12.8 9.8h3.9l3.5 3.4v3.2h-7.4z" stroke={t} />
      <circle cx="6.6" cy="18.4" r="2" stroke={t} />
      <circle cx="16.6" cy="18.4" r="2" stroke={t} />
    </>
  ),
  // A pen on a sheet — something written for customers.
  content: (t) => (
    <>
      <path d="M18.6 11.4v8.2a1.2 1.2 0 0 1-1.2 1.2H5.6a1.2 1.2 0 0 1-1.2-1.2V4.6a1.2 1.2 0 0 1 1.2-1.2h7" stroke={t} />
      <path d="M20.3 3.6a1.9 1.9 0 0 1 0 2.7l-6.4 6.4-3 .8.8-3 6.4-6.4a1.9 1.9 0 0 1 2.2-.5z" stroke={t} />
    </>
  ),
  // A small machine that answers.
  bots: (t) => (
    <>
      <rect x="4.4" y="8" width="15.2" height="11.4" rx="3" stroke={t} />
      <path d="M12 4.4V8" stroke={t} />
      <circle cx="12" cy="3.4" r="1.4" stroke={t} />
      <path d="M9.4 12.8v1.4M14.6 12.8v1.4M10 16.4h4" stroke={t} />
    </>
  ),
  // A ticket with a torn line.
  coupons: (t) => (
    <>
      <path d="M3 8.4a1.4 1.4 0 0 1 1.4-1.4h15.2A1.4 1.4 0 0 1 21 8.4v2.2a2 2 0 0 0 0 3.8v2.2a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 16.6v-2.2a2 2 0 0 0 0-3.8z" stroke={t} />
      <path d="M9 7.6v8.8" stroke={t} strokeDasharray="1.4 2" />
    </>
  ),
  settings: (t) => (
    <>
      <circle cx="12" cy="12" r="3" stroke={t} />
      <path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2L5.6 5.6" stroke={t} />
    </>
  ),
};

export function FamilyIcon({ entity, size = 24 }: { entity: IconEntity; size?: number }) {
  const tone = ICON_TONES[entity];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ display: "block", flex: "0 0 auto" }}
    >
      {PATHS[entity](tone)}
    </svg>
  );
}

export const FAMILY_ICON_KEYS = Object.keys(PATHS) as IconEntity[];
