"use client";

import type { ReactNode } from "react";
import { TOKEN } from "@/lib/design/documents-theme";

export function formatMonthHeading(ym: string): string {
  const [year, month] = ym.split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return ym;
  return new Date(year, month - 1, 1).toLocaleDateString("he-IL", {
    month: "long",
    year: "numeric",
  });
}

export default function MonthSection({
  monthKey,
  children,
}: {
  monthKey: string;
  children: ReactNode;
}) {
  return (
    <section dir="rtl">
      <h2 style={headingStyle}>{formatMonthHeading(monthKey)}</h2>
      <div style={listStyle}>{children}</div>
    </section>
  );
}

const headingStyle = {
  margin: "0 0 10px",
  color: TOKEN.ink.secondary,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
} as const;

const listStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
} as const;
