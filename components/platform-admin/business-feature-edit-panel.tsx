"use client";

import { useMemo, useState } from "react";
import type {
  BusinessFeatureOverrideState,
  PlatformAdminBusinessFeatureItem,
} from "@/lib/services/feature-access/feature-access.types";
import {
  PlatformAdminFetchError,
  patchPlatformAdminBusinessFeature,
} from "@/lib/platform-admin/fetch-platform-admin";
import { PA } from "./platform-admin-styles";

const REASON_MIN = 10;
const REASON_MAX = 500;

type BusinessFeatureEditPanelProps = {
  businessId: number;
  feature: PlatformAdminBusinessFeatureItem;
  onCancel: () => void;
  onSaved: () => void;
};

function currentOverrideState(
  override: "ENABLED" | "DISABLED" | null
): BusinessFeatureOverrideState {
  if (override === "ENABLED") return "ENABLED";
  if (override === "DISABLED") return "DISABLED";
  return "INHERIT";
}

function overrideStateLabel(state: BusinessFeatureOverrideState): string {
  switch (state) {
    case "ENABLED":
      return "פתוח לעסק הזה";
    case "DISABLED":
      return "סגור לעסק הזה";
    case "INHERIT":
      return "לפי ברירת המחדל";
  }
}

function mapActionError(error: unknown): string {
  if (error instanceof PlatformAdminFetchError) {
    if (error.status === 409 || error.code === "NO_CHANGE") {
      return "אין שינוי בגישה";
    }
    if (error.status === 403) {
      return "פיצ׳ר בסיסי שלא ניתן לשינוי";
    }
    if (error.status === 503) {
      return "מערכת שינויי גישה כבויה זמנית";
    }
    return error.message || "השמירה נכשלה";
  }
  return "השמירה נכשלה";
}

const OPTIONS: BusinessFeatureOverrideState[] = [
  "INHERIT",
  "ENABLED",
  "DISABLED",
];

export function BusinessFeatureEditPanel({
  businessId,
  feature,
  onCancel,
  onSaved,
}: BusinessFeatureEditPanelProps) {
  const initialState = currentOverrideState(feature.businessOverride);
  const [draftState, setDraftState] =
    useState<BusinessFeatureOverrideState>(initialState);
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const trimmedLength = reason.trim().length;
  const reasonValid =
    trimmedLength >= REASON_MIN && trimmedLength <= REASON_MAX;
  const stateChanged = draftState !== initialState;
  const canSave = reasonValid && stateChanged && !saving;

  const counterColor = useMemo(() => {
    if (trimmedLength === 0) return PA.inkMeta;
    if (!reasonValid) return PA.attention.accent;
    return PA.inkMuted;
  }, [trimmedLength, reasonValid]);

  async function handleConfirm() {
    setSaving(true);
    setActionError(null);
    try {
      await patchPlatformAdminBusinessFeature(businessId, feature.featureKey, {
        state: draftState,
        reason: reason.trim(),
      });
      setConfirmOpen(false);
      onSaved();
    } catch (e) {
      setConfirmOpen(false);
      setActionError(mapActionError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 10,
        padding: 12,
        border: `1px solid ${PA.border}`,
        borderRadius: 8,
        background: PA.pageBg,
      }}
    >
      <label
        style={{
          display: "block",
          fontSize: 12,
          color: PA.inkMuted,
          marginBottom: 4,
        }}
      >
        גישה
      </label>
      <select
        value={draftState}
        onChange={(e) =>
          setDraftState(e.target.value as BusinessFeatureOverrideState)
        }
        disabled={saving}
        style={{
          width: "100%",
          padding: "8px 10px",
          fontSize: 13,
          border: `1px solid ${PA.border}`,
          borderRadius: 8,
          background: PA.cardBg,
          color: PA.ink,
          marginBottom: 12,
        }}
      >
        {OPTIONS.map((opt) => (
          <option key={opt} value={opt}>
            {overrideStateLabel(opt)}
          </option>
        ))}
      </select>

      <label
        style={{
          display: "block",
          fontSize: 12,
          color: PA.inkMuted,
          marginBottom: 4,
        }}
      >
        סיבה לשינוי
      </label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={saving}
        rows={3}
        maxLength={REASON_MAX}
        placeholder="לפחות 10 תווים — תיעוד לסיבת השינוי"
        style={{
          width: "100%",
          padding: "8px 10px",
          fontSize: 13,
          border: `1px solid ${PA.border}`,
          borderRadius: 8,
          background: PA.cardBg,
          color: PA.ink,
          resize: "vertical",
          fontFamily: "inherit",
        }}
      />
      <div
        style={{
          fontSize: 11,
          color: counterColor,
          marginTop: 4,
          textAlign: "left",
        }}
      >
        {trimmedLength}/{REASON_MAX}
        {trimmedLength > 0 && trimmedLength < REASON_MIN
          ? ` · נדרשים לפחות ${REASON_MIN}`
          : ""}
      </div>

      {actionError ? (
        <div
          style={{
            marginTop: 10,
            padding: "8px 10px",
            fontSize: 12,
            color: PA.attention.accent,
            border: `1px solid ${PA.attention.accent}`,
            borderRadius: 8,
            background: PA.cardBg,
          }}
        >
          {actionError}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 12,
          justifyContent: "flex-start",
        }}
      >
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={!canSave}
          style={{
            border: "none",
            background: canSave ? PA.success.accent : PA.border,
            color: canSave ? "var(--dz-text-on-brand)" : PA.inkMeta,
            borderRadius: 8,
            padding: "8px 16px",
            fontSize: 13,
            fontWeight: 600,
            cursor: canSave ? "pointer" : "not-allowed",
          }}
        >
          שמור
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={{
            border: `1px solid ${PA.border}`,
            background: PA.cardBg,
            color: PA.ink,
            borderRadius: 8,
            padding: "8px 16px",
            fontSize: 13,
            cursor: saving ? "wait" : "pointer",
          }}
        >
          ביטול
        </button>
      </div>

      {confirmOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(52, 60, 50, 0.26)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 50,
          }}
          onClick={() => {
            if (!saving) setConfirmOpen(false);
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 420,
              width: "100%",
              background: PA.cardBg,
              border: `1px solid ${PA.border}`,
              borderRadius: PA.radius,
              padding: 20,
            }}
          >
            <h3
              style={{
                margin: "0 0 12px",
                fontSize: 16,
                fontWeight: 700,
                color: PA.ink,
              }}
            >
              שינוי גישה · {feature.displayName}
            </h3>
            <dl
              style={{
                margin: "0 0 14px",
                fontSize: 13,
                color: PA.inkSecondary,
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: "6px 12px",
              }}
            >
              <dt style={{ color: PA.inkMuted }}>מצב נוכחי</dt>
              <dd style={{ margin: 0 }}>{overrideStateLabel(initialState)}</dd>
              <dt style={{ color: PA.inkMuted }}>מצב חדש</dt>
              <dd style={{ margin: 0, fontWeight: 600 }}>
                {overrideStateLabel(draftState)}
              </dd>
              <dt style={{ color: PA.inkMuted }}>סיבה</dt>
              <dd style={{ margin: 0 }}>{reason.trim()}</dd>
            </dl>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={saving}
                style={{
                  border: "none",
                  background: PA.success.accent,
                  color: "var(--dz-text-on-brand)",
                  borderRadius: 8,
                  padding: "8px 16px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: saving ? "wait" : "pointer",
                }}
              >
                {saving ? "שומר…" : "אישור שינוי"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={saving}
                style={{
                  border: `1px solid ${PA.border}`,
                  background: PA.cardBg,
                  color: PA.ink,
                  borderRadius: 8,
                  padding: "8px 16px",
                  fontSize: 13,
                  cursor: saving ? "wait" : "pointer",
                }}
              >
                ביטול
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
