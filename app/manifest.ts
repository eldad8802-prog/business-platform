import type { MetadataRoute } from "next";

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
    background_color: "#f8f6f1",
    theme_color: "#0f766e",
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
