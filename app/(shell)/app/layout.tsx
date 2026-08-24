import type { Metadata } from "next";
import type { ReactNode } from "react";

// Metadata-only wrapper for the home section so the browser tab reads
// "בית · Dubiz". The home page itself is a client component and cannot export
// metadata; this server layout carries the title and passes children through
// unchanged (no chrome — the (shell) layout already provides it).
export const metadata: Metadata = { title: "בית" };

export default function HomeSectionLayout({ children }: { children: ReactNode }) {
  return children;
}
