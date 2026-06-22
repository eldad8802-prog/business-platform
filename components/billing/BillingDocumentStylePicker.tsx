"use client";

import type { CSSProperties } from "react";
import {
  BILLING_PDF_TEMPLATE_STYLES,
  type BillingPdfTemplateStyle,
  BILLING_PDF_TEMPLATE_STYLE_HINTS_HE,
  BILLING_PDF_TEMPLATE_STYLE_LABELS_HE,
} from "@/lib/billing/billing-pdf-template-style";

function MiniPreview({ style }: { style: BillingPdfTemplateStyle }) {
  const commonBox: CSSProperties = {
    borderRadius: 8,
    overflow: "hidden",
    border: "1px solid #e2e8f0",
    background: "#fff",
    height: 72,
    display: "flex",
    flexDirection: "column",
    padding: style === "COMPACT" ? "6px 8px" : "8px 10px",
    gap: style === "COMPACT" ? 4 : 6,
  };

  const headerBar =
    style === "MODERN" ? (
      <div
        style={{
          height: 5,
          background: "linear-gradient(90deg,#2563eb,#7c3aed)",
          borderRadius: 3,
          marginBottom: 2,
        }}
      />
    ) : null;

  const titleW =
    style === "MODERN" ? "62%" : style === "COMPACT" ? "48%" : "52%";
  const rowH = style === "COMPACT" ? 5 : 7;

  return (
    <div style={commonBox}>
      {headerBar}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <div
          style={{
            width: titleW,
            height: style === "MODERN" ? 11 : 9,
            background: "#0f172a",
            borderRadius: 3,
            opacity: style === "MODERN" ? 1 : 0.85,
          }}
        />
        <div style={{ flex: 1 }} />
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: "#cbd5e1",
          }}
        />
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
        <div
          style={{
            flex: 1,
            height: style === "COMPACT" ? 28 : 34,
            background: "#f8fafc",
            border: "1px solid #e5e7eb",
            borderRadius: style === "MODERN" ? 6 : 2,
            boxShadow:
              style === "MODERN"
                ? "0 1px 2px rgba(15,23,42,0.06)"
                : undefined,
          }}
        />
        <div
          style={{
            flex: 1,
            height: style === "COMPACT" ? 28 : 34,
            background: "#f8fafc",
            border: "1px solid #e5e7eb",
            borderRadius: style === "MODERN" ? 6 : 2,
            boxShadow:
              style === "MODERN"
                ? "0 1px 2px rgba(15,23,42,0.06)"
                : undefined,
          }}
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ height: rowH, background: "#f1f5f9", borderRadius: 2 }} />
        <div style={{ height: rowH, background: "#fbfdff", borderRadius: 2 }} />
        {style === "COMPACT" ? (
          <div style={{ height: rowH, background: "#f1f5f9", borderRadius: 2 }} />
        ) : null}
      </div>
    </div>
  );
}

export function BillingDocumentStylePicker({
  value,
  onChange,
}: {
  value: BillingPdfTemplateStyle;
  onChange: (next: BillingPdfTemplateStyle) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "#0f172a",
            marginBottom: 4,
          }}
        >
          סגנון המסמך ללקוח
        </div>
        <p style={{ margin: 0, fontSize: 12, color: "#64748b", lineHeight: 1.45 }}>
          בחירה זו תשמש מסמכים חדשים בלבד. אפשר לשנות אותה בהמשך בלי להשפיע על
          מסמכים שכבר הופקו.
        </p>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: 10,
        }}
      >
        {BILLING_PDF_TEMPLATE_STYLES.map((style) => {
          const selected = value === style;
          return (
            <button
              key={style}
              type="button"
              onClick={() => onChange(style)}
              style={{
                textAlign: "right",
                cursor: "pointer",
                padding: 10,
                borderRadius: 12,
                border: selected ? "2px solid #3F619C" : "1px solid #e2e8f0",
                background: selected ? "#EEF3F9" : "#fff",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                font: "inherit",
              }}
            >
              <MiniPreview style={style} />
              <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
                {BILLING_PDF_TEMPLATE_STYLE_LABELS_HE[style]}
              </span>
              <span style={{ fontSize: 11, color: "#64748b", lineHeight: 1.35 }}>
                {BILLING_PDF_TEMPLATE_STYLE_HINTS_HE[style]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
