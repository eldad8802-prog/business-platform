import Image from "next/image";

/**
 * DubizLogo — the official Dubiz brand lockup (dot-matrix "D" + wordmark).
 *
 * Renders `/public/dubiz-logo.png` (transparent, turquoise brand palette) via
 * next/image at a fixed height, deriving the width from the asset's intrinsic
 * ratio (827×266 ≈ 3.109:1) so it never distorts. `width:auto` keeps it sharp
 * and undistorted across breakpoints; the source is high-res enough for retina.
 */
const LOGO_RATIO = 827 / 266;
/** `/public/dubiz-mark.png` — the dot-matrix "D" alone (303×261), for spaces too narrow for the lockup. */
const MARK_RATIO = 303 / 261;

export function DubizLogo({
  height = 40,
  priority = false,
}: {
  height?: number;
  priority?: boolean;
}) {
  const width = Math.round(height * LOGO_RATIO);
  return (
    <Image
      src="/dubiz-logo.png"
      alt="Dubiz"
      width={width}
      height={height}
      priority={priority}
      style={{ height, width: "auto", objectFit: "contain", display: "block" }}
    />
  );
}

/**
 * DubizMark — the official dot-matrix "D" without the wordmark (narrow rails, compact
 * headers). Decorative by default: callers that use it as the only brand signal pass `alt`.
 */
export function DubizMark({
  height = 32,
  alt = "",
  priority = false,
}: {
  height?: number;
  alt?: string;
  priority?: boolean;
}) {
  const width = Math.round(height * MARK_RATIO);
  return (
    <Image
      src="/dubiz-mark.png"
      alt={alt}
      width={width}
      height={height}
      priority={priority}
      style={{ height, width: "auto", objectFit: "contain", display: "block" }}
    />
  );
}
