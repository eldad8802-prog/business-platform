"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  scoreAttachments,
  type EmailAttachmentUiStatus,
  type GmailDiscoveryAttachment,
  type ScoredAttachment,
} from "@/lib/services/email-import/scoring";
import { TOKEN } from "@/lib/design/documents-theme";
import { chipActionStyle, glassActionStyle, primaryActionStyle } from "@/lib/design/documents-theme";
import DocumentsBackButton from "@/components/documents/DocumentsBackButton";

type GmailConnectionSummary = {
  id: number;
  emailAddress: string;
  status: string;
  lastSyncedAt?: string | null;
};

type GmailStatusResponse =
  | { error: string }
  | {
      success: true;
      connected: boolean;
      emailAddress?: string;
      lastSyncedAt?: string | null;
      connections?: GmailConnectionSummary[];
    };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

// Friendly Hebrew copy for the whitelisted error codes the Gmail OAuth callback
// (app/api/integrations/gmail/callback) redirects back with on failure.
function gmailCallbackErrorMessage(code: string): string {
  switch (code) {
    case "google_access_denied":
      return "החיבור בוטל מול Google. אפשר לנסות שוב.";
    case "gmail_state_invalid":
      return "משהו נקטע באמצע החיבור ל-Gmail. נסה להתחבר שוב.";
    case "gmail_token_exchange_failed":
      return "לא הצלחנו להשלים את החיבור מול Google. נסה שוב עוד רגע.";
    case "max_accounts":
      return "אפשר לחבר עד שני חשבונות Gmail. כדי לחבר חשבון אחר, נתק חשבון קיים.";
    case "gmail_callback_failed":
    default:
      return "החיבור ל-Gmail לא הושלם. נסה שוב.";
  }
}

function formatSentAt(raw: string | null): string {
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
}

export default function EmailDocumentsPage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [emailAddress, setEmailAddress] = useState("");
  const [connections, setConnections] = useState<GmailConnectionSummary[]>([]);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<GmailDiscoveryAttachment[]>([]);
  const [statusByKey, setStatusByKey] = useState<Record<string, EmailAttachmentUiStatus>>({});
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void Promise.resolve().then(() => {
      setMounted(true);
      const token = window.localStorage.getItem("token");
      if (!token) {
        setAuthHeader(null);
        return;
      }
      setAuthHeader(`Bearer ${token}`);
    });
  }, []);

  // The Gmail OAuth callback redirects the browser back here with ?connected=1
  // on success or ?error=<code> on failure (it never renders raw JSON). Turn
  // that flag into a friendly toast, then strip the query so a refresh doesn't
  // replay it. The status fetch below independently confirms the real health.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const connectedFlag = params.get("connected");
    const errorFlag = params.get("error");
    if (!connectedFlag && !errorFlag) return;

    // Defer the state update out of the synchronous effect body (same pattern as
    // the mount effect above) to avoid cascading renders.
    void Promise.resolve().then(() => {
      if (connectedFlag === "1") {
        setNotice("חשבון ה-Gmail חובר בהצלחה. סורק מיילים אחרונים...");
      } else if (errorFlag) {
        setError(gmailCallbackErrorMessage(errorFlag));
      }
      window.history.replaceState({}, "", "/documents/email");
    });
  }, []);

  useEffect(() => {
    if (!authHeader) return;
    void Promise.resolve().then(async () => {
      try {
        const response = await fetch("/api/integrations/gmail/status", {
          headers: { authorization: authHeader },
        });
        const data = (await response.json()) as GmailStatusResponse;
        if (!response.ok || "error" in data) {
          setConnected(false);
          return;
        }
        setConnected(Boolean(data.connected));
        setEmailAddress(data.emailAddress || "");
        setConnections(Array.isArray(data.connections) ? data.connections : []);
        if (data.connected) void runScan(10, authHeader);
      } catch {
        setConnected(false);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authHeader]);

  const visible = useMemo(
    () =>
      scoreAttachments(attachments)
        .filter((attachment) => attachment.bucket !== "hidden")
        .sort((a, b) => b.score - a.score),
    [attachments]
  );
  const importable = useMemo(
    () =>
      visible.filter(
        (attachment) =>
          attachment.bucket === "recommended" &&
          (statusByKey[attachment.key] || "pending") === "pending"
      ),
    [statusByKey, visible]
  );

  async function startConnect() {
    if (!authHeader) return;
    try {
      setError("");
      const response = await fetch("/api/integrations/gmail/connect", {
        headers: {
          accept: "application/json",
          authorization: authHeader,
          "x-gmail-connect-mode": "json",
        },
      });
      const data = (await response.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!response.ok || !data.url) {
        throw new Error(data.error || "לא הצלחנו לפתוח את החיבור ל-Gmail");
      }
      window.location.href = data.url;
    } catch (err) {
      setError(errorMessage(err, "שגיאה בחיבור Gmail"));
    }
  }

  async function disconnectAccount(connectionId: number) {
    if (!authHeader) return;
    setDisconnectingId(connectionId);
    setError("");
    try {
      const response = await fetch("/api/integrations/gmail/disconnect", {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      if (!response.ok) {
        throw new Error("לא הצלחנו לנתק את החשבון. נסה שוב.");
      }
      const next = connections.map((c) =>
        c.id === connectionId ? { ...c, status: "revoked" } : c
      );
      setConnections(next);
      const stillConnected = next.some((c) => c.status === "connected");
      setConnected(stillConnected);
      if (!stillConnected) {
        setEmailAddress("");
        setAttachments([]);
        setStatusByKey({});
      }
      setNotice("החשבון נותק.");
    } catch (err) {
      setError(errorMessage(err, "שגיאה בניתוק החשבון"));
    } finally {
      setDisconnectingId(null);
      setConfirmingId(null);
    }
  }

  async function runScan(maxMessages: number, header = authHeader) {
    if (!header) return;
    try {
      setLoading(true);
      setError("");
      const response = await fetch(
        `/api/integrations/gmail/sync?maxMessages=${encodeURIComponent(String(maxMessages))}`,
        { headers: { authorization: header } }
      );
      const data = await response.json();
      if (response.status === 409 || data?.needsReconnect) {
        // Token is no longer usable (key rotated / refresh revoked). Reflect the
        // real connection health so the user sees the reconnect CTA instead of a
        // stale "Connected" + cryptic error.
        setConnected(false);
        setAttachments([]);
        setError("החיבור ל-Gmail פג. חבר מחדש כדי להמשיך.");
        return;
      }
      if (!response.ok) throw new Error(data?.error || "שגיאה בסריקת מיילים");
      const list: GmailDiscoveryAttachment[] = Array.isArray(data.attachments)
        ? data.attachments
        : [];
      setAttachments(list);
      const scored = scoreAttachments(list).filter((item) => item.bucket !== "hidden");
      const nextStatus: Record<string, EmailAttachmentUiStatus> = {};
      for (const attachment of scored) {
        nextStatus[attachment.key] = "pending";
      }
      setStatusByKey(nextStatus);
    } catch (err) {
      setError(errorMessage(err, "שגיאה בסריקת מיילים"));
    } finally {
      setLoading(false);
    }
  }

  async function importOne(attachment: ScoredAttachment) {
    if (!authHeader) return false;
    setStatusByKey((current) => ({ ...current, [attachment.key]: "importing" }));
    try {
      const response = await fetch("/api/integrations/gmail/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: authHeader,
        },
        body: JSON.stringify({
          messageId: attachment.messageId,
          attachmentId: attachment.attachmentId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          fromEmail: attachment.fromEmail,
          subject: attachment.subject,
          sentAt: attachment.sentAt,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 || data?.needsReconnect) {
        setConnected(false);
        setError("החיבור ל-Gmail פג. חבר מחדש כדי להמשיך.");
        setStatusByKey((current) => ({ ...current, [attachment.key]: "failed" }));
        return false;
      }
      const status =
        !response.ok
          ? "failed"
          : data?.imported === false && data?.skipped === "duplicate"
            ? "duplicate"
            : "imported";
      setStatusByKey((current) => ({ ...current, [attachment.key]: status }));
      return status === "imported";
    } catch {
      setStatusByKey((current) => ({ ...current, [attachment.key]: "failed" }));
      return false;
    }
  }

  async function importSelected() {
    if (!importable.length) return;
    setImporting(true);
    try {
      for (const attachment of importable) {
        await importOne(attachment);
      }
    } finally {
      setImporting(false);
    }
  }

  if (!mounted) {
    return (
      <div dir="rtl" style={pageStyle}>
        <main style={mainStyle}>
          <Header onBack={() => router.push("/documents")} />
          <div style={emptyStyle}>טוען...</div>
        </main>
      </div>
    );
  }

  if (!authHeader) {
    return (
      <div dir="rtl" style={pageStyle}>
        <main style={mainStyle}>
          <Header onBack={() => router.push("/documents")} />
          <section style={emptyStyle}>
            צריך להתחבר כדי לייבא מסמכים מהמייל.
            <Link href="/login" style={loginLinkStyle}>
              התחבר
            </Link>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div dir="rtl" style={pageStyle}>
      <main style={mainStyle}>
        <Header onBack={() => router.push("/documents")} />

        <section
          style={{
            ...bandStyle,
            border: `1px solid ${
              connected ? TOKEN.semantic.success.border : TOKEN.semantic.attention.border
            }`,
            background: connected
              ? TOKEN.semantic.success.bgSoft
              : TOKEN.semantic.attention.bgSoft,
            color: connected ? TOKEN.semantic.success.ink : TOKEN.semantic.attention.ink,
          }}
        >
          {connected ? <CheckIcon /> : <WarningIcon />}
          {connected ? `מחובר: ${emailAddress || "Gmail"}` : "Gmail לא מחובר"}
        </section>

        {connections.length > 0 ? (
          <section style={accountsCardStyle}>
            <div style={accountsTitleStyle}>חשבונות Gmail</div>
            {connections.map((c) => (
              <div key={c.id} style={accountRowStyle}>
                <div style={accountEmailStyle}>{c.emailAddress}</div>
                <span
                  style={
                    c.status === "connected"
                      ? accountBadgeConnectedStyle
                      : accountBadgeRevokedStyle
                  }
                >
                  {c.status === "connected" ? "מחובר" : "מנותק"}
                </span>
                {c.status === "connected" ? (
                  confirmingId === c.id ? (
                    <span style={confirmWrapStyle}>
                      <button
                        type="button"
                        style={confirmYesStyle}
                        disabled={disconnectingId === c.id}
                        onClick={() => void disconnectAccount(c.id)}
                      >
                        {disconnectingId === c.id ? "מנתק…" : "אשר ניתוק"}
                      </button>
                      <button
                        type="button"
                        style={confirmNoStyle}
                        onClick={() => setConfirmingId(null)}
                      >
                        בטל
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      style={disconnectBtnStyle}
                      onClick={() => setConfirmingId(c.id)}
                    >
                      נתק
                    </button>
                  )
                ) : null}
              </div>
            ))}
            {connected ? (
              <div style={prepNoteStyle}>
                תמיכה בחיבור חשבון נוסף תתווסף בשלב הבא.
              </div>
            ) : null}
          </section>
        ) : null}

        {notice ? <div style={noticeStyle}>{notice}</div> : null}

        {!connected ? (
          <button type="button" onClick={() => void startConnect()} style={connectButtonStyle}>
            חבר Gmail
          </button>
        ) : null}

        {connected ? (<>

        <div style={subStyle}>קבצים מצורפים שזוהו · ייבוא יריץ OCR ויעביר לתור האימות</div>

        {loading ? <div style={emptyStyle}>סורק מיילים...</div> : null}

        </>) : null}
        {error ? <div style={errorStyle}>{error}</div> : null}

        {connected && !loading && visible.length === 0 ? (
          <section style={emptyStyle}>
            לא נמצאו קבצים לייבוא.
            <button type="button" onClick={() => void runScan(30)} style={scanButtonStyle}>
              סרוק שוב
            </button>
          </section>
        ) : null}

        {connected ? <section style={rowsStyle}>
          {visible.map((attachment) => {
            const status = statusByKey[attachment.key] || "pending";
            const canImport = attachment.bucket === "recommended" && status === "pending";
            return (
              <article key={attachment.key} style={rowStyle}>
                <span style={thumbStyle} aria-hidden>
                  {attachment.mimeType.includes("pdf") ? "📄" : "📎"}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={rowTitleStyle}>{attachment.filename || "קובץ ללא שם"}</span>
                  <span style={rowMetaStyle}>
                    מ-{attachment.fromEmail || "לא צוין"}
                    {attachment.sentAt ? ` · ${formatSentAt(attachment.sentAt)}` : ""}
                    {canImport ? " · חדש" : ""}
                  </span>
                </span>
                <span style={trailStyle}>
                  {canImport ? (
                    <button
                      type="button"
                      disabled={importing}
                      onClick={() => void importOne(attachment)}
                      style={smallButtonStyle}
                    >
                      קלוט
                    </button>
                  ) : (
                    <span style={pillStyleFor(status, attachment.bucket)}>
                      {status === "imported"
                        ? "נקלט · בתור"
                        : status === "duplicate"
                          ? "כבר נקלט"
                          : status === "importing"
                            ? "קולט..."
                            : status === "failed"
                              ? "נכשל"
                              : "לא מסמך"}
                    </span>
                  )}
                </span>
              </article>
            );
          })}
        </section> : null}
      </main>

      {connected ? <div style={bottomBarStyle}>
        <button
          type="button"
          disabled={importing || importable.length === 0}
          onClick={() => void importSelected()}
          style={{
            ...importButtonStyle,
            opacity: importing || importable.length === 0 ? 0.65 : 1,
            cursor: importing || importable.length === 0 ? "not-allowed" : "pointer",
          }}
        >
          {importing
            ? "מייבא..."
            : `ייבא הכל (${importable.length.toLocaleString("he-IL")})`}
        </button>
      </div> : null}
    </div>
  );
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <header style={headStyle}>
      <DocumentsBackButton onClick={onBack} />
      <h1 style={titleStyle}>קליטה מ-Gmail</h1>
      <div aria-hidden style={{ width: 52 }} />
    </header>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

const pageStyle = {
  minHeight: "100vh",
  background: TOKEN.surface.page,
  color: TOKEN.ink.primary,
  paddingBottom: 110,
} as const;

const mainStyle = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "14px 14px 40px",
  boxSizing: "border-box",
} as const;

const headStyle = {
  display: "grid",
  gridTemplateColumns: "auto 1fr 52px",
  alignItems: "center",
  gap: 10,
  marginBottom: 14,
} as const;

const titleStyle = {
  margin: 0,
  textAlign: "center",
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.display,
  fontWeight: TOKEN.weight.bold,
} as const;

const bandStyle = {
  minHeight: 52,
  borderRadius: TOKEN.radius.card,
  padding: "0 14px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
} as const;

const connectButtonStyle = {
  ...primaryActionStyle({ fullWidth: true, height: 52 }),
  width: "100%",
  minHeight: 52,
  marginTop: 12,
  fontSize: TOKEN.font.body,
} as const;

const accountsCardStyle = {
  marginTop: 12,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.card,
  borderRadius: TOKEN.radius.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: 14,
} as const;

const accountsTitleStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  marginBottom: 10,
} as const;

const accountRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 0",
  flexWrap: "wrap" as const,
} as const;

const accountEmailStyle = {
  flex: 1,
  minWidth: 0,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
} as const;

const accountBadgeBaseStyle = {
  borderRadius: TOKEN.radius.pill,
  padding: "3px 9px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  flexShrink: 0,
} as const;

const accountBadgeConnectedStyle = {
  ...accountBadgeBaseStyle,
  background: TOKEN.semantic.success.bgSoft,
  color: TOKEN.semantic.success.ink,
} as const;

const accountBadgeRevokedStyle = {
  ...accountBadgeBaseStyle,
  background: TOKEN.surface.inset,
  color: TOKEN.ink.muted,
} as const;

const disconnectBtnStyle = {
  minHeight: 36,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.button,
  background: TOKEN.surface.card,
  color: TOKEN.ink.secondary,
  padding: "0 14px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
  flexShrink: 0,
} as const;

const confirmWrapStyle = {
  display: "flex",
  gap: 6,
  flexShrink: 0,
} as const;

const confirmYesStyle = {
  minHeight: 36,
  border: "none",
  borderRadius: TOKEN.radius.button,
  background: TOKEN.semantic.urgent.ink,
  color: TOKEN.ink.inverse,
  padding: "0 12px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
} as const;

const confirmNoStyle = {
  minHeight: 36,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.button,
  background: TOKEN.surface.card,
  color: TOKEN.ink.secondary,
  padding: "0 12px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
} as const;

const prepNoteStyle = {
  marginTop: 10,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  lineHeight: 1.5,
} as const;

const subStyle = {
  paddingTop: 14,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
} as const;

const rowsStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  paddingTop: 12,
} as const;

const rowStyle = {
  minHeight: 74,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  padding: 12,
  display: "flex",
  alignItems: "center",
  gap: 12,
} as const;

const thumbStyle = {
  width: 50,
  height: 50,
  borderRadius: TOKEN.radius.input,
  background: TOKEN.surface.inset,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 22,
  flexShrink: 0,
} as const;

const rowTitleStyle = {
  display: "block",
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const rowMetaStyle = {
  display: "block",
  marginTop: 1,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.medium,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const trailStyle = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 7,
  flexShrink: 0,
} as const;

const smallButtonStyle = {
  ...glassActionStyle({ height: 38 }),
  minHeight: 38,
  padding: "0 16px",
  fontSize: TOKEN.font.meta,
  whiteSpace: "nowrap",
} as const;

function pillStyleFor(status: EmailAttachmentUiStatus, bucket: ScoredAttachment["bucket"]) {
  const ok = status === "imported" || status === "duplicate";
  const urgent = status === "failed";
  const neutral = bucket !== "recommended" || status === "pending";

  return {
    borderRadius: TOKEN.radius.pill,
    background: ok
      ? TOKEN.semantic.success.bgSoft
      : urgent
        ? TOKEN.semantic.urgent.bgSoft
        : TOKEN.surface.inset,
    border: `1px solid ${
      ok
        ? TOKEN.semantic.success.border
        : urgent
          ? TOKEN.semantic.urgent.border
          : TOKEN.border.DEFAULT
    }`,
    color: ok
      ? TOKEN.semantic.success.ink
      : urgent
        ? TOKEN.semantic.urgent.ink
        : neutral
          ? TOKEN.ink.secondary
          : TOKEN.brand.mid,
    padding: "4px 10px",
    fontSize: TOKEN.font.meta,
    fontWeight: TOKEN.weight.bold,
    whiteSpace: "nowrap" as const,
  };
}

const bottomBarStyle = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  background: TOKEN.surface.card,
  borderTop: `1px solid ${TOKEN.border.DEFAULT}`,
  padding: "12px 14px 22px",
  boxShadow: TOKEN.shadow.floating,
} as const;

const importButtonStyle = {
  ...primaryActionStyle({ height: 52 }),
  width: "min(492px, 100%)",
  minHeight: 52,
  margin: "0 auto",
  display: "block",
  fontSize: TOKEN.font.body,
} as const;

const emptyStyle = {
  marginTop: 14,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: TOKEN.space.lg,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
  textAlign: "center",
} as const;

const errorStyle = {
  ...emptyStyle,
  border: `1px solid ${TOKEN.semantic.urgent.border}`,
  background: TOKEN.semantic.urgent.bgSoft,
  color: TOKEN.semantic.urgent.ink,
} as const;

const noticeStyle = {
  ...emptyStyle,
  border: `1px solid ${TOKEN.semantic.success.border}`,
  background: TOKEN.semantic.success.bgSoft,
  color: TOKEN.semantic.success.ink,
} as const;

const scanButtonStyle = {
  ...chipActionStyle(false),
  display: "block",
  minHeight: 38,
  margin: "12px auto 0",
  padding: "0 14px",
  fontSize: TOKEN.font.body,
} as const;

const loginLinkStyle = {
  display: "inline-block",
  marginInlineStart: 8,
  color: TOKEN.brand.mid,
  fontWeight: TOKEN.weight.bold,
} as const;


