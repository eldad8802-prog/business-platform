"use client";

/**
 * FCM credential check — Platform Admin → בדיקות מערכת (notifications track).
 *
 * Rendered only inside the admin console (already verified Platform Admin). A click sends ONE POST to the
 * existing route through the canonical postPlatformAdminFcmAuthCheck() (Bearer + MFA elevation + step-up);
 * the server keeps its guard and fail-closed rate limit. No push is sent. The component shows only one of
 * the four result classes; it never reads, stores or prints a key, token or Google response.
 */

import { useRef, useState } from "react";
import { postPlatformAdminFcmAuthCheck } from "@/lib/platform-admin/fetch-platform-admin";
import {
  createFcmAuthCheckRunner,
  type FcmAuthCheckRunner,
  type FcmAuthCheckState,
} from "./fcm-auth-check-logic";
import { PlatformAdminInlineError } from "./platform-admin-inline-error";
import { PA } from "./platform-admin-styles";

export function FcmAuthCheckSection() {
  const [state, setState] = useState<FcmAuthCheckState>({ phase: "idle" });
  const runnerRef = useRef<FcmAuthCheckRunner | null>(null);
  if (runnerRef.current === null) {
    runnerRef.current = createFcmAuthCheckRunner({
      request: postPlatformAdminFcmAuthCheck,
      onState: setState,
    });
  }

  const running = state.phase === "running";

  return (
    <section aria-labelledby="pa-fcm-auth-check-heading">
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
            id="pa-fcm-auth-check-heading"
            style={{ margin: 0, fontSize: 16, fontWeight: 600, color: PA.ink }}
          >
            בדיקת הזדהות מול Firebase
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: PA.inkMuted, lineHeight: 1.5 }}>
            בודקת שהשרת מצליח להזדהות מול Google עם פרטי FCM שהוגדרו. לא נשלחת התראה לאף משתמש.
          </p>
        </div>

        <p
          role="note"
          style={{
            margin: 0,
            fontSize: 12.5,
            lineHeight: 1.6,
            color: PA.inkSecondary,
            background: PA.pageBg,
            border: `1px solid ${PA.border}`,
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          אפשר להריץ עד 3 בדיקות ב-10 דקות. הצלחה כאן לא מוכיחה הרשאת שליחה, את זה בודקים בשליחה
          הראשונה בפיילוט.
        </p>

        <div>
          <button
            type="button"
            disabled={running}
            aria-busy={running}
            onClick={() => void runnerRef.current?.run()}
            style={{
              height: 40,
              padding: "0 18px",
              borderRadius: 8,
              border: "none",
              fontSize: 14,
              fontWeight: 600,
              cursor: running ? "not-allowed" : "pointer",
              opacity: running ? 0.5 : 1,
              background: PA.ink,
              color: "var(--dz-text-on-brand)",
            }}
          >
            {running ? "בודק…" : "בדיקת הזדהות"}
          </button>
        </div>

        <div aria-live="polite">
          {state.phase === "succeeded" ? (
            <div
              data-result={state.view.result}
              style={{
                padding: "12px 14px",
                borderRadius: PA.radius,
                border: `1px solid ${PA[state.view.tone].border}`,
                background: PA[state.view.tone].bgSoft,
                color: PA[state.view.tone].ink,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <strong style={{ fontSize: 14 }}>{state.view.title}</strong>
              <span style={{ fontSize: 13, lineHeight: 1.5 }}>{state.view.detail}</span>
              <span
                dir="ltr"
                style={{ fontSize: 12, fontFamily: "ui-monospace, monospace", alignSelf: "flex-end" }}
              >
                {state.view.result}
              </span>
            </div>
          ) : null}

          {state.phase === "failed" ? <PlatformAdminInlineError message={state.message} /> : null}
        </div>
      </div>
    </section>
  );
}
