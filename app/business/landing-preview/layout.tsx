import type { Metadata } from "next";

/**
 * P3-D — the owner landing preview is private: never indexed, never followed. (The page itself is
 * owner-authenticated; there is no public landing route in P3-D.)
 */
export const metadata: Metadata = {
  title: "תצוגה מקדימה של דף הנחיתה",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function LandingPreviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
