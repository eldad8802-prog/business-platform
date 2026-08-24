import type { Metadata } from "next";
import { ReactNode } from "react";
import { layout } from "./ui";

// Server layout (pure presentational wrapper — no client APIs) so it can carry
// the section title. Heebo is loaded globally (app/layout.tsx exposes
// --font-heebo app-wide), so the Documents feature simply inherits it — no
// scoped font loader here. The `layout` style re-asserts the Heebo stack and
// the font-synthesis guard.
export const metadata: Metadata = { title: "מסמכים" };

export default function DocumentsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <div style={layout}>{children}</div>;
}
