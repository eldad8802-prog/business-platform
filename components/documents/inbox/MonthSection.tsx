"use client";

import type { ReactNode } from "react";

const TITLE_STYLE: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 950,
  color: "#374151",
  marginBottom: 10,
  marginTop: 8,
};

export function formatMonthHeading(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("he-IL", { month: "long", year: "numeric" });
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
      <h2 style={TITLE_STYLE}>{formatMonthHeading(monthKey)}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {children}
      </div>
    </section>
  );
}
