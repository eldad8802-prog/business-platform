"use client";

/**
 * The issuer declaration notice in the billing area (#1081; approved design, owner 2026-11-17, screen 1).
 *
 * NON-blocking: it never hides or disables anything — issuing works as before while enforcement is off. It appears
 * only when the declaration screens are on (GET /api/billing/issuer-declaration answers; OFF → 404 → nothing renders)
 * and the business has not declared. "אחר כך" hides it for THIS visit to the billing area only: the choice lives in
 * this component's state, so the next entry to the billing area shows it again (owner decision). Nothing is stored.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { issuerNoticeVisible } from "@/lib/billing/issuer-declaration/screen-model";
import { TOKEN } from "@/lib/design/billing-theme";

function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : window.localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function IssuerDeclarationNotice() {
  const [available, setAvailable] = useState(false);
  const [declared, setDeclared] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/billing/issuer-declaration", { headers: authHeaders(), credentials: "same-origin", cache: "no-store" });
        if (!res.ok) return; // OFF (404), signed out, or any failure: no notice — never a broken banner.
        const body = (await res.json()) as { declared?: boolean };
        if (!alive) return;
        setDeclared(body.declared === true);
        setAvailable(true);
      } catch {
        // no notice
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!issuerNoticeVisible({ available, declared, dismissedThisVisit: dismissed })) return null;

  return (
    <section
      aria-label="הצהרת המנפיק"
      data-testid="issuer-declaration-notice"
      dir="rtl"
      style={{
        background: TOKEN.brand.soft,
        border: `1px solid ${TOKEN.brand.softBorder}`,
        borderRadius: TOKEN.radius.card,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={TOKEN.brand.mid} strokeWidth={1.8}
          strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", marginTop: 2 }}>
          <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: TOKEN.weight.semibold, color: TOKEN.ink.primary }}>נשאר צעד אחד: הצהרת המנפיק</h2>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: TOKEN.ink.secondary }}>
            אישור חד־פעמי שהפרטים שעל המסמכים שלך נכונים ושאת/ה מוסמך/ת להפיק אותם. לוקח כדקה, והפרטים כבר מוכנים מההרשמה.
          </p>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Link
          href="/billing/issuer-declaration"
          data-testid="issuer-declaration-notice-open"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 44,
            padding: "0 18px",
            borderRadius: TOKEN.radius.button,
            background: TOKEN.action.primary.background,
            color: TOKEN.action.primary.color,
            fontSize: 15,
            fontWeight: TOKEN.weight.semibold,
            textDecoration: "none",
          }}
        >
          להשלמת ההצהרה
        </Link>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          data-testid="issuer-declaration-notice-later"
          style={{
            minHeight: 44,
            padding: "0 14px",
            borderRadius: TOKEN.radius.button,
            border: TOKEN.action.glass.border,
            background: TOKEN.action.glass.background,
            color: TOKEN.action.glass.color,
            fontFamily: "inherit",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          אחר כך
        </button>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: TOKEN.ink.meta }}>אפשר להמשיך להפיק מסמכים כרגיל בינתיים.</p>
    </section>
  );
}
