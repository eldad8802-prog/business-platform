/**
 * The three family marks.
 *
 * Each one is a small COMPOSITION rather than a single category glyph: two
 * objects the family is actually made of, overlapping, drawn in one ink weight
 * with at most two semantic colours. That is what gives a tile its character —
 * the surface behind it stays quiet on purpose.
 *
 * The palette is Home's own: Dubiz teal, restrained ochre, sage, and the paper
 * and sand fills already on the screen. No third hue enters here.
 */

const INK = "#1f2a26";
const PAPER = "#fffdf8";
const TEAL = "#1f6f6b";
const OCHRE = "#b8862b";
const SAGE = "#4e8168";
const SAND = "#efe2c8";
const MINT = "#dcebe0";
const STONE = "#e6e7e1";

const S = {
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  fill: "none",
};

export type FamilyMarkKey = "money" | "customers" | "operations";

/** A document being issued, and the money that comes back for it. */
function MoneyMark() {
  return (
    <>
      <path d="M16 3h11l5 5v17.5a1 1 0 0 1-1 1H16a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" {...S} fill={PAPER} stroke={INK} />
      <path d="M27 3v5h5" stroke={INK} {...S} />
      <path d="M18.5 12h8M18.5 15.5h8M18.5 19h5" stroke={OCHRE} {...S} />
      <rect x="3" y="16" width="19" height="12" rx="2" {...S} fill={SAND} stroke={INK} />
      <circle cx="12.5" cy="22" r="3.4" {...S} fill={TEAL} stroke={INK} />
    </>
  );
}

/** A person, and the conversation you are having with them. */
function CustomersMark() {
  return (
    <>
      <path
        d="M23 4h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4 3.5V16h-1a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
        {...S}
        fill={MINT}
        stroke={INK}
      />
      <path d="M28 8.5h8M28 12h5" stroke={SAGE} {...S} />
      <circle cx="12" cy="11" r="5" {...S} fill={PAPER} stroke={INK} />
      <path d="M3.5 27a8.5 8.5 0 0 1 17 0z" {...S} fill={TEAL} stroke={INK} />
    </>
  );
}

/** Stock that exists, and the people who bring it. */
function OperationsMark() {
  return (
    <>
      <path d="M14 3l10 5v11l-10 5-10-5V8z" {...S} fill={STONE} stroke={INK} />
      <path d="M4 8l10 5 10-5M14 13v11" stroke={INK} {...S} />
      <rect x="22" y="16" width="12" height="9" rx="1.3" {...S} fill={PAPER} stroke={INK} />
      <path d="M34 19h3.5l3 3v3H34z" {...S} fill={TEAL} stroke={INK} />
      <circle cx="26" cy="26.5" r="2.2" {...S} fill={PAPER} stroke={INK} />
      <circle cx="36" cy="26.5" r="2.2" {...S} fill={PAPER} stroke={INK} />
    </>
  );
}

const MARKS: Record<FamilyMarkKey, () => React.ReactElement> = {
  money: MoneyMark,
  customers: CustomersMark,
  operations: OperationsMark,
};

export function FamilyMark({ family, width = 50 }: { family: FamilyMarkKey; width?: number }) {
  const Mark = MARKS[family];
  if (!Mark) return null;
  return (
    <svg viewBox="0 0 44 32" width={width} height={(width * 32) / 44} aria-hidden style={{ display: "block" }}>
      <Mark />
    </svg>
  );
}
