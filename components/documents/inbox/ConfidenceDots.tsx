"use client";

import type { InboxConfidenceDots } from "@/lib/documents/inbox-types";
import { TOKEN } from "@/lib/design/documents-theme";

const DOT_COLOR: Record<
  InboxConfidenceDots[keyof InboxConfidenceDots],
  string
> = {
  high: TOKEN.semantic.success.accent,
  medium: TOKEN.semantic.attention.accent,
  low: TOKEN.semantic.urgent.accent,
};

const DOT_LABEL: Record<
  InboxConfidenceDots[keyof InboxConfidenceDots],
  string
> = {
  high: "גבוהה",
  medium: "בינונית",
  low: "נמוכה",
};

function Dot({
  label,
  level,
}: {
  label: string;
  level: InboxConfidenceDots[keyof InboxConfidenceDots];
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        borderRadius: 999,
        background: `${DOT_COLOR[level]}14`,
        border: `1px solid ${DOT_COLOR[level]}33`,
        fontSize: 11,
        fontWeight: 600,
        color: DOT_COLOR[level],
        whiteSpace: "nowrap",
      }}
      title={`${label}: מהימנות ${DOT_LABEL[level]}`}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: DOT_COLOR[level],
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}

export default function ConfidenceDots({ dots }: { dots: InboxConfidenceDots }) {
  return (
    <div
      dir="rtl"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 5,
        marginTop: 8,
      }}
    >
      <Dot label="סכום" level={dots.amount} />
      <Dot label="ספק" level={dots.vendor} />
      <Dot label="תאריך" level={dots.dateProxy} />
    </div>
  );
}
