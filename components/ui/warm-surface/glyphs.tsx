/**
 * Small UI glyphs of the warm language — chevrons, the edit pencil, the camera,
 * contact-line marks. These are affordances, not the icon of a destination:
 * a row's own icon is always the existing colourful Dubiz icon, carried in a
 * tone tile. Paths are the approved references' own.
 */
import type { SVGProps } from "react";

type GlyphProps = SVGProps<SVGSVGElement> & { size?: number };

function Glyph({ size = 16, strokeWidth = 1.8, children, ...rest }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Points forward in RTL (towards the left). */
export function ChevronGlyph(props: GlyphProps) {
  return (
    <Glyph strokeWidth={2} {...props}>
      <path d="m15 18-6-6 6-6" />
    </Glyph>
  );
}

export function PencilGlyph(props: GlyphProps) {
  return (
    <Glyph strokeWidth={2} {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </Glyph>
  );
}

export function CameraGlyph(props: GlyphProps) {
  return (
    <Glyph strokeWidth={2} {...props}>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
      <circle cx="12" cy="13" r="3" />
    </Glyph>
  );
}

export function StoreGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M3 9l1.5-5h15L21 9" />
      <path d="M4 9v11h16V9" />
      <path d="M9 20v-6h6v6" />
    </Glyph>
  );
}

export function PinGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z" />
      <circle cx="12" cy="10" r="3" />
    </Glyph>
  );
}

export function PhoneGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
    </Glyph>
  );
}

export function MailGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </Glyph>
  );
}

export function LogoutGlyph(props: GlyphProps) {
  return (
    <Glyph strokeWidth={2} {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </Glyph>
  );
}

export function CheckGlyph(props: GlyphProps) {
  return (
    <Glyph strokeWidth={2.2} {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Glyph>
  );
}
