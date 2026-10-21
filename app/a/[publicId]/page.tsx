"use client";

/**
 * The accountant opens the link from the email: /a/<publicId>#t=<secret>.
 *
 * The secret is read from the URL fragment (a browser never sends a fragment to a server) and POSTed to
 * /api/accountant/link/open. The page shows whose package it is and for which month, and downloads it
 * through a five-minute signed URL. Nothing here needs, or offers, a Dubiz account.
 */

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Info = { businessName: string; periodLabel: string; expiresAt: string };
type State =
  | { kind: "loading" }
  | { kind: "ready"; info: Info }
  | { kind: "error"; message: string };

const MESSAGES: Record<string, string> = {
  LINK_EXPIRED: "תוקף הקישור הסתיים. אפשר לבקש מבעל העסק לשלוח שוב.",
  LINK_REVOKED: "בעל העסק ביטל את הקישור הזה.",
  LINK_UNAVAILABLE: "החבילה אינה זמינה כרגע.",
  LINK_NOT_FOUND: "הקישור אינו תקין. ודאו שפתחתם אותו בדיוק כפי שהגיע במייל.",
  rate_limit_unavailable: "השירות עמוס כרגע. נסו שוב בעוד רגע.",
};

function messageFor(code: string | undefined): string {
  return (code && MESSAGES[code]) || "משהו השתבש. נסו שוב בעוד רגע.";
}

export default function AccountantLinkPage() {
  const { publicId } = useParams<{ publicId: string }>();
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t");
    if (!t) {
      setState({ kind: "error", message: messageFor("LINK_NOT_FOUND") });
      return;
    }
    setToken(t);
    void fetch("/api/accountant/link/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicId, token: t, mode: "info" }),
      cache: "no-store",
      referrerPolicy: "no-referrer",
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) setState({ kind: "error", message: messageFor(body.error ?? body.code) });
        else setState({ kind: "ready", info: body as Info });
      })
      .catch(() => setState({ kind: "error", message: messageFor(undefined) }));
  }, [publicId]);

  async function download() {
    if (!token) return;
    setDownloading(true);
    try {
      const res = await fetch("/api/accountant/link/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicId, token, mode: "download" }),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok) {
        const body = type.includes("json") ? await res.json() : {};
        setState({ kind: "error", message: messageFor(body.error ?? body.code) });
        return;
      }
      if (type.includes("application/json")) {
        const { url } = (await res.json()) as { url: string };
        window.location.assign(url);
        return;
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "accountant-package.zip";
      a.click();
      URL.revokeObjectURL(href);
    } catch {
      setState({ kind: "error", message: messageFor(undefined) });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <main dir="rtl" style={page}>
      <div style={card}>
        <div style={brand}>Dubiz</div>
        {state.kind === "loading" ? <p style={text}>בודקים את הקישור…</p> : null}
        {state.kind === "error" ? (
          <>
            <h1 style={title}>לא ניתן לפתוח את החבילה</h1>
            <p style={text}>{state.message}</p>
          </>
        ) : null}
        {state.kind === "ready" ? (
          <>
            <h1 style={title}>חבילת המסמכים לחודש {state.info.periodLabel}</h1>
            <p style={text}>מאת {state.info.businessName || "בעל העסק"}. בחבילה: דוח מסכם, המסמכים הסרוקים שאושרו, המסמכים שהופקו ורשימת מה שעדיין פתוח.</p>
            <button type="button" onClick={() => void download()} disabled={downloading} style={button(downloading)}>
              {downloading ? "מכין הורדה…" : "הורדת החבילה (ZIP)"}
            </button>
            <p style={small}>
              הקישור בתוקף עד {new Date(state.info.expiresAt).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" })}. כל הורדה נרשמת אצל בעל העסק.
            </p>
          </>
        ) : null}
      </div>
    </main>
  );
}

const page = {
  minHeight: "100vh",
  background: "#f4f5f0",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  fontFamily: "Heebo, Arial, sans-serif",
  color: "#23302b",
} as const;
const card = {
  width: "min(520px, 100%)",
  background: "#ffffff",
  border: "1px solid #e3e6de",
  borderRadius: 16,
  padding: "28px 22px",
  boxSizing: "border-box" as const,
} as const;
const brand = { color: "#246966", fontWeight: 700, fontSize: 22, marginBottom: 16 } as const;
const title = { margin: "0 0 10px", fontSize: 22, lineHeight: 1.35 } as const;
const text = { margin: "0 0 16px", fontSize: 16, lineHeight: 1.6 } as const;
const small = { margin: "16px 0 0", fontSize: 14, lineHeight: 1.6, color: "#566159" } as const;
function button(disabled: boolean) {
  return {
    minHeight: 52,
    width: "100%",
    border: 0,
    borderRadius: 10,
    background: disabled ? "#9fb7b5" : "#246966",
    color: "#ffffff",
    fontSize: 16,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
  } as const;
}
