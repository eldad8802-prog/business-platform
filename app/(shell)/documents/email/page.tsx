"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  card,
  primaryBtn,
  secondaryBtn,
  emptyState,
  pageMain,
  alertError,
  alertSuccess,
  cardTitle,
  cardSubText,
  iconWrap,
} from "../ui";
import {
  scoreAttachments,
  type EmailAttachmentUiStatus,
  type GmailDiscoveryAttachment,
  type ScoredAttachment,
} from "@/lib/services/email-import/scoring";

type GmailStatusResponse =
  | { error: string }
  | {
      success: true;
      connected: boolean;
      emailAddress?: string;
      status?: string;
      lastSyncedAt?: string | null;
    };

type ImportSummary = {
  imported: number;
  duplicates: number;
  failed: number;
  lastDocumentId: number | null;
};

const btnFlex = {
  display: "flex" as const,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  gap: 10,
};

const cardHeaderRow = {
  display: "flex" as const,
  alignItems: "center" as const,
  gap: 12,
  marginBottom: 12,
};

const rowCard = {
  border: "1px solid #e5e7eb",
  borderRadius: 18,
  padding: 14,
  background: "#ffffff",
  display: "flex" as const,
  flexDirection: "column" as const,
  gap: 10,
};

const badgeBase = {
  display: "inline-block",
  padding: "2px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 800,
  lineHeight: 1.6,
};

const badgeRecommended = {
  ...badgeBase,
  background: "#ecfdf5",
  color: "#065f46",
  border: "1px solid #bbf7d0",
};

const badgePossible = {
  ...badgeBase,
  background: "#fefce8",
  color: "#854d0e",
  border: "1px solid #fde68a",
};

const badgeNeutral = {
  ...badgeBase,
  background: "#f3f4f6",
  color: "#374151",
  border: "1px solid #e5e7eb",
};

const statusBadgeStyle = (status: EmailAttachmentUiStatus) => {
  if (status === "imported")
    return {
      ...badgeBase,
      background: "#ecfdf5",
      color: "#065f46",
      border: "1px solid #bbf7d0",
    };
  if (status === "duplicate")
    return {
      ...badgeBase,
      background: "#eff6ff",
      color: "#1e40af",
      border: "1px solid #bfdbfe",
    };
  if (status === "failed")
    return {
      ...badgeBase,
      background: "#fef2f2",
      color: "#991b1b",
      border: "1px solid #fecaca",
    };
  if (status === "importing")
    return {
      ...badgeBase,
      background: "#fef3c7",
      color: "#92400e",
      border: "1px solid #fde68a",
    };
  return badgeNeutral;
};

const statusLabel = (status: EmailAttachmentUiStatus) => {
  switch (status) {
    case "imported":
      return "יובא";
    case "duplicate":
      return "כפילות";
    case "failed":
      return "נכשל";
    case "importing":
      return "מייבא...";
    default:
      return "ממתין";
  }
};

const docTypeLabel = (mimeType: string) => {
  const m = mimeType.toLowerCase();
  if (m === "application/pdf") return "PDF";
  if (m.startsWith("image/")) return "תמונה";
  return "קובץ";
};

const formatSentAt = (sentAt: string | null): string => {
  if (!sentAt) return "";
  try {
    const d = new Date(sentAt);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("he-IL", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return "";
  }
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function EmailDocumentsPage() {
  const router = useRouter();

  // Hydration gate: avoids SSR/CSR mismatch since the auth state is read from
  // localStorage which is only available on the client. Render a stable
  // placeholder for the very first paint and then reveal the real state.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    void Promise.resolve().then(() => setMounted(true));
  }, []);

  // Synchronous, client-only auth header (mirrors the upload page pattern).
  // On SSR `window` is undefined, so this returns null. On the client, after
  // hydration, the same useMemo runs once and returns the bearer token.
  const authHeader = useMemo<string | null>(() => {
    if (typeof window === "undefined") return null;
    const token = window.localStorage.getItem("token");
    return token ? `Bearer ${token}` : null;
  }, []);

  // Gmail connection state
  const [statusLoading, setStatusLoading] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [emailAddress, setEmailAddress] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState("");
  const [statusError, setStatusError] = useState("");

  // Scan state
  const [attachments, setAttachments] = useState<GmailDiscoveryAttachment[]>([]);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState("");
  const [scanned, setScanned] = useState(false);

  // Selection + per-row status
  const [selectedKeys, setSelectedKeys] = useState<Record<string, boolean>>({});
  const [importStatusByKey, setImportStatusByKey] = useState<
    Record<string, EmailAttachmentUiStatus>
  >({});

  // Bulk import
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  async function refreshStatus() {
    if (!authHeader) return;
    setStatusLoading(true);
    setStatusError("");
    try {
      const res = await fetch("/api/integrations/gmail/status", {
        headers: { authorization: authHeader },
      });
      const data = (await res.json()) as GmailStatusResponse;
      if (!res.ok) {
        setConnected(null);
        setStatusError("לא ניתן לקרוא סטטוס Gmail");
        return;
      }
      if ("error" in data) {
        setConnected(null);
        setStatusError(data.error || "שגיאת סטטוס Gmail");
        return;
      }
      setConnected(Boolean(data.connected));
      setEmailAddress(data.emailAddress || "");
      setLastSyncedAt(data.lastSyncedAt ? String(data.lastSyncedAt) : "");
    } catch (e: unknown) {
      setConnected(null);
      setStatusError(errorMessage(e, "שגיאה בסטטוס Gmail"));
    } finally {
      setStatusLoading(false);
    }
  }

  // ── Refresh Gmail status once after hydration (only if logged in) ──────────
  useEffect(() => {
    if (!mounted) return;
    void Promise.resolve().then(() => {
      if (!authHeader) {
        setConnected(false);
        return;
      }
      void refreshStatus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, authHeader]);

  async function startConnect() {
    if (!authHeader) return;
    try {
      setStatusError("");
      const res = await fetch("/api/integrations/gmail/connect", {
        headers: { authorization: authHeader },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || "שגיאה בחיבור Gmail");
      }
      if (!data?.url) throw new Error("Missing authorize URL");
      window.location.href = data.url;
    } catch (e: unknown) {
      setStatusError(errorMessage(e, "שגיאה בחיבור Gmail"));
    }
  }

  async function runScan(maxMessages: number) {
    if (!authHeader) return;
    setScanLoading(true);
    setScanError("");
    setSummary(null);
    setBulkProgress(null);
    try {
      const res = await fetch(
        `/api/integrations/gmail/sync?maxMessages=${encodeURIComponent(
          String(maxMessages)
        )}`,
        { headers: { authorization: authHeader } }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Scan failed");
      const list: GmailDiscoveryAttachment[] = Array.isArray(data.attachments)
        ? data.attachments
        : [];
      setAttachments(list);
      setScanned(true);

      // Pre-select recommended attachments by default; reset others.
      const scored = scoreAttachments(list);
      const nextSelected: Record<string, boolean> = {};
      const nextStatus: Record<string, EmailAttachmentUiStatus> = {};
      for (const a of scored) {
        if (a.bucket === "recommended") nextSelected[a.key] = true;
        nextStatus[a.key] = "pending";
      }
      setSelectedKeys(nextSelected);
      setImportStatusByKey(nextStatus);
    } catch (e: unknown) {
      setScanError(errorMessage(e, "שגיאה בסריקת מיילים"));
    } finally {
      setScanLoading(false);
    }
  }

  // ── Derived: scored, visible, counts ───────────────────────────────────────
  const scored = useMemo(() => scoreAttachments(attachments), [attachments]);

  const visible = useMemo(() => {
    return scored
      .filter((a) => a.bucket !== "hidden")
      .sort((a, b) => b.score - a.score);
  }, [scored]);

  const recommendedCount = useMemo(
    () => scored.filter((a) => a.bucket === "recommended").length,
    [scored]
  );
  const possibleCount = useMemo(
    () => scored.filter((a) => a.bucket === "possible").length,
    [scored]
  );

  const selectedCount = useMemo(
    () =>
      visible.reduce((acc, a) => acc + (selectedKeys[a.key] ? 1 : 0), 0),
    [visible, selectedKeys]
  );

  const allVisibleSelected =
    visible.length > 0 && selectedCount === visible.length;

  // ── Selection helpers ──────────────────────────────────────────────────────
  function toggleOne(key: string, value?: boolean) {
    setSelectedKeys((prev) => ({
      ...prev,
      [key]: value !== undefined ? value : !prev[key],
    }));
  }

  function selectAllVisible() {
    setSelectedKeys((prev) => {
      const next = { ...prev };
      for (const a of visible) next[a.key] = true;
      return next;
    });
  }

  function clearAllVisible() {
    setSelectedKeys((prev) => {
      const next = { ...prev };
      for (const a of visible) next[a.key] = false;
      return next;
    });
  }

  // ── Import logic (single + bulk-of-list) ───────────────────────────────────
  async function importSingle(a: ScoredAttachment): Promise<{
    outcome: "imported" | "duplicate" | "failed";
    documentId: number | null;
  }> {
    if (!authHeader) return { outcome: "failed", documentId: null };
    setImportStatusByKey((m) => ({ ...m, [a.key]: "importing" }));

    try {
      const res = await fetch("/api/integrations/gmail/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: authHeader,
        },
        body: JSON.stringify({
          messageId: a.messageId,
          attachmentId: a.attachmentId,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          fromEmail: a.fromEmail,
          subject: a.subject,
          sentAt: a.sentAt,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setImportStatusByKey((m) => ({ ...m, [a.key]: "failed" }));
        return { outcome: "failed", documentId: null };
      }

      if (data?.imported === false && data?.skipped === "duplicate") {
        setImportStatusByKey((m) => ({ ...m, [a.key]: "duplicate" }));
        return { outcome: "duplicate", documentId: null };
      }

      if (data?.documentId) {
        setImportStatusByKey((m) => ({ ...m, [a.key]: "imported" }));
        return { outcome: "imported", documentId: Number(data.documentId) };
      }

      setImportStatusByKey((m) => ({ ...m, [a.key]: "failed" }));
      return { outcome: "failed", documentId: null };
    } catch {
      setImportStatusByKey((m) => ({ ...m, [a.key]: "failed" }));
      return { outcome: "failed", documentId: null };
    }
  }

  async function importList(list: ScoredAttachment[]) {
    if (!authHeader) return;
    if (!list.length) return;

    setBulkRunning(true);
    setSummary(null);
    setBulkProgress({ current: 0, total: list.length });

    let imported = 0;
    let duplicates = 0;
    let failed = 0;
    let lastDocumentId: number | null = null;

    let i = 0;
    try {
      for (const a of list) {
        const current = importStatusByKey[a.key];
        if (current === "imported" || current === "duplicate") {
          i += 1;
          setBulkProgress({ current: i, total: list.length });
          if (current === "duplicate") duplicates += 1;
          else imported += 1;
          continue;
        }

        i += 1;
        setBulkProgress({ current: i, total: list.length });

        const result = await importSingle(a);
        if (result.outcome === "imported") {
          imported += 1;
          if (result.documentId) lastDocumentId = result.documentId;
        } else if (result.outcome === "duplicate") {
          duplicates += 1;
        } else {
          failed += 1;
        }
      }

      setSummary({ imported, duplicates, failed, lastDocumentId });
    } finally {
      setBulkRunning(false);
      setBulkProgress(null);
    }
  }

  function importSelected() {
    const list = visible.filter((a) => selectedKeys[a.key]);
    void importList(list);
  }

  function importAllVisible() {
    void importList(visible);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  // The status card is ALWAYS rendered so the page never looks empty. Inner
  // copy/CTA branches on `mounted` (avoids hydration flash) → `authHeader`
  // (logged in to platform?) → `connected` (Gmail linked?) → `scanned`.
  const statusBlurb = !mounted
    ? "טוען..."
    : !authHeader
      ? "צריך להתחבר למערכת קודם כדי לייבא מהמייל"
      : statusLoading
        ? "בודק סטטוס Gmail..."
        : connected
          ? emailAddress
            ? `מחובר כ־${emailAddress}`
            : "Gmail מחובר"
          : "Gmail לא מחובר";

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: "#f3f7ff" }}>
      <main style={{ ...pageMain, maxWidth: 760 }}>
        <section style={{ textAlign: "center", padding: "4px 0 2px" }}>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 999,
              background: "#002b6b",
              color: "#ffffff",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              fontWeight: 950,
              marginBottom: 8,
            }}
          >
            1
          </div>
          <h1 style={{ margin: 0, color: "#0f172a", fontSize: 28, fontWeight: 950 }}>
            ייבוא מסמכים מהמייל
          </h1>
          <p
            style={{
              margin: "6px 0 0",
              color: "#64748b",
              fontSize: 14,
              lineHeight: 1.6,
              fontWeight: 800,
            }}
          >
            חבר Gmail, סרוק מסמכים רלוונטיים, ופתח אותם מיד לבדיקה.
          </p>
        </section>

        {/* Always-rendered status card — no auth gating around the container */}
        <section style={{ ...card, borderRadius: 18, borderColor: "#dfe7f3" }}>
          <div style={cardHeaderRow}>
            <div style={iconWrap} aria-hidden>
              📧
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={cardTitle}>חיבור Gmail</div>
              <div style={cardSubText}>{statusBlurb}</div>
              {mounted && authHeader && connected && lastSyncedAt ? (
                <div style={{ ...cardSubText, marginTop: 4 }}>
                  Sync אחרון: {lastSyncedAt}
                </div>
              ) : null}
            </div>
          </div>

          {statusError ? (
            <div style={{ ...alertError, marginTop: 10 }}>{statusError}</div>
          ) : null}

          {/* CTA branch */}
          {!mounted ? null : !authHeader ? (
            <Link
              href="/login"
              style={{
                ...primaryBtn,
                ...btnFlex,
                textDecoration: "none",
              }}
            >
              <span aria-hidden>🔐</span>
              <span>התחבר למערכת</span>
            </Link>
          ) : !connected ? (
            <button
              type="button"
              disabled={statusLoading}
              style={{
                ...primaryBtn,
                ...btnFlex,
                opacity: statusLoading ? 0.6 : 1,
              }}
              onClick={() => void startConnect()}
            >
              <span aria-hidden>🔗</span>
              <span>חבר Gmail</span>
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                type="button"
                disabled={scanLoading || bulkRunning}
                style={{
                  ...primaryBtn,
                  ...btnFlex,
                  opacity: scanLoading || bulkRunning ? 0.6 : 1,
                }}
                onClick={() => void runScan(10)}
              >
                <span aria-hidden>🔎</span>
                <span>{scanLoading ? "סורק מיילים..." : "סרוק עכשיו"}</span>
              </button>

              {scanned && !scanLoading ? (
                <button
                  type="button"
                  disabled={scanLoading || bulkRunning}
                  style={{
                    ...secondaryBtn,
                    ...btnFlex,
                    marginTop: 0,
                    opacity: scanLoading || bulkRunning ? 0.6 : 1,
                  }}
                  onClick={() => void runScan(30)}
                >
                  <span aria-hidden>🔁</span>
                  <span>סרוק יותר (30 הודעות)</span>
                </button>
              ) : null}
            </div>
          )}
        </section>

        {scanError ? <div style={alertError}>{scanError}</div> : null}

        {/* Results section */}
        {mounted && authHeader && connected && scanned && !scanLoading ? (
          visible.length === 0 ? (
            <div style={emptyState}>
              לא נמצאו מסמכים לייבוא במיילים האחרונים.
            </div>
          ) : (
            <section style={card}>
              <div style={cardHeaderRow}>
                <div style={iconWrap} aria-hidden>
                  📨
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={cardTitle}>
                    נמצאו {visible.length} מסמכים
                  </div>
                  <div style={cardSubText}>
                    {recommendedCount} מומלצים · {possibleCount} אולי רלוונטיים
                  </div>
                </div>
              </div>

              {/* Top action bar */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  marginBottom: 14,
                }}
              >
                <button
                  type="button"
                  disabled={bulkRunning || selectedCount === 0}
                  style={{
                    ...primaryBtn,
                    ...btnFlex,
                    marginTop: 0,
                    opacity: bulkRunning || selectedCount === 0 ? 0.6 : 1,
                  }}
                  onClick={importSelected}
                >
                  <span aria-hidden>📥</span>
                  <span>
                    {bulkRunning
                      ? "מייבא..."
                      : `ייבא נבחרים (${selectedCount})`}
                  </span>
                </button>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    disabled={bulkRunning || visible.length === 0}
                    style={{
                      ...secondaryBtn,
                      ...btnFlex,
                      marginTop: 0,
                      flex: 1,
                      opacity: bulkRunning || visible.length === 0 ? 0.6 : 1,
                    }}
                    onClick={importAllVisible}
                  >
                    <span aria-hidden>📦</span>
                    <span>ייבא הכל</span>
                  </button>

                  <button
                    type="button"
                    disabled={bulkRunning}
                    style={{
                      ...secondaryBtn,
                      ...btnFlex,
                      marginTop: 0,
                      flex: 1,
                      opacity: bulkRunning ? 0.6 : 1,
                    }}
                    onClick={
                      allVisibleSelected ? clearAllVisible : selectAllVisible
                    }
                  >
                    <span aria-hidden>{allVisibleSelected ? "✖️" : "✅"}</span>
                    <span>{allVisibleSelected ? "נקה הכל" : "סמן הכל"}</span>
                  </button>
                </div>
              </div>

              {bulkProgress ? (
                <div style={{ ...cardSubText, marginBottom: 10 }}>
                  מייבא {bulkProgress.current} מתוך {bulkProgress.total}
                </div>
              ) : null}

              {summary ? (
                <div style={{ ...alertSuccess, marginBottom: 12 }}>
                  <div style={{ marginBottom: 6 }}>
                    יובאו {summary.imported} · כפילויות {summary.duplicates} ·
                    נכשלו {summary.failed}
                  </div>
                  {summary.lastDocumentId ? (
                    <button
                      type="button"
                      style={{
                        ...secondaryBtn,
                        ...btnFlex,
                        marginTop: 8,
                      }}
                      onClick={() =>
                        router.push(
                          `/documents/review/${summary.lastDocumentId}`
                        )
                      }
                    >
                      <span aria-hidden>📄</span>
                      <span>פתח מסמך אחרון</span>
                    </button>
                  ) : null}
                </div>
              ) : null}

              {/* Attachments list */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                {visible.map((a) => {
                  const status = importStatusByKey[a.key] || "pending";
                  const isSelected = Boolean(selectedKeys[a.key]);
                  const isLocked =
                    status === "imported" ||
                    status === "importing" ||
                    bulkRunning;

                  return (
                    <div key={a.key} style={rowCard}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 12,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isLocked}
                          onChange={(e) =>
                            toggleOne(a.key, e.target.checked)
                          }
                          aria-label={`בחר ${a.filename || "קובץ"}`}
                          style={{
                            width: 20,
                            height: 20,
                            marginTop: 4,
                            flexShrink: 0,
                            cursor: isLocked ? "not-allowed" : "pointer",
                          }}
                        />

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              ...cardTitle,
                              marginBottom: 6,
                              wordBreak: "break-word",
                            }}
                          >
                            {a.filename || "(ללא שם קובץ)"}
                          </div>

                          <div style={cardSubText}>
                            {a.fromEmail || "—"}
                            {a.sentAt ? ` · ${formatSentAt(a.sentAt)}` : ""}
                          </div>

                          {a.subject ? (
                            <div
                              style={{
                                ...cardSubText,
                                marginTop: 4,
                                display: "-webkit-box",
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: "vertical",
                                overflow: "hidden",
                              }}
                            >
                              {a.subject}
                            </div>
                          ) : null}

                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              flexWrap: "wrap",
                              marginTop: 10,
                            }}
                          >
                            <span style={badgeNeutral}>
                              {docTypeLabel(a.mimeType)}
                            </span>
                            <span
                              style={
                                a.bucket === "recommended"
                                  ? badgeRecommended
                                  : badgePossible
                              }
                            >
                              {a.bucket === "recommended"
                                ? "מומלץ"
                                : "אולי"}
                            </span>
                            <span style={statusBadgeStyle(status)}>
                              {statusLabel(status)}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          justifyContent: "flex-end",
                        }}
                      >
                        <button
                          type="button"
                          disabled={isLocked}
                          style={{
                            ...secondaryBtn,
                            ...btnFlex,
                            marginTop: 0,
                            width: "auto",
                            padding: "10px 14px",
                            opacity: isLocked ? 0.6 : 1,
                          }}
                          onClick={() => void importSingle(a)}
                        >
                          <span aria-hidden>📥</span>
                          <span>
                            {status === "importing" ? "מייבא..." : "ייבא"}
                          </span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )
        ) : null}

        {/* First-time hint shown only when logged in + Gmail connected,
            but no scan has run yet (and we're past hydration). */}
        {mounted && authHeader && connected && !scanned && !scanLoading ? (
          <div style={emptyState}>
            לחץ על &quot;סרוק עכשיו&quot; כדי למצוא מסמכים מהמייל שלך.
          </div>
        ) : null}
      </main>
    </div>
  );
}
