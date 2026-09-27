/**
 * CONTENT SECURITY POLICY (M-8).
 *
 * The 24-hour access token lives in localStorage, so ANY script injection is
 * account takeover. This policy makes injected script not run:
 *
 *   script-src 'nonce-…' 'strict-dynamic'
 *     Only scripts carrying this response's nonce run — Next.js stamps its own
 *     framework/page scripts and inline flight data with it automatically when
 *     the request carries this header (see proxy.ts) — plus scripts THOSE load
 *     ('strict-dynamic'): the Facebook JS SDK for WhatsApp embedded signup is
 *     injected by our own bundle via createElement, so it needs no host entry
 *     in CSP3 browsers. 'self' and https://connect.facebook.net are listed only
 *     as the CSP2 fallback (ignored when 'strict-dynamic' is honoured).
 *     NO 'unsafe-inline', NO 'unsafe-eval' in production.
 *
 * DOCUMENTED EXCEPTIONS (each with its exact dependency):
 *   'wasm-unsafe-eval'  @yudiel/react-qr-scanner → barcode-detector polyfill →
 *                       zxing-wasm calls WebAssembly.instantiateStreaming on
 *                       browsers without a native BarcodeDetector (iOS Safari,
 *                       desktop Firefox). Allows WASM compilation only, not eval.
 *   connect-src https://fastly.jsdelivr.net
 *                       zxing-wasm fetches its .wasm binary from this CDN by
 *                       default (node_modules/zxing-wasm/dist/es/share.js).
 *                       RESIDUAL: self-host the .wasm and drop this origin.
 *   style-src 'unsafe-inline'
 *                       React `style={…}` attributes and several
 *                       dangerouslySetInnerHTML <style> blocks; inline styles
 *                       are not a script-execution vector.
 *   *.facebook.com / *.fbcdn.net (connect/frame/img)
 *                       the FB SDK's XHR, its hidden xd iframes and avatars
 *                       during WhatsApp embedded signup.
 *   R2 public origin (img/media)
 *                       R2_PUBLIC_BASE_URL — uploaded content/inventory media.
 *   blob: (img/media/frame/worker)
 *                       document/PDF previews via URL.createObjectURL.
 *   'unsafe-eval' + ws: DEVELOPMENT ONLY (React dev tooling / HMR).
 *
 * frame-ancestors 'self' matches the existing X-Frame-Options: SAMEORIGIN.
 * The Capacitor shell loads the app as a remote same-origin WebView
 * (server.url), so 'self' covers it; its offline error page is bundled locally
 * and never receives this header.
 */

export type CspOptions = {
  nonce: string;
  isDev: boolean;
  /** R2_PUBLIC_BASE_URL, reduced to its origin. */
  r2PublicBaseUrl?: string | null;
};

export function originOf(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy(opts: CspOptions): string {
  const r2 = originOf(opts.r2PublicBaseUrl);
  const fb = ["https://*.facebook.com", "https://connect.facebook.net"];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${opts.nonce}'`,
      "'strict-dynamic'",
      "'wasm-unsafe-eval'",
      "https://connect.facebook.net",
      ...(opts.isDev ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", ...(r2 ? [r2] : []), "https://*.facebook.com", "https://*.fbcdn.net"],
    "media-src": ["'self'", "blob:", ...(r2 ? [r2] : [])],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...fb, "https://fastly.jsdelivr.net", ...(opts.isDev ? ["ws:", "wss:"] : [])],
    "frame-src": ["'self'", "blob:", "https://*.facebook.com"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'self'"],
  };

  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

/**
 * Permissions-Policy (I-1). Camera is used by the barcode/QR scanners
 * (components/inventory/barcode-scanner.tsx, components/revenue/redeem/
 * redeem-scanner.tsx); geolocation by the coupon consumer screen
 * (components/coupon/screens/consumer-screens.tsx). Clipboard write and Web
 * Share are used and left at their defaults. Nothing uses the microphone,
 * payment, USB, serial, HID, MIDI or sensors.
 */
export const PERMISSIONS_POLICY = [
  "camera=(self)",
  "geolocation=(self)",
  "microphone=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "midi=()",
  "magnetometer=()",
  "gyroscope=()",
  "accelerometer=()",
  "browsing-topics=()",
].join(", ");
