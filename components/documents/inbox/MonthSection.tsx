"use client";

import type { ReactNode } from "react";

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
      <div
        style={{
          fontSize: 12,
          fontWeight: 950,
          color: "#64748b",
          marginBottom: 10,
          marginTop: 2,
        }}
      >
        {formatMonthHeading(monthKey)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {children}
      </div>
    </section>
  );
}
