/**
 * SVG icons for the public (Corporate) chrome.
 *
 * Replaces the `☰` text glyph that was serving as the mobile menu control. A
 * glyph is a CHARACTER: it inherits font metrics, renders differently per
 * platform font stack, is read aloud by some screen readers, and cannot be sized
 * or stroked to match the rest of the UI. These follow the established Dubiz icon
 * convention (see `components/documents/home/home-icons.tsx`): a 24-box viewBox,
 * `currentColor` so the icon inherits its container's Mist token, and `aria-hidden`
 * because the accessible name always lives on the control that wraps them.
 */

type IconProps = { className?: string };

/** Menu — three rules. Opens the mobile navigation drawer. */
export function MenuIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

/** Close — the same control once the drawer is open. */
export function CloseIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
