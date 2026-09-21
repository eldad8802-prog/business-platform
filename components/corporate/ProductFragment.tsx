import Image from "next/image";

/**
 * ProductFragment — a semantic crop of a real Dubiz screen.
 *
 * ## Why this exists
 *
 * Both previous homepages showed product screenshots that could not be read.
 * `/home` rendered whole 780×1688 phone screens at 220 CSS px, so every label
 * inside them was roughly five pixels tall: the image stopped functioning as
 * evidence and became texture — under a heading that claims "this is not a
 * presentation, it already works". V2.1 improved on it with a crop, but the crop
 * was a fixed `h-[196px]` box, which at its render width landed mid-way through
 * the collection screen's amount row and read as a rendering bug.
 *
 * The rule this component enforces: **product UI is readable, or it is not
 * shown**, and a crop ends on a component boundary — never through a line of
 * text, never through an amount row, and never hidden behind a fade.
 *
 * ## How the crop works
 *
 * A crop is declared in SOURCE pixels (what you measure on the asset itself),
 * not in CSS pixels, so it stays correct at every render width.
 *
 *   - The box takes `aspect-ratio: SOURCE_WIDTH / cropHeight`, so its height
 *     always tracks its width. That also reserves the space before the image
 *     loads, so there is no layout shift.
 *   - The image fills the box with `object-fit: cover`. Because the box is much
 *     wider-per-height than the tall source, `cover` scales on WIDTH, and the
 *     surplus height is what gets clipped.
 *   - `object-position: center Y%` picks which slice survives. The browser reads
 *     Y% as "align the point Y% down the image with the point Y% down the box",
 *     which resolves to an offset of `(imageHeight - boxHeight) × Y%`. Setting
 *     that offset equal to `cropTop` gives:
 *
 *         Y% = cropTop / (SOURCE_HEIGHT - cropHeight) × 100
 *
 *     Both sides scale with the render width, so the identity holds at any size.
 */

/** Intrinsic size of every asset in `public/landing` (verified, not assumed). */
const SOURCE = { width: 780, height: 1688 } as const;

export type FragmentCrop = {
  /** First visible SOURCE row. Must sit in a gap between components. */
  top: number;
  /** First row BELOW the fragment. Must sit in a gap between components. */
  bottom: number;
};

export function ProductFragment({
  src,
  alt,
  crop,
  sizes,
  priority = false,
}: {
  src: string;
  alt: string;
  crop: FragmentCrop;
  sizes: string;
  priority?: boolean;
}) {
  const cropHeight = crop.bottom - crop.top;

  // Guard the maths rather than trusting call sites: a full-height crop would
  // divide by zero, and an inverted one would silently render the wrong slice.
  const slack = SOURCE.height - cropHeight;
  const objectPositionY = slack > 0 ? (crop.top / slack) * 100 : 0;

  return (
    <div
      className="overflow-hidden rounded-[20px] border border-[var(--mkt-soft-border)]"
      style={{
        aspectRatio: `${SOURCE.width} / ${cropHeight}`,
        // A calm Mist ground behind the image while it decodes — never a flash
        // of white, which would not belong to the palette.
        background: "var(--dz-surface-muted)",
      }}
    >
      <Image
        src={src}
        alt={alt}
        width={SOURCE.width}
        height={SOURCE.height}
        sizes={sizes}
        priority={priority}
        loading={priority ? undefined : "lazy"}
        className="h-full w-full"
        style={{
          objectFit: "cover",
          objectPosition: `center ${objectPositionY}%`,
        }}
      />
    </div>
  );
}
