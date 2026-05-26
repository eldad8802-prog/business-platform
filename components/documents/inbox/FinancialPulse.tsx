"use client";

import type { InboxFinancialPulse } from "@/lib/documents/inbox-types";

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
            fontWeight: 800,
            color: "#9ca3af",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 900,
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
        background: "#ffffff",
        border: "1px solid #dfe7f3",
        borderRadius: 14,
        display: "flex",
        overflowX: "auto",
        boxShadow: "0 8px 24px rgba(15, 23, 42, 0.04)",
      }}
    >
      <StatCell
        label="הכנסות"
        value={fmtMoney(fromFinancialRecords.income)}
        valueColor="#047857"
        icon="↑"
      />
      <StatCell
        label="הוצאות"
        value={fmtMoney(fromFinancialRecords.expense)}
        valueColor="#b91c1c"
        icon="↓"
      />
      <StatCell
        label="מאזן"
        value={fmtMoney(net)}
        valueColor={net >= 0 ? "#047857" : "#b91c1c"}
        icon="="
      />
      <StatCell
        label="ממתינים"
        value={inboxDocumentCounts.pendingReview}
        valueColor="#d97706"
        icon="⏳"
      />
    </div>
  );
}
