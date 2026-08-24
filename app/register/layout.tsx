import type { Metadata } from "next";
import type { ReactNode } from "react";

// The register page is a client component and cannot export metadata; this
// server layout carries the tab title ("הרשמה · Dubiz") and passes children.
export const metadata: Metadata = { title: "הרשמה" };

export default function RegisterLayout({ children }: { children: ReactNode }) {
  return children;
}
