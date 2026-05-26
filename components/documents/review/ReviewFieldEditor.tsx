"use client";

import { CATEGORIES } from "@/lib/constants/categories";
import { card } from "@/app/(shell)/documents/ui";
import type { Direction, EditableField, ReviewDraft } from "@/lib/documents/review/types";
import { primaryDarkButton, secondaryButton } from "./review-ui";

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
    <section style={card}>
      <div style={{ fontWeight: 950, color: "#111827", fontSize: 18, marginBottom: 10 }}>
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
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 14,
            border: "1px solid #d1d5db",
            fontSize: 16,
            boxSizing: "border-box",
          }}
        />
      ) : null}

      {editField === "vendorName" ? (
        <input
          value={draft.vendorName}
          onChange={(e) => onDraftChange((d) => ({ ...d, vendorName: e.target.value }))}
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 14,
            border: "1px solid #d1d5db",
            fontSize: 16,
            boxSizing: "border-box",
          }}
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
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 14,
            border: "1px solid #d1d5db",
            fontSize: 16,
            boxSizing: "border-box",
          }}
        />
      ) : null}

      {editField === "direction" ? (
        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="button"
            style={{
              flex: 1,
              padding: "12px 14px",
              borderRadius: 16,
              border: "1px solid #e5e7eb",
              background: draft.direction === "expense" ? "#111827" : "#ffffff",
              color: draft.direction === "expense" ? "#ffffff" : "#111827",
              fontWeight: 950,
              cursor: "pointer",
            }}
            onClick={() => onDraftChange((d) => ({ ...d, direction: "expense" as Direction }))}
          >
            הוצאה
          </button>
          <button
            type="button"
            style={{
              flex: 1,
              padding: "12px 14px",
              borderRadius: 16,
              border: "1px solid #e5e7eb",
              background: draft.direction === "income" ? "#111827" : "#ffffff",
              color: draft.direction === "income" ? "#ffffff" : "#111827",
              fontWeight: 950,
              cursor: "pointer",
            }}
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
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 14,
            border: "1px solid #d1d5db",
            fontSize: 16,
            boxSizing: "border-box",
            background: "#ffffff",
          }}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <button
          type="button"
          disabled={loading}
          style={primaryDarkButton(loading)}
          onClick={onConfirm}
        >
          אישור
        </button>
      </div>

      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          disabled={loading}
          style={secondaryButton(loading)}
          onClick={onCancel}
        >
          ביטול
        </button>
      </div>
    </section>
  );
}
