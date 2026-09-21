import Image from "next/image";

/**
 * ProductFragment — one real Dubiz screen, shown at a size that can be read.
 *
 * The rule this component serves: **product UI is readable, or it is not
 * shown**, and a fragment ends on a component boundary — never through a line
 * of text or an amount row, and never behind a fade.
 *
 * The assets under `public/landing/proof/` are ALREADY semantic crops, cut by
 * `scripts/qa/ui/homepage-proof-capture.mjs` at gaps it measures in the rendered
 * DOM, captured at 390 CSS px × DPR 3 (1170 px wide). So this component does no
 * cropping of its own: it renders the file at its true intrinsic size, and the
 * browser scales it down only — at the ≤520 px stage that is ≥2.25 device
 * pixels per CSS pixel, sharp on a DPR-2 screen.
 *
 * Served `unoptimized`: the files are already WebP q85 at 32–50 KB, and Next
 * 16 only allows quality 75 by default — re-encoding would soften exactly the
 * small UI text this exists to show. (No global images config is changed.)
 *
 * `width`/`height` are the asset's real pixel dimensions (they differ per
 * asset). They reserve the box before the image decodes, so there is no layout
 * shift, and they are never stretched: the image is `w-full h-auto`.
 */
export function ProductFragment({
  src,
  alt,
  width,
  height,
  sizes,
  priority = false,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  sizes: string;
  priority?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-[var(--mkt-radius-object)] bg-[var(--dz-background)] ring-1 ring-[var(--mkt-stage-line)]">
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        sizes={sizes}
        priority={priority}
        unoptimized
        className="block h-auto w-full"
      />
    </div>
  );
}
