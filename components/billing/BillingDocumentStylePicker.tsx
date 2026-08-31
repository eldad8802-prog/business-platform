"use client";

import type { CSSProperties } from "react";
import {
  BILLING_PDF_TEMPLATE_STYLES,
  type BillingPdfTemplateStyle,
  BILLING_PDF_TEMPLATE_STYLE_HINTS_HE,
  BILLING_PDF_TEMPLATE_STYLE_LABELS_HE,
} from "@/lib/billing/billing-pdf-template-style";
import { TOKEN } from "@/lib/design/billing-theme";

function MiniPreview({ style }: { style: BillingPdfTemplateStyle }) {
  const commonBox: CSSProperties = {
    borderRadius: 8,
    overflow: "hidden",
    border: "1px solid var(--dz-border)",
    background: "var(--dz-surface)",
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
          background: "linear-gradient(90deg,var(--dz-info-accent),var(--dz-brand))",
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
            background: "var(--dz-text-primary)",
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
            background: "var(--dz-text-disabled)",
          }}
        />
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
        <div
          style={{
            flex: 1,
            height: style === "COMPACT" ? 28 : 34,
            background: "var(--dz-surface-muted)",
            border: "1px solid var(--dz-border)",
            borderRadius: style === "MODERN" ? 6 : 2,
            boxShadow:
              style === "MODERN"
                ? "0 1px 2px rgba(52, 60, 50, 0.06)"
                : undefined,
          }}
        />
        <div
          style={{
            flex: 1,
            height: style === "COMPACT" ? 28 : 34,
            background: "var(--dz-surface-muted)",
            border: "1px solid var(--dz-border)",
            borderRadius: style === "MODERN" ? 6 : 2,
            boxShadow:
              style === "MODERN"
                ? "0 1px 2px rgba(52, 60, 50, 0.06)"
                : undefined,
          }}
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ height: rowH, background: "var(--dz-surface-muted)", borderRadius: 2 }} />
        <div style={{ height: rowH, background: "var(--dz-surface)", borderRadius: 2 }} />
        {style === "COMPACT" ? (
          <div style={{ height: rowH, background: "var(--dz-surface-muted)", borderRadius: 2 }} />
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
            fontWeight: 600,
            color: TOKEN.ink.primary,
            marginBottom: 4,
          }}
        >
          סגנון המסמך ללקוח
        </div>
        <p style={{ margin: 0, fontSize: 12, color: TOKEN.ink.muted, lineHeight: 1.45 }}>
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
                borderRadius: TOKEN.radius.button,
                border: selected ? TOKEN.action.primary.border : TOKEN.action.glass.border,
                background: selected ? TOKEN.action.primary.background : TOKEN.action.glass.background,
                color: selected ? TOKEN.action.primary.color : "inherit",
                boxShadow: selected ? TOKEN.action.primary.shadowSoft : TOKEN.action.glass.shadow,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                font: "inherit",
              }}
            >
              <MiniPreview style={style} />
              <span style={{ fontSize: 13, fontWeight: 600, color: selected ? TOKEN.ink.inverse : TOKEN.ink.primary }}>
                {BILLING_PDF_TEMPLATE_STYLE_LABELS_HE[style]}
              </span>
              <span style={{ fontSize: 11, color: selected ? "rgba(251, 250, 246, 0.78)" : TOKEN.ink.muted, lineHeight: 1.35 }}>
                {BILLING_PDF_TEMPLATE_STYLE_HINTS_HE[style]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
