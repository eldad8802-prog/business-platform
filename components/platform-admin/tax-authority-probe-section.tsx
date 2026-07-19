"use client";

/**
 * TEMPORARY — Tax Authority connection diagnostic (Platform Admin only).
 *
 * Remove together with the probe route, service, logic, and their tests:
 *   - app/api/platform-admin/diagnostics/tax-authority-token-probe/route.ts
 *   - lib/services/billing/authority/billing-authority-token-probe.service.ts
 *   - components/platform-admin/tax-authority-probe-logic.ts
 *   - lib/platform-admin/fetch-platform-admin.ts (postPlatformAdminTokenProbe)
 *
 * Rendered only inside PlatformAdminGate (already verified Platform Admin).
 * A single click sends ONE live POST to the ITA token endpoint; after the first
 * attempt the button is permanently disabled for this component instance
 * (only a page refresh resets). The component never reads/stores/prints the JWT
 * — auth flows entirely through the canonical postPlatformAdminTokenProbe().
 */

import { useRef, useState } from "react";
import { postPlatformAdminTokenProbe } from "@/lib/platform-admin/fetch-platform-admin";
import {
  createProbeRunner,
  type ProbeRunner,
  type ProbeRunnerState,
  type ProbeView,
} from "./tax-authority-probe-logic";
import { PlatformAdminInlineError } from "./platform-admin-inline-error";
import { PA } from "./platform-admin-styles";

const FIELD_LABELS: Array<[keyof ProbeView, string]> = [
  ["routeHttpStatus", "routeHttpStatus"],
  ["networkReachable", "networkReachable"],
  ["httpStatusIfAny", "httpStatusIfAny"],
  ["networkErrorClass", "networkErrorClass"],
  ["requestDurationBucket", "requestDurationBucket"],
  ["runtime", "runtime"],
  ["region", "region"],
];

function renderValue(value: ProbeView[keyof ProbeView]): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function TaxAuthorityProbeSection() {
  const [state, setState] = useState<ProbeRunnerState>({ phase: "idle" });
  const runnerRef = useRef<ProbeRunner | null>(null);
  if (runnerRef.current === null) {
    runnerRef.current = createProbeRunner({
      probeRequest: postPlatformAdminTokenProbe,
      onState: setState,
    });
  }

  // Disabled the moment the first attempt starts — and stays disabled through
  // running / succeeded / failed. No manual or automatic retry from here.
  const disabled = state.phase !== "idle";

  return (
    <section aria-labelledby="pa-authority-probe-heading">
      <div
        style={{
          padding: 20,
          borderRadius: PA.radius,
          border: `1px solid ${PA.border}`,
          background: PA.cardBg,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2
            id="pa-authority-probe-heading"
            style={{ margin: 0, fontSize: 16, fontWeight: 600, color: PA.ink }}
          >
            אבחון חיבור רשות המסים
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: PA.inkMuted, lineHeight: 1.5 }}>
            כלי אבחון זמני. בודק את שכבת הרשת בין השרת ל-token endpoint של רשות
            המסים.
          </p>
        </div>

        <p
          role="note"
          style={{
            margin: 0,
            fontSize: 12.5,
            lineHeight: 1.6,
            color: PA.attention.ink,
            background: PA.attention.bg,
            border: `1px solid ${PA.attention.border}`,
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          הבדיקה שולחת בקשת POST חיה אחת לשרת רשות המסים. לאחר ההפעלה לא ניתן
          להריץ אותה שוב מהמסך הזה.
        </p>

        <div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void runnerRef.current?.run()}
            style={{
              height: 40,
              padding: "0 18px",
              borderRadius: 8,
              border: "none",
              fontSize: 14,
              fontWeight: 600,
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.5 : 1,
              background: PA.ink,
              color: "#fff",
            }}
          >
            {state.phase === "running" ? "מריץ בדיקה…" : "הרץ בדיקת חיבור חד-פעמית"}
          </button>
        </div>

        {state.phase === "succeeded" ? (
          <dl
            style={{
              margin: 0,
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "6px 16px",
              fontSize: 13,
            }}
          >
            {FIELD_LABELS.map(([key, label]) => (
              <div key={key} style={{ display: "contents" }}>
                <dt style={{ color: PA.inkMuted, fontFamily: "ui-monospace, monospace" }}>
                  {label}
                </dt>
                <dd
                  style={{
                    margin: 0,
                    color: PA.ink,
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  {renderValue(state.view[key])}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {state.phase === "failed" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <p style={{ margin: 0, fontSize: 12.5, color: PA.inkMuted, fontFamily: "ui-monospace, monospace" }}>
              routeHttpStatus: {state.routeHttpStatus === null ? "null" : state.routeHttpStatus}
            </p>
            <PlatformAdminInlineError message={state.message} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
