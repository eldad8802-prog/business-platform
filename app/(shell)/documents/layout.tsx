"use client";

import { ReactNode } from "react";
import { layout } from "./ui";

export default function DocumentsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div style={layout}>
      {children}
    </div>
  );
}