"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { ProductFragment, type FragmentCrop } from "./ProductFragment";

/**
 * ProductProof — four real areas of Dubiz, each one readable.
 *
 * ## The problem it replaces
 *
 * `/home` proved BREADTH (four areas) but at a size where nothing could be read.
 * V2.1 proved DEPTH (one readable fragment) but showed only a single area. The
 * final page needs both, and the constraint that forces the design is simple:
 * four fragments cannot all be large at the same time.
 *
 * So only one is large at a time, and the other three are present as named
 * choices. That is a tablist — the visitor sees that four areas exist, and every
 * one of them can be brought to full readable width.
 *
 * ## Why a tablist and not a carousel or a scroller
 *
 *   - A horizontal scroller is what produced the "half-broken card" edge on
 *     mobile, and its affordance is implicit.
 *   - A carousel would have to auto-advance to be noticed, and motion that moves
 *     on its own is forbidden by the visual spec.
 *   - Tabs have an explicit affordance (four labels you can read before you
 *     click), full keyboard semantics, and no motion at all.
 *
 * Follows the WAI-ARIA tabs pattern with a roving tabindex: exactly one tab is in
 * the tab sequence, and the arrow keys move between them. RTL-aware — ArrowLeft
 * advances, because in a right-to-left row "next" is to the left.
 *
 * All four panels stay mounted (`hidden` on the inactive ones) so the markup
 * carries every caption for assistive tech and for a no-JS reader, rather than
 * only the selected one.
 */

export type ProofArea = {
  /** Short tab label — an area of the product, not a feature name. */
  label: string;
  src: string;
  alt: string;
  crop: FragmentCrop;
  /** Gate-approved caption. Never invent one here. */
  caption: string;
};

export function ProductProof({ areas }: { areas: ProofArea[] }) {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function focusTab(index: number) {
    const next = (index + areas.length) % areas.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      // RTL: the visually-next tab is to the LEFT, so ArrowLeft advances.
      case "ArrowLeft":
        event.preventDefault();
        focusTab(active + 1);
        break;
      case "ArrowRight":
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

  return (
    <div className="mt-8 sm:mt-10">
      <div className="lg:flex lg:items-start lg:gap-10">
        {/*
          Tabs. On mobile they sit above the fragment as a wrapping row; on
          desktop they become a vertical list beside it, which is what lets the
          fragment itself take the full remaining width.

          These pills are legitimate shape: they ARE the interaction. The pills
          this page refuses to reuse are the decorative ones that wrapped static
          marketing text.
        */}
        <div
          role="tablist"
          aria-label="אזורים במערכת"
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
          className="flex flex-wrap gap-2 lg:w-52 lg:shrink-0 lg:flex-col lg:gap-1.5"
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
                // Roving tabindex: only the selected tab is tabbable, arrows
                // move within the group.
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(i)}
                className="min-h-[44px] rounded-full px-4 py-2 text-sm font-semibold transition-colors lg:text-start"
                style={{
                  background: selected
                    ? "var(--dz-selection-bg)"
                    : "transparent",
                  color: selected
                    ? "var(--dz-selection-text)"
                    : "var(--dz-text-secondary)",
                  border: `1px solid ${
                    selected ? "var(--dz-selection-border)" : "var(--mkt-soft-border)"
                  }`,
                }}
              >
                {area.label}
              </button>
            );
          })}
        </div>

        <div className="mt-6 min-w-0 flex-1 lg:mt-0">
          {areas.map((area, i) => (
            <div
              key={area.label}
              role="tabpanel"
              id={`proof-panel-${i}`}
              aria-labelledby={`proof-tab-${i}`}
              // Panels are focusable so a screen-reader user landing from the
              // tab can read the fragment's caption without hunting for it.
              tabIndex={0}
              hidden={i !== active}
            >
              <ProductFragment
                src={area.src}
                alt={area.alt}
                crop={area.crop}
                // The fragment is the widest thing on the page after the text
                // column: near-full width on phones, a real column on desktop.
                sizes="(min-width: 1024px) 520px, (min-width: 640px) 70vw, 92vw"
              />
              <p className="mt-4 max-w-prose text-[15px] leading-7 text-[var(--dz-text-secondary)]">
                {area.caption}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
