"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { ProductFragment } from "./ProductFragment";

/**
 * ProductProof — four real areas of Dubiz, one readable at a time, on a stage.
 *
 * ## Structure: INDEX + STAGE
 *
 * Four fragments cannot all be large at once, so exactly one is on the stage
 * and the other three are named, numbered choices. The section sits on the
 * page's single dark band (`Section tone="stage"`), so the product is the only
 * thing lit — the screens read as objects placed on a stage, not as one more
 * white card on an almost-white page.
 *
 *   Desktop (lg+)  a numbered index beside the stage. The selected row gets the
 *                  full-ink name, its caption, a tinted row, and a 3 px cream
 *                  marker on the edge that FACES the stage — the marker is what
 *                  ties the choice to what changed.
 *   Phone          one segmented track, four equal segments in one row (never a
 *                  wrapping row of pills); the selected segment is filled paper
 *                  on the forest track. Its caption sits between the track and
 *                  the stage.
 *
 * Selection never leans on the action teal (that colour means "do something")
 * and never on a faint tint alone: paper-on-track is 10.3:1 and the cream
 * marker 6.8:1 against the stage (WCAG 1.4.11 asks ≥ 3:1).
 *
 * ## Why tabs, not a carousel or a scroller
 *
 * No motion that moves on its own (forbidden by the visual spec), no swipe-only
 * affordance, no half-visible card at the edge. WAI-ARIA tabs with a roving
 * tabindex: one tab in the Tab sequence; arrow keys move within the group —
 * Left/Right (RTL: Left advances) for the phone row, Up/Down for the desktop
 * column, both accepted at every width. Home / End jump to the ends.
 *
 * ## No layout shift
 *
 * The stage reserves the aspect ratio of the TALLEST fragment, so switching
 * areas never moves the page below it. All four panels stay mounted (`hidden`
 * on the inactive ones) so every alt text is in the markup.
 */

export type ProofArea = {
  /** Short tab label — an area of the product, not a feature name. */
  label: string;
  src: string;
  alt: string;
  /** The asset's true pixel size (assets differ; never assume one size). */
  width: number;
  height: number;
  /** Gate-approved caption (see the copy record). Never invent one here. */
  caption: string;
};

export function ProductProof({ areas }: { areas: ProofArea[] }) {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Reserve the tallest fragment's proportions for every area.
  const tallest = areas.reduce((a, b) => (b.height / b.width > a.height / a.width ? b : a));

  function focusTab(index: number) {
    const next = (index + areas.length) % areas.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      // RTL: the visually-next segment is to the LEFT, so ArrowLeft advances.
      case "ArrowLeft":
      case "ArrowDown":
        event.preventDefault();
        focusTab(active + 1);
        break;
      case "ArrowRight":
      case "ArrowUp":
        event.preventDefault();
        focusTab(active - 1);
        break;
      case "Home":
        event.preventDefault();
        focusTab(0);
        break;
      case "End":
        event.preventDefault();
        focusTab(areas.length - 1);
        break;
      default:
    }
  }

  const current = areas[active];

  return (
    <div className="mt-10 lg:mt-14 lg:grid lg:grid-cols-[minmax(0,17rem)_minmax(0,32.5rem)] lg:items-start lg:gap-16">
      {/* ── the index / the segmented track ─────────────────────────────── */}
      <div
        role="tablist"
        aria-label="אזורים במערכת"
        onKeyDown={onKeyDown}
        className="grid max-w-[32.5rem] grid-cols-4 gap-1 rounded-[var(--mkt-radius-control)] bg-[var(--mkt-stage-track)] p-1 lg:flex lg:flex-col lg:gap-0 lg:rounded-none lg:border-t lg:border-[var(--mkt-stage-line)] lg:max-w-none lg:bg-transparent lg:p-0"
      >
        {areas.map((area, i) => {
          const selected = i === active;
          return (
            <button
              key={area.label}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`proof-tab-${i}`}
              aria-selected={selected}
              aria-controls={`proof-panel-${i}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(i)}
              className={[
                // shared
                "min-h-[44px] min-w-0 rounded-[calc(var(--mkt-radius-control)-4px)] px-1 text-[15px] font-semibold transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mkt-on-stage)]",
                // desktop: an index row, marker on the edge facing the stage
                "lg:grid lg:grid-cols-[2.25rem_1fr] lg:items-baseline lg:rounded-none lg:border-b lg:border-e-[3px] lg:border-b-[var(--mkt-stage-line)] lg:px-4 lg:py-5 lg:text-start lg:text-lg",
                selected
                  ? "bg-[var(--mkt-on-stage)] text-[var(--mkt-stage)] lg:border-e-[var(--mkt-stage-marker)] lg:bg-[var(--mkt-stage-track)] lg:text-[var(--mkt-on-stage)]"
                  : "text-[var(--mkt-on-stage-muted)] hover:text-[var(--mkt-on-stage)] lg:border-e-transparent",
              ].join(" ")}
            >
              <span
                aria-hidden
                className="hidden text-sm tabular-nums lg:inline"
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <span>{area.label}</span>
              {/* Desktop: the choice explains itself. Hidden from the tab's
                  accessible name — the panel is described by the caption below. */}
              {selected ? (
                <span
                  aria-hidden
                  className="hidden text-[15px] font-normal leading-7 text-[var(--mkt-on-stage-muted)] lg:col-start-2 lg:mt-2 lg:block"
                >
                  {area.caption}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Phone: the caption sits between the choice and the screen. It is also
          the panel's accessible description at every width. Three lines are
          reserved so a longer caption never pushes the stage down. */}
      <p
        id="proof-caption"
        className="mt-4 min-h-[5.25rem] max-w-[32.5rem] text-[15px] leading-7 text-[var(--mkt-on-stage-muted)] lg:sr-only lg:min-h-0"
      >
        {current.caption}
      </p>

      {/* ── the stage ────────────────────────────────────────────────────── */}
      <div
        // Capped at the desktop stage width at every size: on a tablet a
        // full-width phone screen would be ~1,060 px tall and under 2× density.
        className="mt-3 max-w-[32.5rem] lg:mt-0"
        style={{ aspectRatio: `${tallest.width} / ${tallest.height}` }}
      >
        {areas.map((area, i) => (
          <div
            key={area.label}
            role="tabpanel"
            id={`proof-panel-${i}`}
            aria-labelledby={`proof-tab-${i}`}
            aria-describedby={i === active ? "proof-caption" : undefined}
            tabIndex={0}
            hidden={i !== active}
            className="rounded-[var(--mkt-radius-object)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--mkt-on-stage)]"
          >
            <ProductFragment
              src={area.src}
              alt={area.alt}
              width={area.width}
              height={area.height}
              sizes="(min-width: 1024px) 520px, 92vw"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
