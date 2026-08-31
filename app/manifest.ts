import type { MetadataRoute } from "next";
import { MIST_FLAT } from "@/lib/design/mist";

/**
 * PWA web manifest (Milestone A) — isolated & cheap: metadata + installability
 * only, NO service worker / offline caching. Capacitor remains the canonical
 * store packaging path; this manifest just gives the web app proper identity
 * (name/icons/theme) and keeps a future TWA option open for Android. Served by
 * Next at /manifest.webmanifest via the app/manifest.ts convention (no layout
 * change).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dubiz",
    short_name: "Dubiz",
    description: "Dubiz — ניהול היום־יום של העסק",
    start_url: "/app",
    display: "standalone",
    // The web-app manifest is JSON consumed by the OS, not CSS — a custom
    // property would be an invalid colour here. Read the FLAT Mist values.
    background_color: MIST_FLAT.background,
    theme_color: MIST_FLAT.brand,
    dir: "rtl",
    lang: "he",
    icons: [
      {
        src: "/dubiz-mark.png",
        sizes: "any",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
