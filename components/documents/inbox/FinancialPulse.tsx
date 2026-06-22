"use client";

import type { InboxFinancialPulse } from "@/lib/documents/inbox-types";
import { TOKEN } from "@/lib/design/tokens";

function fmtMoney(n: number) {
  return `₪${n.toLocaleString("he-IL", { maximumFractionDigits: 2 })}`;
}

function StatCell({
  label,
  value,
  valueColor,
  icon,
}: {
  label: string;
  value: string | number;
  valueColor: string;
  icon: string;
}) {
  return (
    <div
      style={{
        flex: "1 1 70px",
        minWidth: 0,
        padding: "10px 14px",
        borderLeft: "1px solid rgba(15, 23, 42, 0.06)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          marginBottom: 3,
        }}
      >
        <span style={{ fontSize: 13 }}>{icon}</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: TOKEN.weight.bold,
            color: TOKEN.ink.meta,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: TOKEN.weight.bold,
          color: valueColor,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </div>
    </div>
  );
}

export default function FinancialPulse({
  pulse,
}: {
  pulse: InboxFinancialPulse | null;
}) {
  if (!pulse) return null;

  const { fromFinancialRecords, inboxDocumentCounts } = pulse;
  const net = fromFinancialRecords.net;

  return (
    <div
      style={{
        background: TOKEN.surface.card,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: TOKEN.radius.card,
        display: "flex",
        overflowX: "auto",
        boxShadow: TOKEN.shadow.elevated,
      }}
    >
      <StatCell
        label="הכנסות"
        value={fmtMoney(fromFinancialRecords.income)}
        valueColor={TOKEN.semantic.success.ink}
        icon="↑"
      />
      <StatCell
        label="הוצאות"
        value={fmtMoney(fromFinancialRecords.expense)}
        valueColor={TOKEN.semantic.urgent.ink}
        icon="↓"
      />
      <StatCell
        label="מאזן"
        value={fmtMoney(net)}
        valueColor={net >= 0 ? TOKEN.semantic.success.ink : TOKEN.semantic.urgent.ink}
        icon="="
      />
      <StatCell
        label="ממתינים"
        value={inboxDocumentCounts.pendingReview}
        valueColor={TOKEN.semantic.attention.ink}
        icon="⏳"
      />
    </div>
  );
}
