"use client";

import { CATEGORIES } from "@/lib/constants/categories";
import type { Direction, EditableField, ReviewDraft } from "@/lib/documents/review/types";
import { TOKEN } from "@/lib/design/documents-theme";
import DubizDateField from "@/components/documents/DubizDateField";
import { primaryDarkButton, reviewInput, secondaryButton } from "./review-ui";

export type ReviewFieldEditorProps = {
  editFieldTitle: string;
  editField: EditableField;
  draft: ReviewDraft;
  loading: boolean;
  onDraftChange: (updater: (d: ReviewDraft) => ReviewDraft) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ReviewFieldEditor({
  editField,
  draft,
  loading,
  onDraftChange,
  onConfirm,
  onCancel,
}: ReviewFieldEditorProps) {
  return (
    <section style={{ width: "100%" }}>
      {editField === "amount" ? (
        <div style={fieldWrapStyle}>
          <input
            type="number"
            value={draft.amount ?? ""}
            onChange={(e) =>
              onDraftChange((d) => ({
                ...d,
                amount: e.target.value === "" ? null : Number(e.target.value),
              }))
            }
            style={inputWithClearStyle}
          />
          {draft.amount != null ? (
            <ClearFieldButton onClick={() => onDraftChange((d) => ({ ...d, amount: null }))} />
          ) : null}
        </div>
      ) : null}

      {editField === "vendorName" ? (
        <div style={fieldWrapStyle}>
          <input
            value={draft.vendorName}
            onChange={(e) => onDraftChange((d) => ({ ...d, vendorName: e.target.value }))}
            style={inputWithClearStyle}
          />
          {draft.vendorName ? (
            <ClearFieldButton onClick={() => onDraftChange((d) => ({ ...d, vendorName: "" }))} />
          ) : null}
        </div>
      ) : null}

      {editField === "date" ? (
        <DubizDateField
          type="date"
          ariaLabel="תאריך המסמך"
          value={draft.date ? draft.date.slice(0, 10) : ""}
          onChange={(value) =>
            onDraftChange((d) => ({
              ...d,
              date: value ? new Date(value).toISOString() : null,
            }))
          }
        />
      ) : null}

      {editField === "direction" ? (
        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="button"
            style={directionButtonStyle(draft.direction === "expense")}
            onClick={() => onDraftChange((d) => ({ ...d, direction: "expense" as Direction }))}
          >
            הוצאה
          </button>
          <button
            type="button"
            style={directionButtonStyle(draft.direction === "income")}
            onClick={() => onDraftChange((d) => ({ ...d, direction: "income" as Direction }))}
          >
            הכנסה
          </button>
        </div>
      ) : null}

      {editField === "category" ? (
        <div
          className="dz-scroll"
          style={{ display: "grid", gap: 8, maxHeight: 320, overflow: "auto", padding: 2 }}
        >
          {CATEGORIES.map((c) => (
            <button
              key={c.value}
              type="button"
              style={categoryButtonStyle(draft.category === c.value)}
              onClick={() => onDraftChange((d) => ({ ...d, category: c.value }))}
            >
              {c.label}
            </button>
          ))}
        </div>
      ) : null}

      <div style={{ marginTop: 18 }}>
        <button type="button" disabled={loading} style={primaryDarkButton(loading)} onClick={onConfirm}>
          אישור
        </button>
      </div>

      <div style={{ marginTop: 10 }}>
        <button type="button" disabled={loading} style={secondaryButton(loading)} onClick={onCancel}>
          ביטול
        </button>
      </div>
    </section>
  );
}

const fieldWrapStyle = { position: "relative" as const, width: "100%" };

const inputWithClearStyle = { ...reviewInput, paddingLeft: 46 } as const;

function ClearFieldButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="נקה שדה"
      onClick={onClick}
      style={{
        position: "absolute",
        left: 8,
        top: "50%",
        transform: "translateY(-50%)",
        width: 34,
        height: 34,
        borderRadius: 999,
        border: "none",
        background: TOKEN.surface.inset,
        color: TOKEN.ink.muted,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        padding: 0,
      }}
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden focusable="false">
        <path
          d="M3.5 3.5 10.5 10.5M10.5 3.5 3.5 10.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

function categoryButtonStyle(active: boolean) {
  return {
    minHeight: 44,
    borderRadius: TOKEN.radius.button,
    border: active
      ? `1px solid ${TOKEN.brand.softBorder}`
      : `1px solid ${TOKEN.border.DEFAULT}`,
    background: active ? TOKEN.brand.soft : TOKEN.surface.card,
    color: active ? TOKEN.brand.mid : TOKEN.ink.primary,
    fontWeight: TOKEN.weight.bold,
    cursor: "pointer",
    textAlign: "right" as const,
    padding: "0 14px",
    fontSize: TOKEN.font.body,
  };
}

function directionButtonStyle(active: boolean) {
  return {
    flex: 1,
    minHeight: 54,
    padding: "12px 14px",
    borderRadius: TOKEN.radius.button,
    border: active
      ? `1px solid ${TOKEN.brand.softBorder}`
      : `1px solid ${TOKEN.border.DEFAULT}`,
    background: active ? TOKEN.brand.soft : TOKEN.surface.card,
    color: active ? TOKEN.brand.mid : TOKEN.ink.primary,
    fontWeight: TOKEN.weight.bold,
    cursor: "pointer",
    fontSize: TOKEN.font.body,
  } as const;
}
