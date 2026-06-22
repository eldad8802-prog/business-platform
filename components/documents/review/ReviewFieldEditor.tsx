"use client";

import { CATEGORIES } from "@/lib/constants/categories";
import type { Direction, EditableField, ReviewDraft } from "@/lib/documents/review/types";
import { TOKEN } from "@/lib/design/tokens";
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
        <input
          type="number"
          value={draft.amount ?? ""}
          onChange={(e) =>
            onDraftChange((d) => ({
              ...d,
              amount: e.target.value === "" ? null : Number(e.target.value),
            }))
          }
          style={reviewInput}
        />
      ) : null}

      {editField === "vendorName" ? (
        <input
          value={draft.vendorName}
          onChange={(e) => onDraftChange((d) => ({ ...d, vendorName: e.target.value }))}
          style={reviewInput}
        />
      ) : null}

      {editField === "date" ? (
        <input
          type="date"
          value={draft.date ? draft.date.slice(0, 10) : ""}
          onChange={(e) =>
            onDraftChange((d) => ({
              ...d,
              date: e.target.value ? new Date(e.target.value).toISOString() : null,
            }))
          }
          style={reviewInput}
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
        <div style={{ display: "grid", gap: 8, maxHeight: 320, overflow: "auto" }}>
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
