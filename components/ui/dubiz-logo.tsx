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
