"use client";

import type { CSSProperties } from "react";
import type { InboxFinancialPulse } from "@/lib/documents/inbox-types";

const WRAP: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 20,
  background: "#f8fafc",
  paddingBottom: 10,
  marginBottom: 4,
};

const CARD: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 22,
  padding: 14,
  boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
};

const GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
};

const TILE: CSSProperties = {
  background: "#f9fafb",
  borderRadius: 16,
  padding: 12,
  border: "1px solid #e5e7eb",
  minWidth: 0,
};

const LABEL: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: "#6b7280",
  marginBottom: 4,
};

const VALUE: CSSProperties = {
  fontSize: 16,
  fontWeight: 950,
  color: "#111827",
};

function fmtMoney(n: number) {
  return `₪${n.toLocaleString("he-IL", { maximumFractionDigits: 2 })}`;
}

export default function FinancialPulse({
  pulse,
}: {
  pulse: InboxFinancialPulse | null;
}) {
  if (!pulse) {
    return (
      <div style={WRAP}>
        <div style={CARD}>
          <div style={{ fontSize: 14, color: "#6b7280" }}>טוען סיכום…</div>
        </div>
      </div>
    );
  }

  const { fromFinancialRecords, inboxDocumentCounts } = pulse;
  const { income, expense, net, recordCount } = fromFinancialRecords;

  return (
    <div style={WRAP}>
      <div style={CARD}>
        <div style={GRID}>
          <div style={TILE}>
            <div style={LABEL}>הכנסות</div>
            <div style={{ ...VALUE, color: "#047857" }}>{fmtMoney(income)}</div>
          </div>
          <div style={TILE}>
            <div style={LABEL}>הוצאות</div>
            <div style={{ ...VALUE, color: "#b91c1c" }}>{fmtMoney(expense)}</div>
          </div>
          <div style={{ ...TILE, gridColumn: "1 / -1" }}>
            <div style={LABEL}>מאזן</div>
            <div
              style={{
                ...VALUE,
                color: net >= 0 ? "#047857" : "#b91c1c",
              }}
            >
              {fmtMoney(net)}
            </div>
          </div>
        </div>
        <div
          style={{
            marginTop: 12,
            fontSize: 12,
            fontWeight: 800,
            color: "#6b7280",
          }}
        >
          רשומות מאושרות בתקופה: {recordCount} · ממתינים בתיבה:{" "}
          {inboxDocumentCounts.pendingReview} · מאושרים בתיבה:{" "}
          {inboxDocumentCounts.approvedDocuments}
        </div>
      </div>
    </div>
  );
}
