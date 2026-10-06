"use client";

import { useState } from "react";

const ERRORS: Record<string, string> = {
  source_not_enabled: "חיבור חנויות Wix עדיין לא פתוח בחשבון שלך.",
  unavailable: "החיבור ל-Wix עדיין לא זמין.",
  instance_invalid: "הקישור מ-Wix לא תקין או שפג תוקפו — פתח/י את האפליקציה מחדש מלוח הבקרה של Wix.",
  app_not_installed: "האפליקציה של Dubiz לא מותקנת באתר הזה ב-Wix.",
  wix_unavailable: "Wix לא זמין כרגע — נסה/י שוב בעוד כמה דקות.",
  store_connected_to_another_business: "החנות הזאת כבר מחוברת לעסק אחר.",
};

/** The owner confirms binding the Wix store they just installed Dubiz on (signed `instance` from Wix). */
export function WixConnectConfirm({ instance }: { instance: string | null }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "signin">("idle");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  async function connect() {
    setError(null);
    let t: string | null = null;
    try {
      t = localStorage.getItem("token");
    } catch {
      t = null;
    }
    if (!t) {
      setState("signin");
      return;
    }
    setState("busy");
    const res = await fetch("/api/integrations/commerce/wix", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ instance }),
      cache: "no-store",
    }).catch(() => null);
    const json = (await res?.json().catch(() => ({}))) as { error?: string; connection?: { label: string | null } };
    if (res?.status === 401) return setState("signin");
    if (!res?.ok) {
      setState("idle");
      return setError(ERRORS[json.error ?? ""] ?? "משהו השתבש — נסה/י שוב.");
    }
    setName(json.connection?.label ?? null);
    setState("done");
  }

  if (!instance) {
    return <p className="text-sm text-[var(--dz-text-muted)]">כדי לחבר חנות Wix, התקן/י את האפליקציה של Dubiz מתוך Wix ופתח/י אותה מלוח הבקרה של האתר.</p>;
  }
  return (
    <div className="space-y-3 rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface)] p-4 text-sm">
      {state === "done" ? (
        <p className="text-[var(--dz-success)]">החנות{name ? ` "${name}"` : ""} חוברה. הזמנות חדשות יופיעו ב-Dubiz אוטומטית.</p>
      ) : (
        <>
          <p className="text-[var(--dz-text-primary)]">לחבר את חנות ה-Wix הזאת לעסק שלך ב-Dubiz? הזמנות מהחנות יופיעו ב-Dubiz — בלי לשנות מלאי, תשלומים או מסמכים.</p>
          {state === "signin" && (
            <p className="text-[var(--dz-text-muted)]">
              צריך להיות מחובר/ת ל-Dubiz בדפדפן הזה.{" "}
              <a className="underline" href="/login" target="_blank" rel="noreferrer">התחבר/י</a> ואז לחץ/י שוב על &quot;חבר&quot;.
            </p>
          )}
          {error && <p className="text-[var(--dz-danger)]">{error}</p>}
          <button
            type="button"
            onClick={connect}
            disabled={state === "busy"}
            className="rounded-full bg-[var(--dz-text-primary)] px-4 py-1 text-xs font-bold text-[var(--dz-surface)] disabled:opacity-60"
          >
            {state === "busy" ? "מחבר…" : "חבר את החנות"}
          </button>
        </>
      )}
    </div>
  );
}
