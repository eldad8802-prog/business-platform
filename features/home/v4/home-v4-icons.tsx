/**
 * HOME v4 — the line icons and the secretary character, drawn to the approved reference (inline SVG: no asset
 * request, crisp at every density, colour from `currentColor`). Decorative unless a caller gives them a label.
 */
type P = { size?: number; strokeWidth?: number; className?: string };

function Svg({ size = 22, strokeWidth = 1.8, className, children }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" className={className}>
      {children}
    </svg>
  );
}

export const IconUser = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5" />
  </Svg>
);
export const IconBellLine = (p: P) => (
  <Svg {...p}>
    <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </Svg>
);
export const IconBars = (p: P) => (
  <Svg {...p}>
    <path d="M4 20h16" />
    <rect x="5.5" y="11" width="3" height="6.5" rx="1" />
    <rect x="10.5" y="5" width="3" height="12.5" rx="1" />
    <rect x="15.5" y="8.5" width="3" height="9" rx="1" />
  </Svg>
);
export const IconSliders = (p: P) => (
  <Svg {...p}>
    <path d="M4 8h9M17 8h3M4 16h3M11 16h9" />
    <circle cx="15" cy="8" r="2" />
    <circle cx="9" cy="16" r="2" />
  </Svg>
);
export const IconCoins = (p: P) => (
  <Svg {...p}>
    <ellipse cx="10" cy="6.5" rx="5.5" ry="2.5" />
    <path d="M4.5 6.5v4c0 1.4 2.5 2.5 5.5 2.5M4.5 10.5v4c0 1.4 2.5 2.5 5.5 2.5" />
    <ellipse cx="15" cy="13.5" rx="4.5" ry="2" />
    <path d="M10.5 13.5v4c0 1.1 2 2 4.5 2s4.5-.9 4.5-2v-4" />
  </Svg>
);
export const IconClipboard = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="5" width="14" height="16" rx="2.5" />
    <path d="M9 5V3.8c0-.4.4-.8.8-.8h4.4c.4 0 .8.4.8.8V5" />
    <path d="M9 11h6" />
  </Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
/** Points to the reading end of the line ("forward" in RTL = left). Mirrored by `.h4-fwd` in LTR. */
export const IconChevronForward = (p: P) => (
  <Svg className="h4-fwd" {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Svg>
);
export const IconArrowForward = (p: P) => (
  <Svg className="h4-fwd" {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);
export const IconSparkle = ({ size = 24 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
    <path d="M10 3l1.6 4.9L16.5 9.5l-4.9 1.6L10 16l-1.6-4.9L3.5 9.5l4.9-1.6z" fill="#E9B949" />
    <path d="M18 13l.9 2.6 2.6.9-2.6.9L18 20l-.9-2.6-2.6-.9 2.6-.9z" fill="#F1CC76" />
    <path d="M18.5 2.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" fill="#F1CC76" />
  </svg>
);
export const IconCalendar = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Svg>
);
export const IconCalendarCheck = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4M9 15l2 2 4-4" />
  </Svg>
);
export const IconLayers = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l9 5-9 5-9-5z" />
    <path d="M3 12.5l9 5 9-5M3 17l9 5 9-5" />
  </Svg>
);
export const IconBulb = (p: P) => (
  <Svg {...p}>
    <path d="M9 17.5h6M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2v.5h5V16c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z" />
  </Svg>
);
export const IconMore = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="18" cy="12" r="1" fill="currentColor" />
  </Svg>
);
export const IconRetry = (p: P) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
  </Svg>
);
export const IconWrench = (p: P) => (
  <Svg {...p}>
    <path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5a4 4 0 0 1-2-2z" />
  </Svg>
);
export const IconUsers = (p: P) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 19.5c.6-3 3.1-4.8 6.5-4.8s5.9 1.8 6.5 4.8M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.9c1.9.6 3.2 2.2 3.5 4.6" />
  </Svg>
);
export const IconFile = (p: P) => (
  <Svg {...p}>
    <path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </Svg>
);
export const IconWallet = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="6" width="18" height="14" rx="3" />
    <path d="M3 10h18M16 15h2" />
  </Svg>
);

/**
 * The secretary — the small friendly assistant from the approved reference: a white rounded head, a deep-teal
 * visor with smiling eyes, a teal ear, and two "speaking" strokes. Purely decorative.
 */
export function SecretaryMascot({ size = 132 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.82} viewBox="0 0 160 132" aria-hidden focusable="false" className="h4-mascot">
      <defs>
        <radialGradient id="h4-head" cx="40%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="70%" stopColor="#F4F6F3" />
          <stop offset="100%" stopColor="#DCE3DE" />
        </radialGradient>
        <linearGradient id="h4-visor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#24524E" />
          <stop offset="100%" stopColor="#14332F" />
        </linearGradient>
        <radialGradient id="h4-shadow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#2F615C" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#2F615C" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* speaking strokes */}
      <path d="M118 22l6-12M128 34l12-6M131 47h12" stroke="#1F4A46" strokeWidth="4" strokeLinecap="round" fill="none" />
      {/* ground shadow */}
      <ellipse cx="74" cy="120" rx="52" ry="8" fill="url(#h4-shadow)" />
      {/* ear */}
      <ellipse cx="22" cy="72" rx="11" ry="18" fill="#2F8F84" />
      <ellipse cx="19" cy="70" rx="5" ry="10" fill="#4FB3A6" opacity="0.7" />
      {/* head */}
      <ellipse cx="76" cy="70" rx="56" ry="48" fill="url(#h4-head)" />
      {/* visor */}
      <rect x="40" y="44" width="76" height="50" rx="25" fill="url(#h4-visor)" />
      <ellipse cx="62" cy="56" rx="14" ry="4" fill="#FFFFFF" opacity="0.12" />
      {/* eyes + smile */}
      <path d="M56 70q7-8 14 0M86 70q7-8 14 0" stroke="#7FE0D2" strokeWidth="4.5" strokeLinecap="round" fill="none" />
      <path d="M70 80q8 7 16 0" stroke="#7FE0D2" strokeWidth="4" strokeLinecap="round" fill="none" />
    </svg>
  );
}
