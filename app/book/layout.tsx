import type { Metadata } from "next";

/**
 * The public booking pages (Milestone C, segment 3): opened by a business's customers, with no Dubiz account. Never
 * indexed, never send a referrer. Outside the app shell; while public booking is not open for a business, its link
 * answers "unavailable".
 */
export const metadata: Metadata = {
  title: "הזמנת תור",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function PublicBookingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
