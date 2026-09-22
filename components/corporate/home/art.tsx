/**
 * The homepage's graphic vocabulary (D-derived art direction). Pure SVG, no
 * state, all decorative — every piece is `aria-hidden`. Product proof is never
 * drawn here: real screens and components are images captured from the app.
 */

const INK = "var(--mkt3-ink)";

/** An irregular colour mass. Stretches to its box. */
const BLOB_PATHS = {
  a: "M22,6 C42,-3 70,3 84,16 C98,29 97,55 90,72 C82,92 57,101 35,95 C13,89 0,70 3,47 C5,29 8,13 22,6 Z",
  b: "M14,18 C30,2 64,0 84,12 C100,22 102,52 96,72 C88,94 58,102 34,96 C12,90 -2,70 2,48 C4,36 6,26 14,18 Z",
  c: "M30,4 C52,-2 80,4 94,20 C104,34 100,62 92,78 C82,96 56,102 34,96 C12,90 -2,72 2,50 C5,30 12,10 30,4 Z",
} as const;

export function BlobShape({ variant, fill }: { variant: keyof typeof BLOB_PATHS; fill: string }) {
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden focusable="false">
      <path d={BLOB_PATHS[variant]} fill={fill} />
    </svg>
  );
}

/** A section's curved top boundary, painted in that section's own colour. */
const EDGE_PATHS = {
  a: "M0,120 L0,78 C300,10 700,110 1080,54 C1250,30 1350,40 1440,62 L1440,120 Z",
  b: "M0,120 L0,40 C260,120 820,0 1440,90 L1440,120 Z",
  c: "M0,120 L0,50 C420,120 900,0 1440,70 L1440,120 Z",
} as const;

export function Edge({ variant, fill, className }: { variant: keyof typeof EDGE_PATHS; fill: string; className: string }) {
  return (
    <svg className={className} viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden focusable="false">
      <path d={EDGE_PATHS[variant]} fill={fill} />
    </svg>
  );
}

/**
 * A receipt, drawn in the page's ink line — the business's own paper, before
 * Dubiz. Abstract bars, never legible fake data.
 */
export function Receipt({ check = false }: { check?: boolean }) {
  return (
    <svg viewBox="0 0 210 420" width="100%" aria-hidden focusable="false" style={{ display: "block", overflow: "visible" }}>
      <path
        d="M4 14 Q4 4 14 4 H196 Q206 4 206 14 V392 l-17 20 -17 -20 -17 20 -17 -20 -17 20 -17 -20 -17 20 -17 -20 -17 20 -17 -20 -17 20 -18 -20 Z"
        fill="var(--mkt3-white)"
        stroke={INK}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <rect x="58" y="36" width="94" height="12" rx="6" fill={INK} />
      <g fill="#cfc9bc">
        <rect x="28" y="84" width="150" height="8" rx="4" />
        <rect x="28" y="112" width="120" height="8" rx="4" />
        <rect x="28" y="140" width="140" height="8" rx="4" />
        {check ? null : (
          <>
            <rect x="28" y="168" width="96" height="8" rx="4" />
            <rect x="28" y="196" width="132" height="8" rx="4" />
          </>
        )}
      </g>
      <line x1="28" y1={check ? 180 : 236} x2="182" y2={check ? 180 : 236} stroke={INK} strokeWidth="2" strokeDasharray="1 7" strokeLinecap="round" />
      {check ? (
        <path d="M78 262 l20 20 l40 -44" fill="none" stroke="var(--mkt3-action)" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <>
          <rect x="28" y="262" width="60" height="12" rx="6" fill={INK} />
          <rect x="122" y="262" width="60" height="12" rx="6" fill="var(--mkt3-action)" />
          <g fill="#cfc9bc">
            <rect x="28" y="306" width="154" height="8" rx="4" />
            <rect x="28" y="330" width="110" height="8" rx="4" />
          </g>
        </>
      )}
    </svg>
  );
}

/**
 * A stamp — used ONLY where something was really stamped: the invoice in the
 * screenshot beside it was issued.
 */
export function Stamp({ word, sub }: { word: string; sub: string }) {
  return (
    <svg viewBox="0 0 170 170" width="100%" aria-hidden focusable="false" style={{ display: "block" }}>
      <circle cx="85" cy="85" r="82" fill="var(--mkt3-white)" stroke={INK} strokeWidth="2.5" />
      <circle cx="85" cy="85" r="68" fill="none" stroke={INK} strokeWidth="1.5" strokeDasharray="2 5" />
      <text x="85" y="84" textAnchor="middle" fontFamily="inherit" fontSize="36" fontWeight="600" fill={INK}>
        {word}
      </text>
      <text x="85" y="112" textAnchor="middle" fontFamily="inherit" fontSize="15" fontWeight="600" fill="var(--mkt3-ink2)" letterSpacing="2">
        {sub}
      </text>
    </svg>
  );
}

/** A dotted ink line that joins two related objects. */
export function DotLink({ d, viewBox }: { d: string; viewBox: string }) {
  return (
    <svg viewBox={viewBox} width="100%" preserveAspectRatio="none" aria-hidden focusable="false" style={{ display: "block", overflow: "visible" }}>
      <path d={d} fill="none" stroke={INK} strokeWidth="3" strokeDasharray="0.1 10" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
