import type { Metadata } from "next";

/** The accountant's download page is private by nature: never indexed, never sends a referrer. */
export const metadata: Metadata = {
  title: "חבילת מסמכים לרואה החשבון",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function AccountantLinkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
