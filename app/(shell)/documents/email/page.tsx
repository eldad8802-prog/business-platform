"use client";
import { PageContainer } from "@/components/ui/page-container";
import DocumentsIllustration from "@/components/documents/DocumentsIllustration";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  scoreAttachments,
  type EmailAttachmentUiStatus,
  type ScoredAttachment,
} from "@/lib/services/email-import/scoring";
import {
  gmailScanOutcome,
  summarizeGmailScan,
  type GmailScanDiagnostics,
} from "@/lib/services/email-import/scan-diagnostics";
import {
  parseRejectedTypeCounts,
  REJECTED_TYPE_GROUPS,
  type RejectedTypeCounts,
} from "@/lib/services/email-import/rejected-types";
import { DEFAULT_GMAIL_SCAN_WINDOW, type GmailScanWindow } from "@/lib/services/email-import/scan-window";
import { parseScanAnswer, parseScanAttachment } from "@/lib/services/email-import/scan-response";
import {
  applyBasicScan,
  applyNetworkFailure,
  applyScanAnswer,
  initialScanState,
  needsClearConfirmation,
  resultsAreStale,
  scanActions,
  startScan,
  type ExtendedScanState,
} from "@/lib/services/email-import/extended-scan-state";
import {
  AttachmentCard,
  ConfirmImportPanel,
  GroupHeader,
  PeriodPicker,
  displayDate,
  periodName,
  scoreReasonText,
} from "@/components/documents/email/GmailScanParts";
import { TOKEN } from "@/lib/design/documents-theme";
import { glassActionStyle, primaryActionStyle } from "@/lib/design/documents-theme";
import DocumentsBackButton from "@/components/documents/DocumentsBackButton";
import { useI18n } from "@/components/i18n/I18nProvider";
import { formatNumber } from "@/lib/i18n/format";
import type { Translator } from "@/lib/i18n/translate";

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

// The callback's whitelisted codes; anything else in the URL is shown as "unknown".
const KNOWN_CALLBACK_CODES = new Set([
  "google_access_denied",
  "gmail_state_invalid",
  "gmail_token_exchange_failed",
  "gmail_callback_failed",
  "max_accounts",
]);

// Friendly Hebrew copy for the whitelisted error codes the Gmail OAuth callback
// (app/api/integrations/gmail/callback) redirects back with on failure.
function gmailCallbackErrorMessage(t: Translator, code: string): string {
  switch (code) {
    case "google_access_denied":
      return t("documents.email.errAccessDenied");
    case "gmail_state_invalid":
      return t("documents.email.errStateInvalid");
    case "gmail_token_exchange_failed":
      return t("documents.email.errTokenExchange");
    case "max_accounts":
      return t("documents.email.errMaxAccounts");
    case "gmail_callback_failed":
    default:
      return t("documents.email.errCallback");
  }
}

// Why the list is empty after a scan: no messages, messages without attachments, or
// attachments that were all filtered out.
function emptyMessage(
  t: Translator,
  diag: GmailScanDiagnostics | null,
  fmt: Parameters<typeof formatNumber>[1]
): string {
  if (!diag) return t("documents.email.noResultsInScan");
  switch (gmailScanOutcome(diag)) {
    case "no_messages":
      return t("documents.email.noResultsInScan");
    case "no_attachments":
      return t("documents.email.scanNoAttachments", {
        messages: formatNumber(diag.scannedMessages, fmt),
      });
    case "all_filtered":
      return t("documents.email.scanAllFiltered", {
        parts: formatNumber(diag.attachmentParts, fmt),
        unsupported: formatNumber(diag.unsupportedType, fmt),
        hidden: formatNumber(diag.hidden, fmt),
      });
    default:
      return t("documents.email.noResultsInScan");
  }
}

// A failed import names the file and the reason in plain Hebrew. The server's
// message is already a translated sentence (file too large, unsupported type,
// content check); the "not found in the message" code gets its own guidance,
// and a network/unknown failure a generic retry line.
function importFailureMessage(
  t: Translator,
  attachment: ScoredAttachment,
  data: { error?: unknown; code?: unknown } | null
): string {
  const file = attachment.filename || t("documents.email.untitled");
  const reason =
    data?.code === "ATTACHMENT_NOT_IN_MESSAGE"
      ? t("documents.email.errImportNotFound")
      : typeof data?.error === "string" && data.error
        ? data.error
        : t("documents.email.errImportGeneric");
  return t("documents.email.errImportFile", { file, reason });
}

function attachmentStatusLabel(t: Translator, status: EmailAttachmentUiStatus): string {
  return status === "imported"
    ? t("documents.email.statusImported")
    : status === "duplicate"
      ? t("documents.email.statusDuplicate")
      : status === "importing"
        ? t("documents.email.statusImporting")
        : status === "failed"
          ? t("documents.email.statusFailed")
          : t("documents.email.statusNotDocument");
}

type Tone = "success" | "info" | "attention" | "urgent";

/** The honest line under the summary: how far the scan really got (owner fix 4). */
function completionMessage(t: Translator, scan: ExtendedScanState): { text: string; tone: Tone } | null {
  const period = scan.window ? periodName(t, scan.window) : "";
  switch (scan.completion) {
    case "complete":
      return { text: t("documents.email.stateComplete", { period }), tone: "success" };
    case "has_more":
      return { text: t("documents.email.stateHasMore", { period }), tone: "info" };
    case "cap_reached":
      return { text: t("documents.email.stateCap"), tone: "attention" };
    case "incomplete":
      return { text: t("documents.email.stateIncomplete"), tone: "attention" };
    case "stopped":
      return { text: t("documents.email.stateStopped"), tone: "urgent" };
    case "budget":
      return { text: t("documents.email.stateBudget"), tone: "attention" };
    case "unavailable":
      return { text: t("documents.email.stateUnavailable"), tone: "attention" };
    case "expired":
      return { text: t("documents.email.stateExpired"), tone: "attention" };
    case "error":
      return { text: t("documents.email.stateError"), tone: "urgent" };
    case "reconnect":
      return { text: t("documents.email.stateReconnect"), tone: "urgent" };
    case "basic":
      return { text: t("documents.email.basicScanNote"), tone: "info" };
    default:
      return null;
  }
}

export default function EmailDocumentsPage() {
  const { t, locale, fmt } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [emailAddress, setEmailAddress] = useState("");
  const [connections, setConnections] = useState<GmailConnectionSummary[]>([]);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<number | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<number | null>(null);
  // Extended scan (B3-b): the period chosen in the picker; nothing is requested until "סרוק מסמכים".
  const [selectedWindow, setSelectedWindow] = useState<GmailScanWindow>(DEFAULT_GMAIL_SCAN_WINDOW);
  const [scan, setScan] = useState<ExtendedScanState>(initialScanState);
  // Import statuses by stable key — kept across pages, retries, new scans and period changes.
  const [statusByKey, setStatusByKey] = useState<Record<string, EmailAttachmentUiStatus>>({});
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; stopped: boolean } | null>(null);
  const stopImportRef = useRef(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // B4: the one possibly-relevant / low-score file whose import confirmation is open (by stable key).
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  // Files with an import request in flight — a repeated tap never sends a second request.
  const inFlightRef = useRef<Set<string>>(new Set());
  const [lowOpen, setLowOpen] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [error, setError] = useState("");
  // The OAuth callback's failure, kept apart from `error` so a scan (which clears `error`)
  // cannot wipe it. Cleared only by a new connect attempt.
  const [connectError, setConnectError] = useState<{ message: string; code: string } | null>(null);
  const [rejectedByType, setRejectedByType] = useState<RejectedTypeCounts | null>(null);
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
        setNotice(t("documents.email.connectedNotice"));
      } else if (errorFlag) {
        setConnectError({
          message: gmailCallbackErrorMessage(t, errorFlag),
          code: KNOWN_CALLBACK_CODES.has(errorFlag) ? errorFlag : "unknown",
        });
      }
      window.history.replaceState({}, "", "/documents/email");
    });
  }, [t]);

  // Connection health only. Owner decision (2026-11-09): opening the screen never scans.
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
        const conns = Array.isArray(data.connections) ? data.connections : [];
        setConnections(conns);
        const primaryConnected = conns.find((c) => c.status === "connected") ?? null;
        setSelectedConnectionId(primaryConnected?.id ?? null);
      } catch {
        setConnected(false);
      }
    });
  }, [authHeader]);

  // The Gmail quota countdown (no automatic retry when it reaches zero — the owner taps "המשך").
  useEffect(() => {
    if (waitSeconds <= 0) return;
    const id = window.setTimeout(() => setWaitSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [waitSeconds]);

  const scored = useMemo(
    () => scoreAttachments(scan.items).sort((a, b) => b.score - a.score),
    [scan.items]
  );
  const recommended = useMemo(() => scored.filter((a) => a.bucket === "recommended"), [scored]);
  const possible = useMemo(() => scored.filter((a) => a.bucket === "possible"), [scored]);
  const lowScore = useMemo(() => scored.filter((a) => a.bucket === "hidden"), [scored]);
  // Only recommended rows not yet handled are ever imported in bulk — never low-score ones.
  const importable = useMemo(
    () => recommended.filter((a) => (statusByKey[a.key] || "pending") === "pending"),
    [recommended, statusByKey]
  );
  const scanDiag = useMemo<GmailScanDiagnostics | null>(
    () =>
      scan.window !== null && (scan.pagesComplete > 0 || scan.completion === "basic")
        ? summarizeGmailScan({
            scannedMessages: scan.scannedTotal,
            attachmentParts: scan.attachmentParts,
            unsupportedType: scan.unsupportedType,
            attachments: scan.items,
          })
        : null,
    [scan]
  );

  // Owner fix 2: while any import runs, nothing that changes the list may start.
  const rowImporting = Object.values(statusByKey).includes("importing");
  const busy = importing || rowImporting;
  const stale = resultsAreStale(scan, { window: selectedWindow, connectionId: selectedConnectionId });
  const actions = scanActions(scan, busy || loading);

  async function startConnect() {
    if (!authHeader) return;
    try {
      setError("");
      setConnectError(null);
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
        throw new Error(data.error || t("documents.email.errOpenConnect"));
      }
      window.location.href = data.url;
    } catch (err) {
      setError(errorMessage(err, t("documents.email.errConnect")));
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
        throw new Error(t("documents.email.errDisconnectFailed"));
      }
      const next = connections.map((c) =>
        c.id === connectionId ? { ...c, status: "revoked" } : c
      );
      setConnections(next);
      const stillConnected = next.some((c) => c.status === "connected");
      setConnected(stillConnected);
      if (!stillConnected) {
        setEmailAddress("");
        setScan(initialScanState());
        setStatusByKey({});
        setRejectedByType(null);
      }
      setNotice(t("documents.email.disconnectedNotice"));
    } catch (err) {
      setError(errorMessage(err, t("documents.email.errDisconnect")));
    } finally {
      setDisconnectingId(null);
      setConfirmingId(null);
    }
  }

  /**
   * One request to the extended scan. "new" = the first page of the SELECTED period and account
   * (the list starts empty; import statuses stay). "continue" = the cursor the server gave for the
   * current results (next page, or the same page again). Only ever called from a user's tap.
   */
  async function requestScanPage(mode: "new" | "continue") {
    if (!authHeader || loading || busy) return;
    const windowForRequest = mode === "new" ? selectedWindow : (scan.window ?? selectedWindow);
    const connectionForRequest = mode === "new" ? selectedConnectionId : scan.connectionId;
    const cursor = mode === "new" ? null : scan.continueCursor;
    if (mode === "continue" && !cursor) return;
    const base = mode === "new" ? startScan(windowForRequest, connectionForRequest) : scan;
    if (mode === "new") {
      setScan(base);
      setRejectedByType(null);
      setLowOpen(false);
      setConfirmKey(null);
      setBulkProgress(null);
    }
    setConfirmClear(false);
    setLoading(true);
    setError("");
    setWaitSeconds(0);
    const params = new URLSearchParams({ window: String(windowForRequest) });
    if (connectionForRequest != null) params.set("connectionId", String(connectionForRequest));
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await fetch(`/api/integrations/gmail/scan?${params.toString()}`, {
        headers: { authorization: authHeader },
      });
      const body = await response.json().catch(() => null);
      const answer = parseScanAnswer(response.status, body);
      const next = applyScanAnswer(base, answer);
      setScan(next);
      // No breakdown at all (an answer without it) → no breakdown line, never an empty one.
      const rejectedKnown = REJECTED_TYPE_GROUPS.some((group) => next.rejectedByType[group] > 0);
      if (next.pagesComplete > 0) setRejectedByType(rejectedKnown ? next.rejectedByType : null);
      if (answer.kind === "budget") setWaitSeconds(answer.retryAfterSeconds ?? 0);
      if (answer.kind === "reconnect") {
        setConnected(false);
        setError(t("documents.email.errExpired"));
      }
    } catch {
      // No answer at all: everything already found stays; the same request can be tried again.
      setScan(applyNetworkFailure(base));
    } finally {
      setLoading(false);
    }
  }

  function onScanPress() {
    if (loading || busy) return;
    if (needsClearConfirmation(scan)) {
      setConfirmClear(true);
      return;
    }
    void requestScanPage("new");
  }

  /** "המשך" / "נסה שוב": the server's cursor when there is one, else the first page again. */
  function onContinuePress() {
    if (scan.continueCursor) void requestScanPage("continue");
    else onScanPress();
  }

  /**
   * Fallback while the extended scan is unavailable: the legacy scan of the latest 30 messages,
   * merged into the list without duplicates. Only from an explicit tap.
   */
  async function runBasicScan() {
    if (!authHeader || loading || busy) return;
    const connectionId = scan.connectionId ?? selectedConnectionId;
    try {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({ maxMessages: "30" });
      if (connectionId != null) params.set("connectionId", String(connectionId));
      const response = await fetch(`/api/integrations/gmail/sync?${params.toString()}`, {
        headers: { authorization: authHeader },
      });
      const data = await response.json();
      if (response.status === 409 || data?.needsReconnect) {
        setConnected(false);
        setError(t("documents.email.errExpired"));
        return;
      }
      if (!response.ok) throw new Error(data?.error || t("documents.email.errScan"));
      const list = (Array.isArray(data.attachments) ? data.attachments : [])
        .map(parseScanAttachment)
        .filter((a: ReturnType<typeof parseScanAttachment>): a is NonNullable<typeof a> => a !== null);
      const base = scan.window === null ? startScan(DEFAULT_GMAIL_SCAN_WINDOW, connectionId) : scan;
      setScan(
        applyBasicScan(base, {
          scannedMessages: typeof data.scannedMessages === "number" ? data.scannedMessages : 0,
          attachmentParts: typeof data.attachmentParts === "number" ? data.attachmentParts : list.length,
          unsupportedType: typeof data.unsupportedType === "number" ? data.unsupportedType : 0,
          attachments: list,
        })
      );
      // Absent on older servers → null → the breakdown line is simply not shown.
      setRejectedByType(parseRejectedTypeCounts(data.rejectedByType));
    } catch (err) {
      setError(errorMessage(err, t("documents.email.errScan")));
    } finally {
      setLoading(false);
    }
  }

  async function importOne(attachment: ScoredAttachment) {
    if (!authHeader) return false;
    // One request per file at a time: a second tap before the status re-renders sends nothing.
    if (inFlightRef.current.has(attachment.key)) return false;
    inFlightRef.current.add(attachment.key);
    setStatusByKey((current) => ({ ...current, [attachment.key]: "importing" }));
    // The account the RESULTS came from — not whatever the picker shows now.
    const importConnectionId = scan.connectionId ?? selectedConnectionId;
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
          partId: attachment.partId ?? null,
          ...(importConnectionId != null ? { connectionId: importConnectionId } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 || data?.needsReconnect) {
        setConnected(false);
        setError(t("documents.email.errExpired"));
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
      if (status === "failed") {
        setError(importFailureMessage(t, attachment, data));
      }
      return status === "imported";
    } catch {
      setStatusByKey((current) => ({ ...current, [attachment.key]: "failed" }));
      setError(importFailureMessage(t, attachment, null));
      return false;
    } finally {
      inFlightRef.current.delete(attachment.key);
    }
  }

  /** Owner fix 1: recommended only, after an explicit confirmation, stoppable between files. */
  async function importAllRecommended() {
    const queue = importable.slice();
    setConfirmImport(false);
    if (queue.length === 0) return;
    stopImportRef.current = false;
    setImporting(true);
    setBulkProgress({ done: 0, total: queue.length, stopped: false });
    let done = 0;
    try {
      for (const attachment of queue) {
        if (stopImportRef.current) break;
        await importOne(attachment);
        done += 1;
        setBulkProgress({ done, total: queue.length, stopped: false });
      }
    } finally {
      setBulkProgress({ done, total: queue.length, stopped: stopImportRef.current && done < queue.length });
      setImporting(false);
    }
  }

  if (!mounted) {
    return (
      <div style={pageStyle}>
        <PageContainer intent="focused" style={{ paddingBlock: "14px 40px" }}>
          <Header />
          <div style={emptyStyle}>{t("documents.email.loading")}</div>
        </PageContainer>
      </div>
    );
  }

  if (!authHeader) {
    return (
      <div style={pageStyle}>
        <PageContainer intent="focused" style={{ paddingBlock: "14px 40px" }}>
          <Header />
          <section style={emptyStyle}>
            {t("documents.email.loginRequired")}
            <Link href="/login" style={loginLinkStyle}>
              {t("documents.email.login")}
            </Link>
          </section>
        </PageContainer>
      </div>
    );
  }

  const connectedAccounts = connections.filter((c) => c.status === "connected");
  const canConnectAnother = connectedAccounts.length >= 1 && connectedAccounts.length < 2;
  const selectedAccount = connectedAccounts.find((c) => c.id === selectedConnectionId) ?? null;
  const resultsAccount = connectedAccounts.find((c) => c.id === scan.connectionId) ?? null;
  const completion = completionMessage(t, scan);
  const hasResults = scan.items.length > 0;
  const scanned = scan.window !== null;

  // B4: a possibly-relevant / low-score file is imported only from its own confirmation, one at a
  // time; the import itself is the unchanged importOne → /api/integrations/gmail/import.
  const importConfirmed = (attachment: ScoredAttachment) => {
    setConfirmKey(null);
    void importOne(attachment);
  };

  const renderCards = (list: ScoredAttachment[]) => (
    <div className="dz-email-rows" style={rowsStyle}>
      {list.map((attachment) => {
        const status = statusByKey[attachment.key] || "pending";
        const confirmFirst = attachment.bucket !== "recommended";
        return (
          <AttachmentCard
            key={attachment.key}
            t={t}
            locale={locale}
            attachment={attachment}
            status={status}
            importDisabled={importing || status !== "pending"}
            confirming={confirmKey === attachment.key}
            onImport={() => (confirmFirst ? importConfirmed(attachment) : void importOne(attachment))}
            onAskConfirm={() => setConfirmKey(attachment.key)}
            onCancelConfirm={() => setConfirmKey(null)}
            statusLabel={attachmentStatusLabel(t, status)}
          />
        );
      })}
    </div>
  );

  const renderTable = (list: ScoredAttachment[], label: string) => (
    <div className="dz-email-table" aria-label={label}>
      <table>
        <thead>
          <tr>
            <th>{t("documents.email.colFile")}</th>
            <th>{t("documents.email.colFrom")}</th>
            <th>{t("documents.review.fields.date")}</th>
            <th>{t("documents.email.colAction")}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((attachment) => {
            const status = statusByKey[attachment.key] || "pending";
            const confirmFirst = attachment.bucket !== "recommended";
            const pending = status === "pending";
            const reason = confirmFirst ? scoreReasonText(attachment.reason) : "";
            const confirming = confirmFirst && pending && confirmKey === attachment.key;
            return (
              <Fragment key={attachment.key}>
              <tr data-key={attachment.key}>
                <td>
                  <span dir="auto" style={tableFileStyle}>{attachment.filename || t("documents.email.untitled")}</span>
                  {reason ? <span style={tableReasonStyle}>{t("documents.email.reasonLine", { reason })}</span> : null}
                </td>
                <td>
                  {attachment.fromName ? <bdi style={{ display: "block" }}>{attachment.fromName}</bdi> : null}
                  <bdi dir="ltr" style={attachment.fromName ? tableMutedStyle : undefined}>
                    {attachment.fromEmail || t("documents.common.notSpecified")}
                  </bdi>
                </td>
                <td>{displayDate(t, attachment.sentAt, locale) || "—"}</td>
                <td>
                  {pending && !confirmFirst ? (
                    <button
                      type="button"
                      disabled={importing}
                      onClick={() => void importOne(attachment)}
                      style={smallButtonStyle}
                    >
                      {t("documents.email.import")}
                    </button>
                  ) : pending && !confirming ? (
                    <button
                      type="button"
                      className="dz-email-card-import-anyway"
                      disabled={importing}
                      onClick={() => setConfirmKey(attachment.key)}
                      style={smallButtonStyle}
                    >
                      {t("documents.email.importAnyway")}
                    </button>
                  ) : !pending ? (
                    <span style={pillStyleFor(status)}>{attachmentStatusLabel(t, status)}</span>
                  ) : null}
                </td>
              </tr>
              {confirming ? (
                <tr data-confirm-for={attachment.key}>
                  <td colSpan={4}>
                    <ConfirmImportPanel
                      t={t}
                      bucket={attachment.bucket}
                      disabled={importing}
                      onConfirm={() => importConfirmed(attachment)}
                      onCancel={() => setConfirmKey(null)}
                    />
                  </td>
                </tr>
              ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  // The recommended-only bulk import: confirm → progress with stop → result. Shown in the
  // phone's bottom bar and, on desktop, above the list.
  const importControls = (
    <div className="dz-email-import-controls" style={importControlsStyle}>
      {confirmImport ? (
        <div role="dialog" aria-label={t("documents.email.confirmImportTitle", { count: formatNumber(importable.length, fmt) })} style={confirmBoxStyle}>
          <div style={confirmTitleStyle}>
            {t("documents.email.confirmImportTitle", { count: formatNumber(importable.length, fmt) })}
          </div>
          <div style={confirmBodyStyle}>{t("documents.email.confirmImportBody")}</div>
          <div style={confirmButtonsStyle}>
            <button type="button" className="dz-email-confirm-import" onClick={() => void importAllRecommended()} style={confirmPrimaryStyle}>
              {t("documents.email.confirmImportYes")}
            </button>
            <button type="button" onClick={() => setConfirmImport(false)} style={confirmSecondaryStyle}>
              {t("documents.email.confirmImportNo")}
            </button>
          </div>
        </div>
      ) : importing && bulkProgress ? (
        <div style={progressRowStyle}>
          <span>
            {t("documents.email.importProgress", {
              done: formatNumber(bulkProgress.done, fmt),
              total: formatNumber(bulkProgress.total, fmt),
            })}
          </span>
          <button
            type="button"
            className="dz-email-stop-import"
            onClick={() => {
              stopImportRef.current = true;
            }}
            style={confirmSecondaryStyle}
          >
            {t("documents.email.stopImport")}
          </button>
        </div>
      ) : (
        <>
          {bulkProgress?.stopped ? (
            <div style={progressNoteStyle}>
              {t("documents.email.importStopped", {
                done: formatNumber(bulkProgress.done, fmt),
                total: formatNumber(bulkProgress.total, fmt),
              })}
            </div>
          ) : null}
          <button
            type="button"
            className="dz-email-import-all"
            disabled={busy || loading || importable.length === 0}
            onClick={() => setConfirmImport(true)}
            style={{
              ...importButtonStyle,
              opacity: busy || loading || importable.length === 0 ? 0.65 : 1,
              cursor: busy || loading || importable.length === 0 ? "not-allowed" : "pointer",
            }}
          >
            {t("documents.email.importAllRecommended", { count: formatNumber(importable.length, fmt) })}
          </button>
        </>
      )}
    </div>
  );

  const toneStyle = (tone: Tone) => ({
    ...statusBoxStyle,
    border: `1px solid ${TOKEN.semantic[tone].border}`,
    background: TOKEN.semantic[tone].bgSoft,
    color: TOKEN.semantic[tone].ink,
  });

  return (
    <div className="dz-email-page" style={pageStyle}>
      <PageContainer
        intent="focused"
        className={connected ? "dz-doc-wide" : "dz-email-off"}
        style={{ paddingBlock: "14px 40px" }}
      >
        <Header />

        <div className={connected ? "dz-email-desk" : "dz-email-connect"}>
        <div className="dz-email-side">
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
          {connected
            ? t("documents.email.connectedAs", { email: emailAddress || "Gmail" })
            : t("documents.email.notConnected")}
        </section>

        {connections.length > 0 ? (
          <section style={accountsCardStyle}>
            <div style={accountsTitleStyle}>{t("documents.email.accounts")}</div>
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
                  {c.status === "connected" ? t("documents.email.connected") : t("documents.email.revoked")}
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
                        {disconnectingId === c.id ? t("documents.email.disconnecting") : t("documents.email.confirmDisconnect")}
                      </button>
                      <button
                        type="button"
                        style={confirmNoStyle}
                        onClick={() => setConfirmingId(null)}
                      >
                        {t("documents.email.cancel")}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      style={disconnectBtnStyle}
                      onClick={() => setConfirmingId(c.id)}
                    >
                      {t("documents.email.disconnect")}
                    </button>
                  )
                ) : null}
              </div>
            ))}
            {canConnectAnother ? (
              <button
                type="button"
                onClick={() => void startConnect()}
                style={connectAnotherBtnStyle}
              >
                {t("documents.email.connectAnother")}
              </button>
            ) : null}
          </section>
        ) : null}

        {notice ? <div style={noticeStyle}>{notice}</div> : null}

        {!connected ? (
          <button type="button" onClick={() => void startConnect()} style={connectButtonStyle}>
            {t("documents.email.connectGmail")}
          </button>
        ) : null}
        </div>
        <div className="dz-email-main">
        {connectError ? (
          <section role="alert" className="dz-email-connect-error" style={errorStyle}>
            <div style={{ fontWeight: TOKEN.weight.bold }}>{t("documents.email.connectFailedTitle")}</div>
            <div>{connectError.message}</div>
            {connected ? (
              <div>{t("documents.email.connectFailedOld", { email: emailAddress || "Gmail" })}</div>
            ) : null}
            <div style={{ fontSize: TOKEN.font.meta }}>
              {t("documents.email.connectFailedCode", { code: connectError.code })}
            </div>
          </section>
        ) : null}
        {!connected ? (
          <section className="dz-email-explain" style={accountsCardStyle}>
            <DocumentsIllustration name="upload" width={150} style={{ margin: "0 auto 6px" }} />
            <div style={accountsTitleStyle}>{t("documents.email.whatItDoes")}</div>
            <p style={{ margin: 0, color: TOKEN.ink.muted, lineHeight: 1.6 }}>
              {t("documents.email.whatItDoesBody")}
            </p>
          </section>
        ) : null}

        {connected ? (<>
        {/* The scan card: account + period first, then an explicit "סרוק מסמכים" (owner decision B). */}
        <section className="dz-email-scan-card" style={scanCardStyle}>
          <h2 style={scanCardTitleStyle}>{t("documents.email.scanCardTitle")}</h2>
          {connectedAccounts.length >= 2 ? (
            <div style={{ marginBottom: 12 }}>
              <div style={selectorLabelStyle}>{t("documents.email.scanFrom")}</div>
              <div style={selectorChipsStyle}>
                {connectedAccounts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="dz-email-account-chip"
                    style={selectedConnectionId === c.id ? selectorChipActiveStyle : selectorChipStyle}
                    aria-pressed={selectedConnectionId === c.id}
                    disabled={loading || busy}
                    onClick={() => setSelectedConnectionId(c.id)}
                  >
                    {c.emailAddress}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div style={selectorLabelStyle}>{t("documents.email.periodLabel")}</div>
          <PeriodPicker t={t} value={selectedWindow} disabled={loading || busy} onChange={setSelectedWindow} />
          <button
            type="button"
            className="dz-email-scan-button"
            disabled={loading || busy}
            onClick={onScanPress}
            style={{ ...scanButtonStyle, opacity: loading || busy ? 0.65 : 1, cursor: loading || busy ? "not-allowed" : "pointer" }}
          >
            {loading ? t("documents.email.scanning") : t("documents.email.scanButton")}
          </button>
          {busy ? <div style={hintStyle}>{t("documents.email.busyImporting")}</div> : null}
          {!scanned && !busy ? <div style={hintStyle}>{t("documents.email.scanIdleHint")}</div> : null}
          {confirmClear ? (
            <div role="dialog" aria-label={t("documents.email.confirmClearTitle")} className="dz-email-confirm-clear" style={confirmBoxStyle}>
              <div style={confirmTitleStyle}>{t("documents.email.confirmClearTitle")}</div>
              <div style={confirmBodyStyle}>
                {t("documents.email.confirmClearBody", { count: formatNumber(scan.items.length, fmt) })}
              </div>
              <div style={confirmButtonsStyle}>
                <button type="button" onClick={() => void requestScanPage("new")} style={confirmPrimaryStyle}>
                  {t("documents.email.confirmClearYes")}
                </button>
                <button type="button" onClick={() => setConfirmClear(false)} style={confirmSecondaryStyle}>
                  {t("documents.email.confirmClearNo")}
                </button>
              </div>
            </div>
          ) : null}
        </section>

        {stale && scanned ? (
          <div className="dz-email-stale" style={toneStyle("info")}>
            {t("documents.email.staleResults", {
              period: scan.window ? periodName(t, scan.window) : "",
              email: resultsAccount?.emailAddress || selectedAccount?.emailAddress || emailAddress || "Gmail",
            })}
          </div>
        ) : null}

        {scanned ? (
          <section className="dz-email-scan-status" aria-live="polite" style={{ marginTop: 12 }}>
            <div className="dz-email-summary" style={summaryStyle}>
              {t("documents.email.summaryLine", {
                messages: formatNumber(scan.scannedTotal, fmt),
                period: scan.window ? periodName(t, scan.window) : "",
                found: formatNumber(scan.items.length, fmt),
              })}
            </div>
            {completion && !loading ? (
              <div className="dz-email-completion" data-completion={scan.completion} style={toneStyle(completion.tone)}>
                <div>{completion.text}</div>
                {scan.completion === "budget" && waitSeconds > 0 ? (
                  <div>{t("documents.email.stateBudgetWait", { seconds: formatNumber(waitSeconds, fmt) })}</div>
                ) : null}
                {!stale ? (
                  <div style={statusButtonsStyle}>
                    {scan.completion === "incomplete" || scan.completion === "error" ? (
                      <button type="button" className="dz-email-retry" disabled={!actions.canStartNew} onClick={onContinuePress} style={statusButtonStyle}>
                        {t("documents.email.retrySamePage")}
                      </button>
                    ) : null}
                    {scan.completion === "budget" ? (
                      <button
                        type="button"
                        className="dz-email-continue"
                        disabled={!actions.canStartNew || waitSeconds > 0}
                        onClick={onContinuePress}
                        style={statusButtonStyle}
                      >
                        {t("documents.email.continueScan")}
                      </button>
                    ) : null}
                    {scan.completion === "unavailable" ? (
                      <>
                        <button type="button" className="dz-email-retry" disabled={!actions.canStartNew} onClick={onContinuePress} style={statusButtonStyle}>
                          {t("documents.email.retrySamePage")}
                        </button>
                        <button type="button" className="dz-email-basic-scan" disabled={!actions.canOfferBasicScan} onClick={() => void runBasicScan()} style={statusButtonStyle}>
                          {t("documents.email.basicScan")}
                        </button>
                      </>
                    ) : null}
                    {scan.completion === "expired" ? (
                      <button type="button" className="dz-email-restart" disabled={!actions.canStartNew} onClick={onScanPress} style={statusButtonStyle}>
                        {t("documents.email.restartScan")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {scan.completion === "unavailable" && !loading ? (
              <div style={hintStyle}>{t("documents.email.basicScanNote")}</div>
            ) : null}
            {!loading && scanDiag ? (
              <details className="dz-email-scan-details" style={detailsStyle}>
              <summary style={detailsSummaryStyle}>{t("documents.email.scanDetails")}</summary>
              <div className="dz-email-scan-diag" style={diagStyle}>
                <div>
                  {t("documents.email.scanSummary", {
                    messages: formatNumber(scanDiag.scannedMessages, fmt),
                    parts: formatNumber(scanDiag.attachmentParts, fmt),
                  })}
                </div>
                <div>
                  {t("documents.email.scanBreakdown", {
                    unsupported: formatNumber(scanDiag.unsupportedType, fmt),
                    hidden: formatNumber(scanDiag.hidden, fmt),
                    possible: formatNumber(scanDiag.possible, fmt),
                    recommended: formatNumber(scanDiag.recommended, fmt),
                  })}
                </div>
                {scanDiag.unsupportedType > 0 && rejectedByType ? (
                  <div className="dz-email-scan-rejected">
                    {t("documents.email.scanRejectedTypes", {
                      groups: REJECTED_TYPE_GROUPS.filter((group) => rejectedByType[group] > 0)
                        .map((group) =>
                          t("documents.email.rejectedGroup", {
                            group: t(`documents.email.rejected_${group}`),
                            count: formatNumber(rejectedByType[group], fmt),
                          })
                        )
                        .join(" · "),
                    })}
                  </div>
                ) : null}
              </div>
              </details>
            ) : null}
          </section>
        ) : null}

        {loading ? <div style={emptyStyle}>{t("documents.email.scanning")}</div> : null}
        </>) : null}
        {error ? <div role="alert" style={errorStyle}>{error}</div> : null}

        {connected && scanned && !loading && !hasResults && scan.pagesComplete + (scan.completion === "basic" ? 1 : 0) > 0 ? (
          <section style={emptyStyle}>
            <DocumentsIllustration name="search" width={150} style={{ margin: "0 auto 6px" }} />
            {emptyMessage(t, scanDiag, fmt)}
          </section>
        ) : null}

        {connected && hasResults ? (
          <>
            <div className="dz-email-import-row">{importControls}</div>

            {recommended.length > 0 ? (
              <section className="dz-email-group" data-group="recommended">
                <GroupHeader title={t("documents.email.groupRecommended")} count={formatNumber(recommended.length, fmt)} />
                {renderCards(recommended)}
                {renderTable(recommended, t("documents.email.groupRecommended"))}
              </section>
            ) : null}

            {possible.length > 0 ? (
              <section className="dz-email-group" data-group="possible">
                <GroupHeader
                  title={t("documents.email.groupPossible")}
                  count={formatNumber(possible.length, fmt)}
                  note={t("documents.email.groupPossibleNote")}
                />
                {renderCards(possible)}
                {renderTable(possible, t("documents.email.groupPossible"))}
              </section>
            ) : null}

            {lowScore.length > 0 ? (
              <section className="dz-email-group" data-group="low">
                <GroupHeader title={t("documents.email.groupLow")} count={formatNumber(lowScore.length, fmt)} />
                <button
                  type="button"
                  className="dz-email-low-toggle"
                  aria-expanded={lowOpen}
                  aria-controls="dz-email-low-list"
                  onClick={() => setLowOpen((v) => !v)}
                  style={toggleButtonStyle}
                >
                  {lowOpen
                    ? t("documents.email.groupLowHide")
                    : t("documents.email.groupLowShow", { count: formatNumber(lowScore.length, fmt) })}
                </button>
                {lowOpen ? (
                  <div id="dz-email-low-list">
                    <p style={groupNoteInlineStyle}>{t("documents.email.groupLowNote")}</p>
                    {renderCards(lowScore)}
                    {renderTable(lowScore, t("documents.email.groupLow"))}
                  </div>
                ) : null}
              </section>
            ) : null}

            {!stale && scan.completion === "has_more" ? (
              <div style={loadMoreWrapStyle}>
                <button
                  type="button"
                  className="dz-email-load-more"
                  disabled={!actions.canLoadMore}
                  onClick={() => void requestScanPage("continue")}
                  style={{ ...loadMoreStyle, opacity: actions.canLoadMore ? 1 : 0.6, cursor: actions.canLoadMore ? "pointer" : "not-allowed" }}
                >
                  {t("documents.email.loadMore")}
                </button>
                {busy ? <div style={hintStyle}>{t("documents.email.busyImporting")}</div> : null}
              </div>
            ) : null}
          </>
        ) : null}
        </div>
        </div>
      </PageContainer>

      {connected && hasResults ? <div className="dz-email-bottom" style={bottomBarStyle}>{importControls}</div> : null}
    </div>
  );
}

function Header() {
  const { t } = useI18n();
  return (
    <header style={headStyle}>
      <DocumentsBackButton />
      <h1 style={titleStyle}>{t("documents.email.title")}</h1>
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

// Bottom padding comes from .dz-email-page in documents/layout.tsx (it depends on the
// shell's phone navigation and on the import bar).
const pageStyle = {
  minHeight: "100vh",
  background: TOKEN.surface.page,
  color: TOKEN.ink.primary,
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

const connectAnotherBtnStyle = {
  marginTop: 10,
  minHeight: 40,
  width: "100%",
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.button,
  background: TOKEN.surface.card,
  color: TOKEN.brand.mid,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
} as const;

const selectorLabelStyle = {
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  marginBottom: 8,
} as const;

const selectorChipsStyle = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap" as const,
} as const;

const selectorChipStyle = {
  minHeight: 40,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.surface.card,
  color: TOKEN.ink.primary,
  padding: "0 14px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
} as const;

const selectorChipActiveStyle = {
  ...selectorChipStyle,
  border: `1px solid ${TOKEN.brand.softBorder}`,
  background: TOKEN.brand.soft,
  color: TOKEN.brand.mid,
} as const;

const scanCardStyle = {
  marginTop: 12,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.card,
  borderRadius: TOKEN.radius.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: 14,
} as const;

const scanCardTitleStyle = {
  margin: "0 0 12px",
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
} as const;

const scanButtonStyle = {
  ...primaryActionStyle({ fullWidth: true, height: 50 }),
  width: "100%",
  minHeight: 50,
  marginTop: 12,
} as const;

const hintStyle = {
  marginTop: 8,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  lineHeight: 1.5,
} as const;

const summaryStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
} as const;

const statusBoxStyle = {
  marginTop: 8,
  borderRadius: TOKEN.radius.card,
  padding: "10px 12px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  lineHeight: 1.5,
  display: "flex",
  flexDirection: "column",
  gap: 6,
} as const;

const statusButtonsStyle = { display: "flex", flexWrap: "wrap", gap: 8 } as const;

const statusButtonStyle = {
  ...glassActionStyle({ height: 40 }),
  minHeight: 40,
  padding: "0 14px",
  fontSize: TOKEN.font.meta,
} as const;

const rowsStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
} as const;

const toggleButtonStyle = {
  ...glassActionStyle({ height: 44, fullWidth: true }),
  width: "100%",
  minHeight: 44,
  fontSize: TOKEN.font.meta,
} as const;

const groupNoteInlineStyle = {
  margin: "10px 0 8px",
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
} as const;

const loadMoreWrapStyle = { marginTop: 16, textAlign: "center" } as const;

const loadMoreStyle = {
  ...glassActionStyle({ height: 48, fullWidth: true }),
  width: "100%",
  minHeight: 48,
} as const;

const tableFileStyle = { display: "block", fontWeight: TOKEN.weight.semibold, overflowWrap: "anywhere" } as const;
const tableReasonStyle = { display: "block", marginTop: 2, color: TOKEN.ink.muted, fontSize: TOKEN.font.meta } as const;
const tableMutedStyle = { display: "block", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta } as const;

const smallButtonStyle = {
  ...glassActionStyle({ height: 38 }),
  minHeight: 38,
  padding: "0 16px",
  fontSize: TOKEN.font.meta,
  whiteSpace: "nowrap",
} as const;

function pillStyleFor(status: EmailAttachmentUiStatus) {
  const ok = status === "imported" || status === "duplicate";
  const urgent = status === "failed";
  return {
    borderRadius: TOKEN.radius.pill,
    background: ok ? TOKEN.semantic.success.bgSoft : urgent ? TOKEN.semantic.urgent.bgSoft : TOKEN.surface.inset,
    border: `1px solid ${ok ? TOKEN.semantic.success.border : urgent ? TOKEN.semantic.urgent.border : TOKEN.border.DEFAULT}`,
    color: ok ? TOKEN.semantic.success.ink : urgent ? TOKEN.semantic.urgent.ink : TOKEN.ink.secondary,
    padding: "4px 10px",
    fontSize: TOKEN.font.meta,
    fontWeight: TOKEN.weight.bold,
    whiteSpace: "nowrap" as const,
  };
}

// Position (above the shell's phone navigation) comes from .dz-email-bottom in documents/layout.tsx.
const bottomBarStyle = {
  position: "fixed",
  left: 0,
  right: 0,
  background: TOKEN.surface.card,
  borderTop: `1px solid ${TOKEN.border.DEFAULT}`,
  padding: "10px 14px",
  boxShadow: TOKEN.shadow.floating,
} as const;

const importControlsStyle = { width: "min(492px, 100%)", margin: "0 auto" } as const;

const importButtonStyle = {
  ...primaryActionStyle({ height: 50 }),
  width: "100%",
  minHeight: 50,
  display: "block",
  fontSize: TOKEN.font.body,
} as const;

const confirmBoxStyle = {
  marginTop: 10,
  border: `1px solid ${TOKEN.semantic.attention.border}`,
  background: TOKEN.semantic.attention.bgSoft,
  borderRadius: TOKEN.radius.card,
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
} as const;

const confirmTitleStyle = { color: TOKEN.ink.primary, fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold } as const;
const confirmBodyStyle = { color: TOKEN.ink.secondary, fontSize: TOKEN.font.meta, lineHeight: 1.5 } as const;
const confirmButtonsStyle = { display: "flex", gap: 8 } as const;

const confirmPrimaryStyle = {
  ...primaryActionStyle({ height: 44 }),
  flex: 1,
  minHeight: 44,
} as const;

const confirmSecondaryStyle = {
  ...glassActionStyle({ height: 44 }),
  flex: 1,
  minHeight: 44,
} as const;

const progressRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
} as const;

const progressNoteStyle = {
  marginBottom: 8,
  color: TOKEN.ink.secondary,
  fontSize: TOKEN.font.meta,
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

const detailsStyle = { marginTop: 8 } as const;

const detailsSummaryStyle = {
  cursor: "pointer",
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  minHeight: 32,
  display: "flex",
  alignItems: "center",
} as const;

const diagStyle = {
  marginTop: 6,
  padding: "10px 12px",
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.inset,
  color: TOKEN.ink.secondary,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  lineHeight: 1.6,
} as const;

const noticeStyle = {
  ...emptyStyle,
  border: `1px solid ${TOKEN.semantic.success.border}`,
  background: TOKEN.semantic.success.bgSoft,
  color: TOKEN.semantic.success.ink,
} as const;

const loginLinkStyle = {
  display: "inline-block",
  marginInlineStart: 8,
  color: TOKEN.brand.mid,
  fontWeight: TOKEN.weight.bold,
} as const;
