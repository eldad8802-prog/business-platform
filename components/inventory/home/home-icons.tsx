import type { ReactNode } from "react";

/**
 * Single SVG icon set for the Inventory home screen (screen s8 redesign).
 *
 * Replaces the previous split between the local `page.tsx` icons and the emoji
 * product thumbs (`getProductEmoji`). One line-weight family, `currentColor`
 * throughout so each call site tints via the token classes. Product rows resolve
 * a real glyph through {@link ProductGlyph} instead of an emoji.
 */

function Svg({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

export function IconScan() {
  return (
    <Svg size={24}>
      <path
        d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path d="M7 12h10" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </Svg>
  );
}

export function IconPlus() {
  return (
    <Svg>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function IconCount() {
  return (
    <Svg>
      <rect x="5" y="3" width="14" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

export function IconTruck() {
  return (
    <Svg>
      <path d="M2 6.5A1.5 1.5 0 0 1 3.5 5H12a1.5 1.5 0 0 1 1.5 1.5V16H2V6.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M13.5 9H17l3.5 3.5V16h-7z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="6" cy="18" r="1.7" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17" cy="18" r="1.7" stroke="currentColor" strokeWidth="1.8" />
    </Svg>
  );
}

export function IconReceive() {
  return (
    <Svg>
      <rect x="3" y="8" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 8l2.2-4.2A2 2 0 0 1 7 2.7h10a2 2 0 0 1 1.8 1.1L21 8" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M3 12h6a2 2 0 0 0 6 0h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

export function IconBox() {
  return (
    <Svg>
      <path d="M12 3l8 4.3v9.4L12 21l-8-4.3V7.3L12 3z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M4 7.3l8 4.3 8-4.3M12 11.6V21" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </Svg>
  );
}

export function IconBottle() {
  return (
    <Svg>
      <path
        d="M10 2h4v3l1.4 2.1A3 3 0 0 1 16 9v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V9a3 3 0 0 1 .6-1.9L10 5V2z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M8 13h8" stroke="currentColor" strokeWidth="1.7" />
    </Svg>
  );
}

export function IconAlertTriangle() {
  return (
    <Svg size={28}>
      <path d="M12 3l9.5 16.5H2.5L12 3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 10v4M12 17h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

export function IconRetry() {
  return (
    <Svg size={17}>
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function IconBoxStack() {
  return (
    <Svg size={28}>
      <path d="M12 3l8 4.3v9.4L12 21l-8-4.3V7.3L12 3z" fill="currentColor" fillOpacity="0.13" />
      <path d="M12 3l8 4.3v9.4L12 21l-8-4.3V7.3L12 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M4 7.3l8 4.3 8-4.3M12 11.6V21" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </Svg>
  );
}

/** Liquid-container keywords resolve to the bottle glyph; everything else is a box. */
const BOTTLE_KEYWORDS = [
  "שמן",
  "חלב",
  "שמנת",
  "יוגורט",
  "מעדן",
  "מים",
  "מינרלי",
  "קולה",
  "סודה",
  "ספרייט",
  "מוגז",
  "מיץ",
  "יין",
  "בירה",
  "וודקה",
  "וויסקי",
  "אלכוהול",
  "משקה",
  "רוטב",
  "milk",
  "water",
  "oil",
  "juice",
  "soda",
  "cola",
  "wine",
  "beer",
];

/**
 * Real product glyph for an attention row — derived from the product name /
 * category, mirroring the emoji resolver's intent but returning an SVG. Purely
 * presentational; no data dependency.
 */
export function ProductGlyph({ name, category }: { name?: string | null; category?: string | null }) {
  const haystack = `${name ?? ""} ${category ?? ""}`.toLowerCase();
  const isBottle = BOTTLE_KEYWORDS.some((k) => haystack.includes(k));
  return isBottle ? <IconBottle /> : <IconBox />;
}
