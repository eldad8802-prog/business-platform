"use client";

import { ReactNode } from "react";
import { layout } from "./ui";

// Heebo is loaded globally (app/layout.tsx exposes --font-heebo app-wide), so
// the Documents feature simply inherits it — no scoped font loader here. The
// `layout` style re-asserts the Heebo stack and the font-synthesis guard.
export default function DocumentsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <div style={layout}>{children}</div>;
}
