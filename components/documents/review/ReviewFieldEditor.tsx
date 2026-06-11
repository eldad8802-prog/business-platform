"use client";

import { CATEGORIES } from "@/lib/constants/categories";
import type { Direction, EditableField, ReviewDraft } from "@/lib/documents/review/types";
import { primaryDarkButton, reviewCard, reviewInput, secondaryButton } from "./review-ui";

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
  editFieldTitle,
  editField,
  draft,
  loading,
  onDraftChange,
  onConfirm,
  onCancel,
}: ReviewFieldEditorProps) {
  return (
    <section style={{ ...reviewCard, maxWidth: 620, width: "100%", margin: "0 auto" }}>
      <div style={{ fontWeight: 950, color: "#0d1b3d", fontSize: 22, marginBottom: 14 }}>
        {editFieldTitle}
      </div>

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
        <select
          value={draft.category}
          onChange={(e) => onDraftChange((d) => ({ ...d, category: e.target.value }))}
          style={reviewInput}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
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

function directionButtonStyle(active: boolean) {
  return {
    flex: 1,
    minHeight: 54,
    padding: "12px 14px",
    borderRadius: 16,
    border: active ? "1px solid #075bff" : "1px solid #d8e2f2",
    background: active ? "#eff6ff" : "#ffffff",
    color: active ? "#075bff" : "#0d1b3d",
    fontWeight: 950,
    cursor: "pointer",
  } as const;
}
