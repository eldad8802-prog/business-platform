"use client";

import type { InboxConfidenceDots } from "@/lib/documents/inbox-types";

const DOT_COLOR: Record<
  InboxConfidenceDots[keyof InboxConfidenceDots],
  string
> = {
  high: "#047857",
  medium: "#d97706",
  low: "#b91c1c",
};

const ROW_STYLE = {
  display: "flex" as const,
  alignItems: "center" as const,
  gap: 8,
  marginTop: 8,
};

const LABEL_STYLE = {
  fontSize: 11,
  fontWeight: 800,
  color: "#6b7280",
  width: 52,
  flexShrink: 0,
};

function Dot({ level }: { level: InboxConfidenceDots[keyof InboxConfidenceDots] }) {
  return (
    <span
      aria-hidden
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        background: DOT_COLOR[level],
        flexShrink: 0,
      }}
    />
  );
}

export default function ConfidenceDots({ dots }: { dots: InboxConfidenceDots }) {
  return (
    <div dir="rtl" style={{ marginTop: 6 }}>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>סכום</span>
        <Dot level={dots.amount} />
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>ספק</span>
        <Dot level={dots.vendor} />
      </div>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>תאריך</span>
        <Dot level={dots.dateProxy} />
      </div>
    </div>
  );
}
