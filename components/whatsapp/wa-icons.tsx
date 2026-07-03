/**
 * Presentational SVGs for the WhatsApp connection screens. No logic, no state.
 *
 * - `WhatsAppGlyph` is an APPROXIMATION of the WhatsApp mark (per the build
 *   spec §9 — production should drop in the licensed brand asset after Meta
 *   Brand Review). Its two fills are passed in from token values by the caller,
 *   so no color is hardcoded here.
 * - The line icons inherit `currentColor` (stroke), so the caller sets the
 *   color from a token on the wrapping element.
 */

type GlyphProps = {
  size?: number;
  /** Fill of the rounded speech-bubble (usually white / ink.inverse). */
  circle: string;
  /** Fill of the handset (usually WhatsApp green). */
  handset: string;
};

export function WhatsAppGlyph({ size = 24, circle, handset }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <path
        d="M16 4C9.4 4 4 9.4 4 16c0 2.2.6 4.3 1.6 6.1L4 28.4l6.5-1.7c1.7 1 3.6 1.5 5.5 1.5 6.6 0 12-5.4 12-12S22.6 4 16 4z"
        fill={circle}
      />
      <path
        d="M12.2 10.6c-.24 0-.62.09-.95.45-.33.36-1.27 1.24-1.27 3.02 0 1.78 1.3 3.5 1.48 3.74.18.24 2.51 3.99 6.2 5.44 3.07 1.2 3.69.96 4.36.9.67-.06 2.15-.88 2.46-1.73.3-.85.3-1.58.21-1.73-.09-.15-.33-.24-.7-.42-.36-.18-2.15-1.06-2.48-1.18-.33-.12-.58-.18-.82.18-.24.36-.94 1.18-1.15 1.42-.21.24-.42.27-.79.09-.36-.18-1.53-.56-2.91-1.8-1.08-.96-1.8-2.15-2.02-2.51-.21-.36-.02-.56.16-.74.16-.16.36-.42.55-.63.18-.21.24-.36.36-.6.12-.24.06-.45-.03-.63-.09-.18-.8-1.98-1.1-2.71-.29-.71-.58-.61-.8-.62z"
        fill={handset}
      />
    </svg>
  );
}

function LineIcon({
  size = 20,
  children,
}: {
  size?: number;
  children: React.ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconLock({ size }: { size?: number }) {
  return (
    <LineIcon size={size}>
      <rect x="4" y="11" width="16" height="10" rx="2.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </LineIcon>
  );
}

export function IconRefresh({ size }: { size?: number }) {
  return (
    <LineIcon size={size}>
      <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" />
    </LineIcon>
  );
}

export function IconSwap({ size }: { size?: number }) {
  return (
    <LineIcon size={size}>
      <path d="M7 8l-3 3 3 3M4 11h13M17 16l3-3-3-3M20 13H8" />
    </LineIcon>
  );
}

export function IconPower({ size }: { size?: number }) {
  return (
    <LineIcon size={size}>
      <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64M12 2v10" />
    </LineIcon>
  );
}

/** Chevron pointing to the inline-start (left in RTL) — "drill in" affordance. */
export function IconChevronStart({ size }: { size?: number }) {
  return (
    <LineIcon size={size}>
      <path d="M15 6l-6 6 6 6" />
    </LineIcon>
  );
}

export function IconAlertTriangle({ size }: { size?: number }) {
  return (
    <LineIcon size={size}>
      <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </LineIcon>
  );
}

export function IconCheck({ size }: { size?: number }) {
  return (
    <LineIcon size={size}>
      <path d="M20 6L9 17l-5-5" />
    </LineIcon>
  );
}

export function IconSearch({ size }: { size?: number }) {
  return (
    <LineIcon size={size}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4-4" />
    </LineIcon>
  );
}
