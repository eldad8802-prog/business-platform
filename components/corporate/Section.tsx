import type { ReactNode } from "react";
import { CorporateContainer } from "./CorporateContainer";

/**
 * Section — the rhythm primitive for the public marketing pages.
 *
 * Promoted out of the V2.1 homepage prototype, where it was the single change
 * that stopped the page reading like a template. Two ideas do the work:
 *
 * 1. **Background separates sections, not borders.** The old `/home` wrapped
 *    almost every idea in `rounded-[28px] + shadow`, so eight consecutive ideas
 *    arrived in eight identical containers. Here a section is delimited by the
 *    surface it sits on. A CARD is then free to mean something again: it is
 *    reserved for content that is an actual artifact (a receipt, a product
 *    fragment, a record), never for marketing prose.
 *
 * 2. **Height is an instrument.** Uniform vertical padding is what makes a long
 *    page feel like a list. `pad` is chosen per section so the page has a pulse:
 *    the emotional beats breathe, the connective ones stay tight.
 *
 * Full-bleed by design: the tone paints edge to edge while the text column stays
 * inside `CorporateContainer`, which is why the wrapper is the Section and not
 * the other way round.
 */
type Tone = "base" | "sand" | "stage" | "paper";

/**
 * Tone carries meaning, not alternation (Sage & Sand + Forest Stage):
 * sage (`base`) is the product / control ground; `sand` is the owner's own
 * world — reserved for sections that set no muted text (AA, see
 * marketing-tokens); `stage` is the ONE dark band on the page, where the
 * product itself is shown.
 */
const TONE: Record<Tone, string> = {
  /** The page ground — Mist sage. */
  base: "bg-[var(--mkt-page)]",
  /** Warm sand — the human sections. */
  sand: "bg-[var(--mkt-sand)]",
  /** Forest stage — the product proof, and nothing else. */
  stage: "bg-[var(--mkt-stage)] text-[var(--mkt-on-stage)]",
  /** Mist paper — the diffusion treatment, never a raw white. */
  paper: "dz-mist",
};

/** Height is a rhythm instrument, not a default. Adjacent sections differ. */
const PAD = {
  xs: "py-6 sm:py-7",
  sm: "py-10 sm:py-12",
  md: "py-14 sm:py-18",
  lg: "py-18 sm:py-24",
  xl: "py-20 sm:py-28",
} as const;

/** Bottom-only override, for sections whose trailing gap reads as "page ended". */
const PAD_B = {
  xs: "pb-6 sm:pb-7",
  sm: "pb-10 sm:pb-12",
  md: "pb-14 sm:pb-18",
  lg: "pb-18 sm:pb-24",
  xl: "pb-20 sm:pb-28",
} as const;

export function Section({
  tone = "base",
  pad = "md",
  padB,
  labelledById,
  children,
}: {
  tone?: Tone;
  pad?: keyof typeof PAD;
  padB?: keyof typeof PAD;
  /** Id of this section's heading, so the landmark carries an accessible name. */
  labelledById?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={labelledById}
      className={`${TONE[tone]} ${PAD[pad]} ${padB ? PAD_B[padB] : ""}`}
    >
      <CorporateContainer>{children}</CorporateContainer>
    </section>
  );
}
