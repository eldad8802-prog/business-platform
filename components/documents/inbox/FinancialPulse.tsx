"use client";

import type { InboxFinancialPulse } from "@/lib/documents/inbox-types";
import { TOKEN } from "@/lib/design/documents-theme";
import { useI18n } from "@/components/i18n/I18nProvider";

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
        borderInlineEnd: "1px solid rgba(52, 60, 50, 0.12)",
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
  const { t, formatAmount } = useI18n();
  if (!pulse) return null;
  // Same output as the previous local `₪` + he-IL formatter (ILS, max 2 fraction digits).
  const fmtMoney = (n: number) => formatAmount(n, "ILS");

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
        label={t("documents.inbox.pulseIncome")}
        value={fmtMoney(fromFinancialRecords.income)}
        valueColor={TOKEN.semantic.success.ink}
        icon="↑"
      />
      <StatCell
        label={t("documents.inbox.pulseExpense")}
        value={fmtMoney(fromFinancialRecords.expense)}
        valueColor={TOKEN.semantic.urgent.ink}
        icon="↓"
      />
      <StatCell
        label={t("documents.inbox.pulseBalance")}
        value={fmtMoney(net)}
        valueColor={net >= 0 ? TOKEN.semantic.success.ink : TOKEN.semantic.urgent.ink}
        icon="="
      />
      <StatCell
        label={t("documents.inbox.pulsePending")}
        value={inboxDocumentCounts.pendingReview}
        valueColor={TOKEN.semantic.attention.ink}
        icon="⏳"
      />
    </div>
  );
}
