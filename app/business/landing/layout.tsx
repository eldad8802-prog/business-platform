import type { Metadata } from "next";

/** P3-E — the owner's landing versions are private: never indexed, never followed. */
export const metadata: Metadata = {
  title: "דף הנחיתה · גרסאות",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function LandingVersionsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
