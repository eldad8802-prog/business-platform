/**
 * SVG icon set for the Documents home screen — replaces the previous emoji
 * (📤 📷 📧 💬 📥 🔍 📊). UI icons use `currentColor` so they inherit the DS
 * token color of their container. Brand logos (Gmail / WhatsApp) intentionally
 * keep their official brand colors — brand marks are a governed exception to the
 * DS palette (see `TOKEN.brand.whatsapp.green`).
 */

type IconProps = { className?: string };

/** Upload — tray with up arrow (primary capture CTA). */
export function UploadIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 16V4m0 0L7 9m5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" strokeLinecap="round" />
    </svg>
  );
}

/** Camera — document photo capture. */
export function CameraIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path
        d="M4 8a2 2 0 0 1 2-2h1.5l1.2-1.8A1 1 0 0 1 9.5 4h5a1 1 0 0 1 .8.4L16.5 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12.5" r="3.2" />
    </svg>
  );
}

/** Review queue — duotone document with a check. */
export function ReviewQueueIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6.5 3h6L18 8.5V19a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
        fill="currentColor"
        fillOpacity="0.16"
      />
      <path d="M12.5 3v5H18" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path
        d="M8.4 13.6l2.1 2.1 4.2-4.4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Search — duotone magnifier. */
export function SearchIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6.5" fill="currentColor" fillOpacity="0.16" />
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M20.5 20.5l-4.6-4.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Accountant pack — duotone box/package. */
export function AccountantPackIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3l8 4.3v9.4L12 21l-8-4.3V7.3L12 3z" fill="currentColor" fillOpacity="0.16" />
      <path d="M12 3l8 4.3v9.4L12 21l-8-4.3V7.3L12 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M4 7.3l8 4.3 8-4.3M12 11.6V21" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 5.2l8 4.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Chevron pointing to the row target (RTL: points left/inward). */
export function ChevronIcon({ className }: IconProps) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Official Gmail logo (multicolor envelope). Brand colors — not DS tokens. */
export function GmailLogo({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 52 40" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path fill="#4285F4" d="M3.5 40h9V18L0 8.5v28C0 38.4 1.6 40 3.5 40z" />
      <path fill="#34A853" d="M39.5 40h9c1.9 0 3.5-1.6 3.5-3.5v-28L39.5 18z" />
      <path fill="#FBBC04" d="M39.5 3.5V18L52 8.5V5.25c0-4.2-4.8-6.55-8.1-4.1z" />
      <path fill="#EA4335" d="M12.5 18V3.5L26 13.6 39.5 3.5V18L26 28.1z" />
      <path fill="#C5221F" d="M0 5.25V8.5L12.5 18V3.5L8.1 1.15C4.8-1.3 0 1.05 0 5.25z" />
    </svg>
  );
}

/** Official WhatsApp glyph (brand green). Brand color — not a DS token. */
export function WhatsappLogo({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        fill="#25D366"
        d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.149-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"
      />
      <path
        fill="#25D366"
        d="M20.52 3.449C12.831-3.984.106 1.407.101 11.893c0 2.096.549 4.14 1.595 5.945L0 24l6.335-1.652a11.882 11.882 0 005.71 1.454h.006c9.99 0 15.44-11.803 8.469-18.353zm-8.463 18.297h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.002-8.816 10.771-13.23 17.002-6.997 6.211 6.171 1.797 16.988-7.117 16.988z"
      />
    </svg>
  );
}
