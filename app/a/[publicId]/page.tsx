"use client";

/**
 * The accountant's portal: /a/<publicId>#t=<secret> (R4).
 *
 * The secret is read from the URL fragment (a browser never sends a fragment to a server) and POSTed:
 *   /api/accountant/link/portal  the delivered package — whose, which month, every file with its details;
 *   /api/accountant/link/file    one file (view / download) or the Excel / PDF report;
 *   /api/accountant/link/open    the whole ZIP (the existing route).
 * Every file is handed out by a five-minute signed URL, opened or saved as it is. Nothing here needs, or
 * offers, a Dubiz account, and nothing here can change a document.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

import s from "./portal.module.css";

type PortalFile = {
  path: string;
  kind: "source" | "issued";
  fileName: string;
  viewable: boolean;
  size: number;
  sha256: string;
  verified: boolean | null;
  title: string;
  date: string;
  party: string;
  amount: string;
  currency: string;
  note: string;
};
type Missing = { kind: "source" | "issued"; title: string; date: string; party: string; amount: string; reason: string };
type Portal = {
  businessName: string;
  periodKey: string;
  periodLabel: string;
  expiresAt: string;
  packageVersion: number;
  packageSha256: string;
  generatedAt: string | null;
  counts: { source: number; issued: number; missing: number; pending: number };
  files: PortalFile[];
  missing: Missing[];
};
type State = { kind: "loading" } | { kind: "ready"; portal: Portal } | { kind: "error"; title: string; message: string };
type Action = { file?: string; report?: "xlsx" | "pdf"; zip?: true; mode: "view" | "download" };

const MESSAGES: Record<string, { title: string; message: string }> = {
  LINK_EXPIRED: { title: "תוקף הקישור הסתיים", message: "הקישור היה בתוקף 14 ימים. אפשר לבקש מבעל העסק לשלוח קישור חדש." },
  LINK_REVOKED: { title: "הקישור בוטל", message: "בעל העסק ביטל את הגישה לחבילה הזו." },
  LINK_UNAVAILABLE: { title: "החבילה אינה זמינה כרגע", message: "אפשר לפנות לבעל העסק." },
  LINK_NOT_FOUND: { title: "הקישור אינו תקין", message: "ודאו שפתחתם אותו בדיוק כפי שהגיע במייל, כולל כל התווים שאחרי הסימן #." },
  PACKAGE_INTEGRITY: { title: "לא ניתן לאמת את החבילה", message: "הקובץ השמור אינו תואם לחבילה שנשלחה, ולכן הוא לא יוצג. אפשר לפנות לבעל העסק." },
  rate_limit_unavailable: { title: "השירות עמוס כרגע", message: "נסו שוב בעוד רגע." },
};
const FALLBACK = { title: "משהו השתבש", message: "נסו שוב בעוד רגע." };
const ACTION_ERRORS: Record<string, string> = {
  FILE_NOT_FOUND: "הקובץ אינו חלק מהחבילה.",
  NOT_VIEWABLE: "אי אפשר להציג את הקובץ הזה בדפדפן — אפשר להוריד אותו.",
  PDF_RENDER_FAILED: "לא הצלחנו להכין את דוח ה־PDF כרגע. אפשר להוריד את דוח ה־Excel או את החבילה המלאה.",
  RATE_LIMITED: "יותר מדי בקשות בזמן קצר. נסו שוב בעוד דקה.",
};
/** Answers that end the session on this page (the link itself is no longer usable). */
const FATAL = new Set(["LINK_EXPIRED", "LINK_REVOKED", "LINK_UNAVAILABLE", "LINK_NOT_FOUND", "PACKAGE_INTEGRITY"]);

function errorOf(code: string | undefined) {
  return (code && MESSAGES[code]) || FALLBACK;
}
function sizeHe(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function dateHe(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" }) : "";
}
function badgeOf(f: PortalFile): string {
  const ext = (f.path.split(".").pop() ?? "").toUpperCase();
  return ext === "JPEG" ? "JPG" : ext.slice(0, 4);
}

export default function AccountantPortalPage() {
  const { publicId } = useParams<{ publicId: string }>();
  const token = useRef<string | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const post = useCallback(
    (url: string, body: Record<string, unknown>) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicId, token: token.current, ...body }),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      }),
    [publicId]
  );

  useEffect(() => {
    // A link without its secret gets the server's answer for an invalid link, like any other.
    token.current = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t");
    void post("/api/accountant/link/portal", {})
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) setState({ kind: "error", ...errorOf(body.error ?? body.code) });
        else setState({ kind: "ready", portal: body as Portal });
      })
      .catch(() => setState({ kind: "error", ...FALLBACK }));
  }, [post]);

  async function run(id: string, action: Action) {
    if (busy) return;
    setBusy(id);
    setNotice(null);
    // A tab opened in the click itself is never blocked; it is pointed at the file once the URL is known.
    const tab = action.mode === "view" ? window.open("", "_blank") : null;
    if (tab) tab.opener = null;
    try {
      const res = action.zip
        ? await post("/api/accountant/link/open", { mode: "download" })
        : await post("/api/accountant/link/file", action.report ? { report: action.report, mode: action.mode } : { file: action.file, mode: action.mode });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok) {
        tab?.close();
        const body = type.includes("json") ? await res.json() : {};
        const code: string | undefined = body.error ?? body.code;
        if (code && FATAL.has(code)) setState({ kind: "error", ...errorOf(code) });
        else setNotice((code && ACTION_ERRORS[code]) || (res.status === 429 ? ACTION_ERRORS.RATE_LIMITED : FALLBACK.message));
        return;
      }
      if (type.includes("application/json")) {
        const { url } = (await res.json()) as { url: string };
        if (tab) tab.location.href = url;
        else window.location.assign(url);
        return;
      }
      // Local development: the bytes come back directly.
      const href = URL.createObjectURL(await res.blob());
      if (tab) tab.location.href = href;
      else {
        const a = document.createElement("a");
        a.href = href;
        a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "file";
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } catch {
      tab?.close();
      setNotice(FALLBACK.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main dir="rtl" lang="he" className={s.page}>
      <header className={s.top}>
        <div className={s.brand}>Dubiz</div>
        <div className={s.topNote}>חבילת מסמכים לרואה החשבון · גישה מאובטחת לקריאה בלבד</div>
      </header>

      {state.kind === "loading" ? (
        <div className={s.wrap} aria-busy="true">
          <section className={s.hero}>
            <p className={s.eyebrow}>בודקים את הקישור…</p>
            <div className={s.skeleton} style={{ width: "55%", height: 26 }} />
            <div className={s.skeleton} style={{ width: "35%" }} />
          </section>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className={`${s.wrap} ${s.center}`} role="alert">
          <h1 className={s.stateTitle}>{state.title}</h1>
          <p className={s.cardText}>{state.message}</p>
        </div>
      ) : null}

      {state.kind === "ready" ? <PortalView portal={state.portal} busy={busy} run={run} /> : null}

      {notice ? (
        <div className={s.toast} role="status" onClick={() => setNotice(null)}>
          {notice}
        </div>
      ) : null}
    </main>
  );
}

function PortalView({ portal, busy, run }: { portal: Portal; busy: string | null; run: (id: string, a: Action) => void }) {
  const sources = portal.files.filter((f) => f.kind === "source");
  const issued = portal.files.filter((f) => f.kind === "issued");
  const empty = portal.files.length === 0;
  return (
    <div className={s.wrap}>
      <section className={s.hero}>
        <p className={s.eyebrow}>חבילת המסמכים לחודש {portal.periodLabel}</p>
        <h1 className={s.title}>{portal.businessName || "בעל העסק"}</h1>
        <p className={s.meta}>
          <span>גרסה {portal.packageVersion}</span>
          {portal.generatedAt ? <span>הוכנה ב־{dateHe(portal.generatedAt)}</span> : null}
          <span>הקישור בתוקף עד {dateHe(portal.expiresAt)}</span>
        </p>
      </section>

      <section className={s.stats} aria-label="סיכום החבילה">
        <div className={s.stat}>
          <div className={s.statValue}>{portal.counts.source}</div>
          <div className={s.statLabel}>מסמכי מקור</div>
        </div>
        <div className={s.stat}>
          <div className={s.statValue}>{portal.counts.issued}</div>
          <div className={s.statLabel}>מסמכים שהעסק הפיק</div>
        </div>
        <div className={`${s.stat} ${portal.counts.missing > 0 ? s.statWarn : ""}`}>
          <div className={s.statValue}>{portal.counts.missing}</div>
          <div className={s.statLabel}>קבצים חסרים</div>
        </div>
        <div className={`${s.stat} ${portal.counts.pending > 0 ? s.statWarn : ""}`}>
          <div className={s.statValue}>{portal.counts.pending}</div>
          <div className={s.statLabel}>ממתינים לבדיקת העסק</div>
        </div>
      </section>

      <section className={s.card}>
        <h2 className={s.cardTitle}>הורדת החבילה והדוחות</h2>
        <p className={s.cardText}>החבילה המלאה כוללת את כל המסמכים, הדוח המסכם ורשימת הפריטים הפתוחים.</p>
        <div className={s.downloads}>
          <button type="button" className={s.btnPrimary} disabled={!!busy} onClick={() => run("zip", { zip: true, mode: "download" })}>
            {busy === "zip" ? "מכין…" : "החבילה המלאה (ZIP)"}
          </button>
          <button type="button" className={s.btn} disabled={!!busy} onClick={() => run("xlsx", { report: "xlsx", mode: "download" })}>
            {busy === "xlsx" ? "מכין…" : "דוח Excel"}
          </button>
          <button type="button" className={s.btn} disabled={!!busy} onClick={() => run("pdf", { report: "pdf", mode: "view" })}>
            {busy === "pdf" ? "מכין…" : "דוח PDF"}
          </button>
        </div>
      </section>

      {portal.missing.length > 0 ? (
        <section className={`${s.card} ${s.missing}`}>
          <h2 className={s.cardTitle}>מסמכים שאינם בחבילה</h2>
          <p className={s.cardText}>הרשומות האלה מופיעות בדוח, אבל הקובץ שלהן לא צורף.</p>
          <ul className={s.missingList}>
            {portal.missing.map((m, i) => (
              <li key={i} className={s.missingItem}>
                <strong>{m.party || m.title}</strong>
                {m.date ? <span>{m.date}</span> : null}
                {m.amount ? <span className={s.amount}>{m.amount}</span> : null}
                <span className={s.missingReason}>{m.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {empty ? (
        <section className={s.card}>
          <h2 className={s.cardTitle}>אין מסמכים בחבילה</h2>
          <p className={s.cardText}>בחודש הזה לא נמצאו מסמכים לצרף. הדוחות עדיין זמינים להורדה.</p>
        </section>
      ) : null}

      <FileGroup title="מסמכי מקור" files={sources} busy={busy} run={run} />
      <FileGroup title="מסמכים שהעסק הפיק" files={issued} busy={busy} run={run} />

      <footer className={s.footer}>
        <p>
          כל קובץ נמסר בדיוק כפי שנשמר בחבילה שנשלחה, בלי שינוי. אי אפשר לערוך או למחוק דבר מכאן. כל צפייה והורדה
          נרשמות אצל בעל העסק.
        </p>
        <p>
          חתימת החבילה (SHA-256): <span className={s.mono}>{portal.packageSha256.slice(0, 16)}…</span>
        </p>
      </footer>
    </div>
  );
}

function FileGroup({ title, files, busy, run }: { title: string; files: PortalFile[]; busy: string | null; run: (id: string, a: Action) => void }) {
  if (files.length === 0) return null;
  return (
    <section>
      <h2 className={s.sectionTitle}>
        {title} <span className={s.sectionCount}>{files.length}</span>
      </h2>
      <ul className={s.files}>
        {files.map((f) => (
          <li key={f.path} className={s.file}>
            <div className={`${s.badge} ${f.kind === "issued" ? s.badgeIssued : ""}`} aria-hidden="true">
              {badgeOf(f)}
            </div>
            <div className={s.fileMain}>
              <p className={s.fileTitle}>{f.party || f.title}</p>
              <p className={s.fileMeta}>
                {f.party && f.title ? <span>{f.title}</span> : null}
                {f.date ? <span>{f.date}</span> : null}
                {f.amount ? (
                  <span className={s.amount}>
                    {f.amount}
                    {f.currency ? ` ${f.currency}` : ""}
                  </span>
                ) : null}
                <span>{sizeHe(f.size)}</span>
                {f.note ? <span>{f.note}</span> : null}
                {f.verified === true ? <span className={`${s.chip} ${s.chipOk}`}>מאומת מול הקובץ שנקלט</span> : null}
                {f.verified === false ? <span className={s.chip}>ללא אימות</span> : null}
              </p>
            </div>
            <div className={s.fileActions}>
              {f.viewable ? (
                <button type="button" className={s.btnGhost} disabled={!!busy} onClick={() => run(`v:${f.path}`, { file: f.path, mode: "view" })} aria-label={`צפייה ב־${f.party || f.title}`}>
                  {busy === `v:${f.path}` ? "פותח…" : "צפייה"}
                </button>
              ) : null}
              <button type="button" className={s.btn} disabled={!!busy} onClick={() => run(`d:${f.path}`, { file: f.path, mode: "download" })} aria-label={`הורדת ${f.party || f.title}`}>
                {busy === `d:${f.path}` ? "מוריד…" : "הורדה"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
