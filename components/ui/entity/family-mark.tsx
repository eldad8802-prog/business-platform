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
      <path d="M18.5 12h8M18.5 16h5.5" stroke={OCHRE} {...S} />
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
      <path d="M14 3l10 5v11l-10 5-10-5V8z" {...S} fill={PAPER} stroke={INK} />
      {/* The lid in cardboard sand: on the sage tile a stone-filled cube read
          as an outline only, and the whole mark went light. */}
      <path d="M14 3l10 5-10 5-10-5z" {...S} fill={SAND} stroke={INK} />
      <path d="M14 13v11" stroke={INK} {...S} />
      <rect x="22" y="16" width="12" height="9" rx="1.3" {...S} fill={PAPER} stroke={INK} />
      <path d="M34 19h3.5l3 3v3H34z" {...S} fill={TEAL} stroke={INK} />
      <circle cx="26" cy="26.5" r="2.2" {...S} fill={PAPER} stroke={INK} />
      <circle cx="36" cy="26.5" r="2.2" {...S} fill={PAPER} stroke={INK} />
    </>
  );
}

/**
 * Each mark gets the box its drawing actually occupies, and an optical scale.
 *
 * Drawn on one shared canvas they looked like different sizes: the money mark
 * reached x=32 while the other two ran to the edge, so it read as the small
 * one. Cropping every mark to its own ink fixed the canvas, but equal HEIGHT
 * still left the money mark the lightest — measured ink area at 30px was
 * 895 / 1242 / 1116 px². Area alone is not the whole story either: on a real
 * phone the compact, densely-inked money mark still read heaviest and the
 * operations mark lightest. `optical` is tuned by eye on the rendered tiles,
 * with ink DENSITY (fills, inner lines) balanced in the drawings themselves.
 */
const MARKS: Record<FamilyMarkKey, { draw: () => React.ReactElement; box: string; ratio: number; optical: number }> = {
  money: { draw: MoneyMark, box: "2 2 31 27", ratio: 31 / 27, optical: 0.95 },
  customers: { draw: CustomersMark, box: "2.5 3 39.5 25", ratio: 39.5 / 25, optical: 0.9 },
  operations: { draw: OperationsMark, box: "3 2 38.5 27.5", ratio: 38.5 / 27.5, optical: 0.98 },
};

/** `size` is the nominal mark size; each mark renders at its optical share of it. */
export function FamilyMark({ family, size = 30 }: { family: FamilyMarkKey; size?: number }) {
  const mark = MARKS[family];
  if (!mark) return null;
  const Draw = mark.draw;
  const height = +(size * mark.optical).toFixed(1);
  return (
    <svg
      viewBox={mark.box}
      height={height}
      width={+(height * mark.ratio).toFixed(1)}
      aria-hidden
      style={{ display: "block" }}
    >
      <Draw />
    </svg>
  );
}
