"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import BackButton from "@/components/ui/back-button";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { useMediaQuery } from "@/lib/ui/use-breakpoint";
import { WorkspaceLayout } from "@/components/ui/workspace-layout";
import { LAYOUT, type PageSurfaceIntent } from "@/lib/design/tokens";
import { CustomerPicker } from "@/components/billing/CustomerPicker";
import { IssuerSummaryBadge } from "@/components/billing/IssuerSummaryBadge";
import { glassActionStyle, primaryActionStyle, TOKEN } from "@/lib/design/billing-theme";
import { useI18n } from "@/components/i18n/I18nProvider";
import {
  isPaymentRequestStatus,
  shouldShowCollections,
  type PaymentRequestStatus,
} from "@/lib/billing/collections-visibility";
import { describeAuthorityIssueOutcome } from "@/lib/billing/authority-issue-display";
import type { AuthorityIssueOutcome } from "@/lib/services/billing/authority/billing-authority-issue-outcome";
import {
  DOCUMENT_TYPE_LABEL,
  STATUS_STYLE,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatQuantity,
  generateLocalLineKey,
  getDocumentTypeLabel,
  getStatusLabel,
  linesAreDirty,
  looksLikeDecimalInput,
  mapServerLinesToLocal,
  newEmptyLocalLine,
  normalizeNumericForCompare,
  openPdfBlobInNewTab,
  resolveServerLineForDraft,
  scrollToId,
  type BillingDocumentDetail,
  type BillingDocumentLine,
  type BillingStatus,
  type LifecycleAction,
  type LocalLine,
  type PatchSaveStatus,
  type StageKey,
  type StickyPrimaryAction,
} from "@/lib/billing/document-view-model";
import {
  ErrorBanner,
  NotFoundCard,
  WorkspaceSkeleton,
} from "@/components/billing/document/load-states";
import {
  CollapsiblePanel,
  CustomerSummaryCard,
  DetailRow,
  DetailsCard,
  LineCard,
  LinesSection,
  ReviewSummaryCard,
  ReviewSummaryRow,
  StatusBadge,
  TotalRow,
  TotalsCard,
} from "@/components/billing/document/read-models";




type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "not-found" }
  | { kind: "ready"; doc: BillingDocumentDetail };




// Either a link target, or the back control's own continuation (history back
// to the real origin / validated fallback) — both pass through the same
// unsaved-changes dialog.
type PendingNavigation = { href: string } | { proceed: () => void } | null;

function continuePendingNavigation(
  pending: Exclude<PendingNavigation, null>,
  push: (href: string) => void,
): void {
  if ("proceed" in pending) pending.proceed();
  else push(pending.href);
}














function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}








/**
 * Canonical scale, no local literals (Spec v1 §3):
 *  - the shell's desktop tier is where its nav becomes a sidebar (JS, because
 *    the chrome hook is a React signal);
 *  - the workspace tier is where the contextual rail earns its width (CSS —
 *    see RAIL_CSS and WorkspaceLayout's own breakpointStep).
 * The shell chrome still follows LAYOUT. The document workspace opens at the
 * product desktop tier (1200): that is where a summary rail earns its place,
 * earlier than LAYOUT.bp.wide (1280).
 */
const SHELL_DESKTOP_MIN = `(min-width: ${LAYOUT.bp.expanded}px)`;
const DOCUMENT_DESK_MIN = 1200;
/**
 * The rail carries identity, totals and the next action. 340 is wide enough
 * for a currency figure and a full-width primary button without wrapping, and
 * narrow enough that the stage content keeps a comfortable measure at 1280 —
 * where the shell sidebar has already taken 248.
 */
/**
 * `display: contents` keeps the wrapper transparent to the stage grid, so the
 * flow copies lay out exactly as they did before. At the workspace tier they
 * retire and the rail copy is the only one on screen.
 */
const RAIL_CSS = `
[data-billing-column] { max-width: ${LAYOUT.width.content}px; }
[data-billing-stage] [data-billing-flow] { display: contents; }
[data-billing-lines] { display: none; }
/* Below 1200 the document is one reading column and lines stay inside
 * "פרטים נוספים". From 1200 the rail holds identity, money, and the next
 * action, and issued lines stay visible in the stage. There is no inline PDF:
 * view, download, and share stay the issued actions. At 1600 the stage's own
 * sections sit side by side, and the lines span both. */
@media (min-width: ${DOCUMENT_DESK_MIN}px) {
  [data-billing-stage] [data-billing-flow] { display: none; }
  [data-billing-column] { max-width: none; }
  [data-billing-lines] { display: grid; gap: 12px; }
  [data-billing-more] { display: none; }
}
@media (min-width: 1600px) {
  [data-billing-stage] {
    grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr);
    align-items: start;
  }
  [data-billing-stage] > :first-child,
  [data-billing-lines] { grid-column: 1 / -1; }
}
`;
const RAIL_WIDTH = 340;


/** WorkspaceLayout owns the pane geometry here, so the page declares its own. */
const SURFACE_INTENT: PageSurfaceIntent = "workspace";

export default function BillingDocumentWorkspacePage() {
  // Compact widths keep the focused-editor treatment: the page owns its own
  // sticky action bar, and the app's fixed bottom nav would sit on top of it.
  // From the shell's desktop tier up there is no such conflict — the nav is a
  // sidebar, not a bottom bar — and suppressing it only cost the user their
  // navigation without buying the page any usable space (owner decision D-1).
  // No double navigation results: the in-page control is a *back* affordance,
  // the sidebar is primary navigation.
  const isDesktop = useMediaQuery(SHELL_DESKTOP_MIN);
  useHideShellChrome(!isDesktop);
  const params = useParams<{ id: string }>();
  const id = params?.id || "";
  const router = useRouter();
  const { t } = useI18n();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [customerInput, setCustomerInput] = useState<string>("");
  const [linesDraft, setLinesDraft] = useState<LocalLine[]>([]);
  const [patchStatus, setPatchStatus] = useState<PatchSaveStatus>("idle");
  const [patchError, setPatchError] = useState<string | null>(null);
  const [linesSaving, setLinesSaving] = useState<boolean>(false);
  const [linesError, setLinesError] = useState<string | null>(null);
  const [draftConflictMessage, setDraftConflictMessage] = useState<
    string | null
  >(null);
  const [lifecycleBusy, setLifecycleBusy] = useState<LifecycleAction | null>(
    null
  );
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [lifecycleSuccess, setLifecycleSuccess] = useState<string | null>(null);
  const [issueConfirmOpen, setIssueConfirmOpen] = useState<boolean>(false);
  const [validUntilInput, setValidUntilInput] = useState<string>("");
  const validUntilScheduleRef = useRef(0);
  const [validUntilStatus, setValidUntilStatus] =
    useState<PatchSaveStatus>("idle");
  const [validUntilError, setValidUntilError] = useState<string | null>(null);
  const [convertBusy, setConvertBusy] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingNavigation>(null);
  const [leavingSaveBusy, setLeavingSaveBusy] = useState(false);
  const [leavingError, setLeavingError] = useState<string | null>(null);
  const [completionNotice, setCompletionNotice] = useState<string | null>(null);
  // undefined = not yet fetched, null = fetched + missing, string = fetched + present
  const [profileTaxId, setProfileTaxId] = useState<string | null | undefined>(undefined);

  const patchScheduleRef = useRef(0);
  const draftInitRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setState({ kind: "error", message: t("billing.detail.missingId") });
      return;
    }

    setState({ kind: "loading" });

    try {
      const token = getAuthToken();
      const res = await fetch(`/api/billing/documents/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (res.status === 404) {
        setState({ kind: "not-found" });
        return;
      }

      if (!res.ok) {
        let message = t("billing.detail.loadError");
        try {
          const data = await res.json();
          if (data && typeof data.error === "string") {
            message = data.error;
          }
        } catch {
        }
        setState({ kind: "error", message });
        return;
      }

      const data = await res.json();
      const doc: BillingDocumentDetail | undefined = data?.document;
      if (!doc || typeof doc.id !== "number") {
        setState({ kind: "error", message: t("billing.detail.badResponse") });
        return;
      }

      setState({ kind: "ready", doc });
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error ? err.message : t("billing.detail.loadError"),
      });
    }
  }, [id, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const message = window.sessionStorage.getItem("billing:completion");
    if (!message) return;
    window.sessionStorage.removeItem("billing:completion");
    const timer = window.setTimeout(() => setCompletionNotice(message), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (state.kind !== "ready" || state.doc.status !== "DRAFT") {
      draftInitRef.current = null;
      return;
    }
    const routeId = Number(id);
    if (!routeId || state.doc.id !== routeId) return;
    if (draftInitRef.current === state.doc.id) return;
    draftInitRef.current = state.doc.id;
    setCustomerInput(state.doc.customerNameSnapshot ?? "");
    setLinesDraft(mapServerLinesToLocal(state.doc.lines));
    setValidUntilInput(
      state.doc.documentType === "QUOTE"
        ? state.doc.validUntil?.slice(0, 10) ?? ""
        : ""
    );
    setPatchError(null);
    setLinesError(null);
    setValidUntilError(null);
    setConvertError(null);
    setDraftConflictMessage(null);
  }, [id, state]);

  useEffect(() => {
    if (state.kind !== "ready" || state.doc.status !== "DRAFT") return;

    const trimmed = customerInput.trim();
    const serverTrimmed = (state.doc.customerNameSnapshot ?? "").trim();

    if (trimmed === serverTrimmed) {
      patchScheduleRef.current += 1;
      return;
    }

    if (trimmed.length === 0) {
      patchScheduleRef.current += 1;
      return;
    }

    const scheduleId = ++patchScheduleRef.current;
    const timer = window.setTimeout(async () => {
      if (scheduleId !== patchScheduleRef.current) return;

      setPatchStatus("saving");
      setPatchError(null);

      try {
        const token = getAuthToken();
        const res = await fetch(`/api/billing/documents/${id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ customerNameSnapshot: trimmed }),
        });

        if (res.status === 403) {
          draftInitRef.current = null;
          await load();
          setDraftConflictMessage(t("billing.detail.conflict"));
          setPatchStatus("idle");
          return;
        }

        if (!res.ok) {
          let message = t("billing.detail.saveCustomerError");
          try {
            const data = await res.json();
            if (data && typeof data.error === "string") {
              message = data.error;
            }
          } catch {
          }
          setPatchError(message);
          setPatchStatus("error");
          return;
        }

        if (scheduleId !== patchScheduleRef.current) return;

        const data = await res.json();
        const nextDoc: BillingDocumentDetail | undefined = data?.document;
        if (!nextDoc || typeof nextDoc.id !== "number") {
          setPatchError(t("billing.detail.badResponse"));
          setPatchStatus("error");
          return;
        }

        setState({ kind: "ready", doc: nextDoc });
        setCustomerInput(nextDoc.customerNameSnapshot ?? "");
        if (nextDoc.documentType === "QUOTE") {
          setValidUntilInput(nextDoc.validUntil?.slice(0, 10) ?? "");
        }
        setPatchStatus("saved");
        window.setTimeout(() => {
          setPatchStatus((prev) => (prev === "saved" ? "idle" : prev));
        }, 2000);
      } catch {
        if (scheduleId !== patchScheduleRef.current) return;
        setPatchError(t("billing.detail.saveCustomerConnectError"));
        setPatchStatus("error");
      }
    }, 800);

    return () => {
      window.clearTimeout(timer);
    };
  }, [customerInput, id, load, state, t]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const d = state.doc;
    if (d.status !== "DRAFT" || d.documentType !== "QUOTE") return;
    if (d.convertedToInvoiceId !== null) return;

    const server = d.validUntil?.slice(0, 10) ?? "";
    const trimmed = validUntilInput.trim();

    if (trimmed === server) {
      validUntilScheduleRef.current += 1;
      return;
    }

    const scheduleId = ++validUntilScheduleRef.current;
    const timer = window.setTimeout(async () => {
      if (scheduleId !== validUntilScheduleRef.current) return;

      setValidUntilStatus("saving");
      setValidUntilError(null);

      try {
        const token = getAuthToken();
        const res = await fetch(`/api/billing/documents/${id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            validUntil: trimmed === "" ? null : trimmed,
          }),
        });

        if (res.status === 403) {
          draftInitRef.current = null;
          await load();
          setDraftConflictMessage(t("billing.detail.conflict"));
          setValidUntilStatus("idle");
          return;
        }

        if (!res.ok) {
          let message = t("billing.detail.saveValidUntilError");
          try {
            const data = await res.json();
            if (data && typeof data.error === "string") {
              message = data.error;
            }
          } catch {
          }
          setValidUntilError(message);
          setValidUntilStatus("error");
          return;
        }

        if (scheduleId !== validUntilScheduleRef.current) return;

        const data = await res.json();
        const nextDoc: BillingDocumentDetail | undefined = data?.document;
        if (!nextDoc || typeof nextDoc.id !== "number") {
          setValidUntilError(t("billing.detail.badResponse"));
          setValidUntilStatus("error");
          return;
        }

        setState({ kind: "ready", doc: nextDoc });
        setValidUntilInput(nextDoc.validUntil?.slice(0, 10) ?? "");
        setValidUntilStatus("saved");
        window.setTimeout(() => {
          setValidUntilStatus((prev) => (prev === "saved" ? "idle" : prev));
        }, 2000);
      } catch {
        if (scheduleId !== validUntilScheduleRef.current) return;
        setValidUntilError(t("billing.detail.saveValidUntilConnectError"));
        setValidUntilStatus("error");
      }
    }, 800);

    return () => {
      window.clearTimeout(timer);
    };
  }, [validUntilInput, id, load, state, t]);

  async function handleSaveLines(focusNext = true): Promise<boolean> {
    if (state.kind !== "ready" || state.doc.status !== "DRAFT") return false;
    if (linesSaving) return false;

    setLinesSaving(true);
    setLinesError(null);

    try {
      const body = {
        lines: linesDraft.map((line, idx) => ({
          lineIndex: idx + 1,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          vatRatePercent: line.vatRatePercent,
        })),
      };

      const token = getAuthToken();
      const res = await fetch(`/api/billing/documents/${id}/lines`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.status === 403) {
        draftInitRef.current = null;
        await load();
        setDraftConflictMessage(t("billing.detail.conflict"));
        return false;
      }

      if (!res.ok) {
        let message = t("billing.detail.saveLinesError");
        try {
          const data = await res.json();
          if (data && typeof data.error === "string") {
            message = data.error;
          }
        } catch {
        }
        setLinesError(message);
        return false;
      }

      const data = await res.json();
      const nextDoc: BillingDocumentDetail | undefined = data?.document;
      if (!nextDoc || typeof nextDoc.id !== "number") {
        setLinesError(t("billing.detail.badResponse"));
        return false;
      }

      setState({ kind: "ready", doc: nextDoc });
      setLinesDraft(mapServerLinesToLocal(nextDoc.lines));
      setCustomerInput(nextDoc.customerNameSnapshot ?? "");
      if (nextDoc.documentType === "QUOTE") {
        setValidUntilInput(nextDoc.validUntil?.slice(0, 10) ?? "");
      }

      // UX: after successful lines save, move to next dominant context.
      if (
        focusNext &&
        typeof window !== "undefined" &&
        nextDoc.status === "DRAFT" &&
        nextDoc.lines.length > 0
      ) {
        const targetId =
          nextDoc.documentType === "QUOTE"
            ? "billing-quote-share"
            : "billing-issue-primary";
        const tryScroll = (remaining: number) => {
          const el = document.getElementById(targetId);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
            return;
          }
          if (remaining <= 0) return;
          window.setTimeout(() => tryScroll(remaining - 1), 120);
        };
        window.requestAnimationFrame(() => {
          window.setTimeout(() => tryScroll(18), 50);
        });
      }
      if (focusNext) {
        setLifecycleSuccess(t("billing.detail.updated"));
      }
      return true;
    } catch {
      setLinesError(t("billing.detail.saveLinesConnectError"));
      return false;
    } finally {
      setLinesSaving(false);
    }
  }

  async function handleConvertQuote() {
    if (state.kind !== "ready" || state.doc.status !== "DRAFT") return;
    if (state.doc.documentType !== "QUOTE") return;
    if (convertBusy) return;

    setConvertBusy(true);
    setConvertError(null);

    try {
      const token = getAuthToken();
      const res = await fetch(
        `/api/billing/documents/${id}/convert-to-invoice`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (res.status === 403) {
        draftInitRef.current = null;
        await load();
        setDraftConflictMessage(t("billing.detail.conflict"));
        return;
      }

      if (!res.ok) {
        let message = t("billing.detail.convertError");
        try {
          const data = await res.json();
          if (data && typeof data.error === "string") {
            message = data.error;
          }
        } catch {
        }
        setConvertError(message);
        return;
      }

      const data = await res.json();
      const invId: unknown = data?.document?.id;
      if (typeof invId !== "number") {
        setConvertError(t("billing.detail.badResponse"));
        return;
      }

      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(
          "billing:completion",
          t("billing.detail.convertedNotice")
        );
      }
      router.push(`/billing/${invId}`);
    } catch {
      setConvertError(t("billing.detail.convertConnectError"));
    } finally {
      setConvertBusy(false);
    }
  }

  const runLifecycle = useCallback(
    async (path: string, action: LifecycleAction) => {
      setLifecycleBusy(action);
      setLifecycleError(null);
      try {
        const token = getAuthToken();
        const res = await fetch(`/api/billing/documents/${id}${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.status === 403) {
          draftInitRef.current = null;
          await load();
          setDraftConflictMessage(t("billing.detail.conflict"));
          if (action === "issue") setIssueConfirmOpen(false);
          return;
        }

        if (!res.ok) {
          const baseMessage =
            action === "submit"
              ? t("billing.detail.submitError")
              : action === "revert"
              ? t("billing.detail.revertError")
              : t("billing.detail.issueError");
          let serverDetail: string | null = null;
          try {
            const data = await res.json();
            if (data && typeof data.error === "string" && data.error.trim()) {
              serverDetail = data.error.trim();
            }
          } catch {
          }
          setLifecycleError(
            serverDetail ? `${baseMessage} - ${serverDetail}` : baseMessage
          );
          return;
        }

        const data = await res.json();
        const nextDoc: BillingDocumentDetail | undefined = data?.document;
        if (!nextDoc || typeof nextDoc.id !== "number") {
          setLifecycleError(t("billing.detail.badResponse"));
          return;
        }

        setState({ kind: "ready", doc: nextDoc });
        if (nextDoc.status === "DRAFT") {
          setCustomerInput(nextDoc.customerNameSnapshot ?? "");
          setLinesDraft(mapServerLinesToLocal(nextDoc.lines));
          if (nextDoc.documentType === "QUOTE") {
            setValidUntilInput(nextDoc.validUntil?.slice(0, 10) ?? "");
          }
        }

        if (action === "submit") {
          setLifecycleSuccess(t("billing.detail.submitted"));
        } else if (action === "revert") {
          setLifecycleSuccess(t("billing.detail.reverted"));
        } else if (action === "issue") {
          // "Issued" and "allocation received" are DISTINCT states — never show a
          // generic success just because the document status is ISSUED. Derive the
          // message from the authority outcome; only a granted number (or a
          // not-required document) is a green success — everything else surfaces
          // as a non-success notice that needs handling.
          const authority = data?.authority as AuthorityIssueOutcome | undefined;
          if (authority) {
            const view = describeAuthorityIssueOutcome(authority);
            const message = `${view.title} — ${view.detail}`;
            if (view.tone === "success" || view.tone === "info") {
              setLifecycleSuccess(message);
            } else {
              setLifecycleError(message);
            }
          } else {
            setLifecycleSuccess(t("billing.detail.issued"));
          }
          setIssueConfirmOpen(false);
        }
      } catch {
        setLifecycleError(t("billing.detail.connectError"));
      } finally {
        setLifecycleBusy(null);
      }
    },
    [id, load, t]
  );

  useEffect(() => {
    if (!lifecycleSuccess) return;
    const timer = window.setTimeout(() => setLifecycleSuccess(null), 4000);
    return () => window.clearTimeout(timer);
  }, [lifecycleSuccess]);

  const fetchProfileForWarning = useCallback(async () => {
    if (profileTaxId !== undefined) return;
    try {
      const token = getAuthToken();
      const res = await fetch("/api/billing/invoice-profile", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        const t: unknown = data?.profile?.billingTaxId;
        setProfileTaxId(typeof t === "string" && t.length > 0 ? t : null);
      }
    } catch {
      // fail-open — don't block ISSUE if fetch fails
    }
  }, [profileTaxId]);

  const heading =
    state.kind === "ready"
      ? state.doc.documentNumberFormatted ??
        (state.doc.documentType === "QUOTE"
          ? t("billing.docType.QUOTE")
          : t("billing.list.draftNoNumber"))
      : t("billing.detail.headingFallback");

  const status: BillingStatus | null =
    state.kind === "ready" ? state.doc.status : null;

  const dirtyLines =
    state.kind === "ready" && state.doc.status === "DRAFT"
      ? linesAreDirty(linesDraft, state.doc.lines)
      : false;

  const customerDirty =
    state.kind === "ready" && state.doc.status === "DRAFT"
      ? customerInput.trim() !== (state.doc.customerNameSnapshot ?? "").trim()
      : false;

  const validUntilDirty =
    state.kind === "ready" &&
    state.doc.status === "DRAFT" &&
    state.doc.documentType === "QUOTE" &&
    state.doc.convertedToInvoiceId === null
      ? validUntilInput.trim() !== (state.doc.validUntil?.slice(0, 10) ?? "")
      : false;

  const hasUnsavedDraftChanges =
    dirtyLines ||
    customerDirty ||
    validUntilDirty ||
    patchStatus === "saving" ||
    validUntilStatus === "saving" ||
    linesSaving;

  useEffect(() => {
    if (!hasUnsavedDraftChanges) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedDraftChanges]);

  async function saveDraftFieldsNow(): Promise<boolean> {
    if (state.kind !== "ready" || state.doc.status !== "DRAFT") return true;

    const body: Record<string, unknown> = {};
    if (customerDirty) {
      const trimmed = customerInput.trim();
      if (!trimmed) {
        setPatchError(t("billing.detail.leaveNeedsCustomer"));
        return false;
      }
      body.customerNameSnapshot = trimmed;
    }
    if (validUntilDirty && state.doc.documentType === "QUOTE") {
      const trimmed = validUntilInput.trim();
      body.validUntil = trimmed === "" ? null : trimmed;
    }
    if (Object.keys(body).length === 0) return true;

    patchScheduleRef.current += 1;
    validUntilScheduleRef.current += 1;
    setPatchStatus("saving");
    setPatchError(null);
    setValidUntilError(null);

    try {
      const token = getAuthToken();
      const res = await fetch(`/api/billing/documents/${id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setPatchError(t("billing.detail.saveFieldsError"));
        setPatchStatus("error");
        return false;
      }
      const data = await res.json();
      const nextDoc: BillingDocumentDetail | undefined = data?.document;
      if (!nextDoc || typeof nextDoc.id !== "number") {
        setPatchError(t("billing.detail.badResponse"));
        setPatchStatus("error");
        return false;
      }
      setState({ kind: "ready", doc: nextDoc });
      setCustomerInput(nextDoc.customerNameSnapshot ?? "");
      if (nextDoc.documentType === "QUOTE") {
        setValidUntilInput(nextDoc.validUntil?.slice(0, 10) ?? "");
      }
      setPatchStatus("saved");
      window.setTimeout(() => {
        setPatchStatus((prev) => (prev === "saved" ? "idle" : prev));
      }, 2000);
      return true;
    } catch {
      setPatchError(t("billing.identity.saveConnectFailed"));
      setPatchStatus("error");
      return false;
    }
  }

  async function handleSaveAndContinueNavigation() {
    if (!pendingNavigation || leavingSaveBusy) return;
    setLeavingSaveBusy(true);
    setLeavingError(null);
    try {
      const fieldsSaved = await saveDraftFieldsNow();
      if (!fieldsSaved) {
        setLeavingError(t("billing.detail.leaveSaveAllError"));
        return;
      }
      const linesSaved = dirtyLines ? await handleSaveLines(false) : true;
      if (!linesSaved) {
        setLeavingError(t("billing.detail.leaveSaveLinesError"));
        return;
      }
      const pending = pendingNavigation;
      setPendingNavigation(null);
      continuePendingNavigation(pending, router.push);
    } finally {
      setLeavingSaveBusy(false);
    }
  }

  return (
    <main
      data-page-intent={SURFACE_INTENT}
      style={{
        minHeight: "100dvh",
        background: TOKEN.surface.inset,
        padding: "24px 16px 80px",
      }}
    >
      {/*
        The document column used to be capped at a local 720 at every width, so
        a 1920 viewport rendered a 720 column with ~600px of dead canvas on each
        side. It now takes the canonical `content` cap: wide enough that tablets
        stop rendering the phone layout with margins, still a comfortable
        reading measure, and — above the workspace tier — bounded by its pane
        rather than by this rule.
      */}
      {/* Page level, not inside DocumentBody: the column cap has to hold for the
          loading, error and not-found states too, and those render without it. */}
      <style>{RAIL_CSS}</style>
      {/* Width lives in RAIL_CSS, not here: an inline max-width outranks a
          stylesheet rule, so the workspace-tier widening could never apply. */}
      <div data-billing-column style={{ margin: "0 auto" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 16,
          }}
        >
          <BackButton
            onBeforeLeave={(proceed) => {
              if (hasUnsavedDraftChanges) {
                setLeavingError(null);
                setPendingNavigation({ proceed });
                return;
              }
              proceed();
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: TOKEN.ink.primary,
                margin: 0,
                lineHeight: 1.2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {heading}
            </h1>
          </div>
          {status ? <StatusBadge status={status} /> : null}
        </header>

        {completionNotice ? (
          <div
            role="status"
            style={{
              background: TOKEN.semantic.success.bg,
              border: `1px solid ${TOKEN.semantic.success.border}`,
              color: TOKEN.semantic.success.ink,
              borderRadius: 12,
              padding: "10px 14px",
              fontSize: 14,
              fontWeight: 600,
              marginBottom: 12,
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
            }}
          >
            <span>{completionNotice}</span>
            <button
              type="button"
              onClick={() => setCompletionNotice(null)}
              style={{
                border: "none",
                background: "transparent",
                color: TOKEN.semantic.success.ink,
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 18,
                lineHeight: 1,
                padding: 0,
              }}
              aria-label={t("billing.couponIssue.close")}
            >
              ×
            </button>
          </div>
        ) : null}

        {state.kind === "loading" ? <WorkspaceSkeleton /> : null}
        {state.kind === "error" ? (
          <ErrorBanner message={state.message} onRetry={() => void load()} />
        ) : null}
        {state.kind === "not-found" ? <NotFoundCard /> : null}
        {state.kind === "ready" ? (
          <DocumentBody
            doc={state.doc}
            authToken={getAuthToken()}
            customerInput={customerInput}
            onCustomerChange={setCustomerInput}
            patchStatus={patchStatus}
            patchError={patchError}
            linesDraft={linesDraft}
            onLinesChange={setLinesDraft}
            onSaveLines={() => void handleSaveLines()}
            linesSaving={linesSaving}
            linesError={linesError}
            dirtyLines={dirtyLines}
            draftConflictMessage={draftConflictMessage}
            onDismissConflict={() => setDraftConflictMessage(null)}
            lifecycleBusy={lifecycleBusy}
            lifecycleError={lifecycleError}
            lifecycleSuccess={lifecycleSuccess}
            onDismissLifecycleError={() => setLifecycleError(null)}
            onDismissLifecycleSuccess={() => setLifecycleSuccess(null)}
            onReloadDocument={() => void load()}
            onSubmitForReview={() => void runLifecycle("/submit", "submit")}
            onRevert={() => void runLifecycle("/revert", "revert")}
            onOpenIssueDialog={() => {
              setLifecycleError(null);
              setIssueConfirmOpen(true);
              void fetchProfileForWarning();
            }}
            issueDialogOpen={issueConfirmOpen}
            validUntilInput={validUntilInput}
            onValidUntilChange={setValidUntilInput}
            validUntilStatus={validUntilStatus}
            validUntilError={validUntilError}
            onConvertQuote={() => void handleConvertQuote()}
            convertBusy={convertBusy}
            convertError={convertError}
          />
        ) : null}
      </div>
      {issueConfirmOpen ? (
        <IssueConfirmDialog
          issuing={lifecycleBusy === "issue"}
          errorMessage={lifecycleError}
          missingTaxId={profileTaxId === null}
          onCancel={() => {
            if (lifecycleBusy === "issue") return;
            setIssueConfirmOpen(false);
            setLifecycleError(null);
          }}
          onConfirm={() => void runLifecycle("/issue", "issue")}
        />
      ) : null}
      {pendingNavigation ? (
        <UnsavedChangesDialog
          saving={leavingSaveBusy}
          errorMessage={leavingError}
          onSaveAndContinue={() => void handleSaveAndContinueNavigation()}
          onLeaveWithoutSaving={() => {
            const pending = pendingNavigation;
            setPendingNavigation(null);
            continuePendingNavigation(pending, router.push);
          }}
          onKeepEditing={() => {
            if (leavingSaveBusy) return;
            setPendingNavigation(null);
            setLeavingError(null);
          }}
        />
      ) : null}
    </main>
  );
}





function DocumentBody({
  doc,
  authToken,
  customerInput,
  onCustomerChange,
  patchStatus,
  patchError,
  linesDraft,
  onLinesChange,
  onSaveLines,
  linesSaving,
  linesError,
  dirtyLines,
  draftConflictMessage,
  onDismissConflict,
  lifecycleBusy,
  lifecycleError,
  lifecycleSuccess,
  onDismissLifecycleError,
  onDismissLifecycleSuccess,
  onReloadDocument,
  onSubmitForReview,
  onRevert,
  onOpenIssueDialog,
  issueDialogOpen,
  validUntilInput,
  onValidUntilChange,
  validUntilStatus,
  validUntilError,
  onConvertQuote,
  convertBusy,
  convertError,
}: {
  doc: BillingDocumentDetail;
  authToken: string;
  customerInput: string;
  onCustomerChange: (value: string) => void;
  patchStatus: PatchSaveStatus;
  patchError: string | null;
  linesDraft: LocalLine[];
  onLinesChange: Dispatch<SetStateAction<LocalLine[]>>;
  onSaveLines: () => void;
  linesSaving: boolean;
  linesError: string | null;
  dirtyLines: boolean;
  draftConflictMessage: string | null;
  onDismissConflict: () => void;
  lifecycleBusy: LifecycleAction | null;
  lifecycleError: string | null;
  lifecycleSuccess: string | null;
  onDismissLifecycleError: () => void;
  onDismissLifecycleSuccess: () => void;
  onReloadDocument: () => void;
  onSubmitForReview: () => void;
  onRevert: () => void;
  onOpenIssueDialog: () => void;
  issueDialogOpen: boolean;
  validUntilInput: string;
  onValidUntilChange: (value: string) => void;
  validUntilStatus: PatchSaveStatus;
  validUntilError: string | null;
  onConvertQuote: () => void;
  convertBusy: boolean;
  convertError: string | null;
}) {
  const { t } = useI18n();
  const isDraft = doc.status === "DRAFT";
  const quoteLocked =
    doc.documentType === "QUOTE" && doc.convertedToInvoiceId !== null;
  const isQuoteDraft = doc.documentType === "QUOTE" && isDraft;
  const prevSnapshotRef = useRef<{
    status: BillingStatus;
    linesLen: number;
    editingComplete: boolean;
  } | null>(null);
  const lastAutoFocusKeyRef = useRef<string | null>(null);

  function updateLine(
    key: string,
    patch: Partial<Pick<LocalLine, "description" | "quantity" | "unitPrice" | "vatRatePercent">>
  ) {
    onLinesChange((prev) =>
      prev.map((l) => (l.key === key ? { ...l, ...patch } : l))
    );
  }

  function removeLine(key: string) {
    onLinesChange((prev) => prev.filter((l) => l.key !== key));
  }

  function addLine() {
    onLinesChange((prev) => [...prev, newEmptyLocalLine()]);
  }

  const customerDirty =
    customerInput.trim() !== (doc.customerNameSnapshot ?? "").trim();

  const linesSaveAllowed =
    linesDraft.every(
      (l) =>
        looksLikeDecimalInput(l.quantity) &&
        looksLikeDecimalInput(l.unitPrice) &&
        looksLikeDecimalInput(l.vatRatePercent)
    ) &&
    !linesSaving &&
    !customerDirty &&
    patchStatus !== "saving" &&
    validUntilStatus !== "saving" &&
    !quoteLocked;

  const submitForReviewDisabled =
    dirtyLines ||
    linesSaving ||
    doc.lines.length === 0 ||
    lifecycleBusy !== null ||
    patchStatus === "saving" ||
    validUntilStatus === "saving" ||
    customerDirty;

  const convertDisabled =
    convertBusy ||
    dirtyLines ||
    linesSaving ||
    customerDirty ||
    patchStatus === "saving" ||
    validUntilStatus === "saving" ||
    doc.lines.length === 0 ||
    (doc.customerNameSnapshot ?? "").trim().length === 0;

  const missing: Array<{ key: string; label: string; actionId?: string }> = [];
  const customerOk = (doc.customerNameSnapshot ?? "").trim().length > 0;
  const linesOk = doc.lines.length > 0;

  if (isDraft && !customerOk) {
    missing.push({
      key: "customer",
      label: t("billing.detail.missingCustomer"),
      actionId: "billing-customer",
    });
  }
  if (isDraft && !linesOk) {
    missing.push({
      key: "lines",
      label: t("billing.detail.missingLine"),
      actionId: "billing-lines",
    });
  }
  if (isDraft && dirtyLines) {
    missing.push({
      key: "unsaved-lines",
      label: t("billing.detail.unsavedLines"),
      actionId: "billing-lines",
    });
  }
  if (isDraft && customerDirty) {
    missing.push({
      key: "unsaved-customer",
      label: t("billing.detail.unsavedCustomer"),
      actionId: "billing-customer",
    });
  }

  const quoteValidUntilEmpty =
    isQuoteDraft && !quoteLocked && (validUntilInput ?? "").trim().length === 0;

  const editingComplete =
    doc.status === "DRAFT" &&
    !dirtyLines &&
    !customerDirty &&
    patchStatus !== "saving" &&
    validUntilStatus !== "saving" &&
    !linesSaving &&
    doc.lines.length > 0;

  let stage: StageKey;
  if (doc.status === "ISSUED") {
    stage = "issued";
  } else if (doc.status === "PENDING_REVIEW") {
    stage = "pending_review";
  } else if (doc.documentType === "QUOTE" && quoteLocked) {
    stage = "quote_converted";
  } else if (doc.documentType === "QUOTE") {
    stage = missing.length > 0 ? "draft_missing" : "quote_ready";
  } else {
    stage = missing.length > 0 ? "draft_missing" : "draft_ready";
  }

  const stickyPrimaryAction: StickyPrimaryAction =
    stage === "draft_ready"
      ? { kind: "open-issue-dialog" }
      : stage === "quote_ready"
      ? { kind: "scroll", targetId: "billing-quote-share", label: t("billing.detail.quoteActions") }
      : stage === "pending_review"
      ? {
          kind: "scroll",
          targetId: "billing-pending-actions",
          label: t("billing.detail.reviewActions"),
        }
      : stage === "issued"
      ? { kind: "scroll", targetId: "billing-issued-actions", label: t("billing.detail.shareDocument") }
      : { kind: "none" };

  useEffect(() => {
    // Detect real transitions based on prev -> current. Derived UI-only, no new business state.
    const prev = prevSnapshotRef.current;
    const next = {
      status: doc.status,
      linesLen: doc.lines.length,
      editingComplete,
    };
    prevSnapshotRef.current = next;

    // Don't auto-scroll while anything is saving/busy or while dialogs are open.
    if (
      linesSaving ||
      patchStatus === "saving" ||
      validUntilStatus === "saving" ||
      lifecycleBusy !== null ||
      issueDialogOpen
    ) {
      return;
    }

    // Avoid fighting the user while they're actively typing in the lines editor.
    const linesSection = document.getElementById("billing-lines");
    const active = document.activeElement;
    if (linesSection && active && linesSection.contains(active)) {
      return;
    }

    const focusOnce = (key: string, targetId: string) => {
      if (lastAutoFocusKeyRef.current === key) return;
      lastAutoFocusKeyRef.current = key;
      // Wait a tick so layout is stable.
      window.requestAnimationFrame(() => {
        window.setTimeout(() => scrollToId(targetId), 50);
      });
    };

    // Transition (2): After issue success -> move to IssuedHero result.
    if (prev && prev.status !== "ISSUED" && doc.status === "ISSUED") {
      const key = `issued:${doc.id}:${doc.issuedAt ?? doc.updatedAt}`;
      focusOnce(key, "billing-issued-actions");
    }
  }, [
    doc.id,
    doc.status,
    doc.documentType,
    doc.lines.length,
    doc.updatedAt,
    doc.issuedAt,
    editingComplete,
    dirtyLines,
    customerDirty,
    linesSaving,
    patchStatus,
    validUntilStatus,
    lifecycleBusy,
    issueDialogOpen,
  ]);

  const editingDeemphasized = doc.status !== "DRAFT" || editingComplete;
  const customerFocus = isDraft && !customerOk && !quoteLocked;
  const itemsFocus = isDraft && customerOk && (!linesOk || dirtyLines) && !quoteLocked;
  const readyInvoiceFocus =
    isDraft && doc.documentType !== "QUOTE" && editingComplete && !quoteLocked;
  const readyQuoteFocus =
    isQuoteDraft && editingComplete && !quoteLocked;
  const convertedQuoteFocus = doc.documentType === "QUOTE" && quoteLocked;
  const pendingReviewFocus = doc.status === "PENDING_REVIEW";
  const issuedFocus = doc.status === "ISSUED";

  const customerSection = isDraft ? (
    <DraftEditorSection
      doc={doc}
      authToken={authToken}
      customerInput={customerInput}
      onCustomerChange={onCustomerChange}
      patchStatus={patchStatus}
      patchError={patchError}
      onCustomerPickSuccess={onReloadDocument}
      disabled={quoteLocked}
      showValidUntil={doc.documentType === "QUOTE"}
      validUntilInput={validUntilInput}
      onValidUntilChange={onValidUntilChange}
      validUntilStatus={validUntilStatus}
      validUntilError={validUntilError}
      visualTone={editingDeemphasized ? "secondary" : "default"}
    />
  ) : null;

  const draftLinesSection = isDraft ? (
    <DraftLinesSection
      currency={doc.currency}
      linesDraft={linesDraft}
      docLines={doc.lines}
      onUpdateLine={updateLine}
      onRemoveLine={removeLine}
      onAddLine={addLine}
      onSaveLines={onSaveLines}
      linesSaving={linesSaving}
      linesError={linesError}
      linesSaveAllowed={linesSaveAllowed}
      customerDirty={customerDirty}
      patchSaving={
        patchStatus === "saving" || validUntilStatus === "saving"
      }
      draftLocked={quoteLocked}
      visualTone={editingDeemphasized ? "secondary" : "default"}
    />
  ) : null;

  const detailsContext = (
    <CollapsiblePanel title={t("billing.detail.moreDetails")}>
      <DetailsCard doc={doc} hideCustomer={isDraft} />
      {isDraft ? null : <LinesSection lines={doc.lines} currency={doc.currency} />}
      <TotalsCard doc={doc} showUnsavedLinesHint={dirtyLines && isDraft} />
      {doc.documentType === "TAX_INVOICE" ? <IssuerSummaryBadge /> : null}
    </CollapsiblePanel>
  );

  /**
   * The context summary — identity, customer, server-derived totals, status.
   * Every stage except the very first already renders one; that is precisely
   * what makes it rail material above the workspace tier. It is *hoisted*, not
   * duplicated: whichever region owns it, the other renders nothing, so no
   * monetary value gains or loses a rendering and no value that was previously
   * hidden becomes visible. The rail is not a new authority — it shows the
   * same nodes, fed by the same props, from the same server-derived strings.
   */
  const contextSummary = customerFocus ? null : itemsFocus ? (
    <>
      <CustomerSummaryCard doc={doc} />
      <TotalsCard doc={doc} showUnsavedLinesHint={dirtyLines && isDraft} />
    </>
  ) : (
    <ReviewSummaryCard doc={doc} />
  );

  const lifecycleAction = (
    <StickyActionBar
      stage={stage}
      missing={missing}
      quoteValidUntilEmpty={quoteValidUntilEmpty}
      // Single owner of the bottom sticky region per state: while the lines
      // editor is on screen it owns that region, so the action bar yields.
      // In the rail there is no bottom region to contend for at all.
      linesEditorActive={itemsFocus}
      primaryAction={stickyPrimaryAction}
      issueDisabled={submitForReviewDisabled}
      onOpenIssue={onOpenIssueDialog}
      convertDisabled={convertDisabled}
      convertBusy={convertBusy}
      onConvert={onConvertQuote}
    />
  );

  const stageContent = (
    <div style={{ display: "grid", gap: 12 }} data-billing-stage>
      <StageAwarePanel
        stage={stage}
        doc={doc}
        missing={missing}
        quoteValidUntilEmpty={quoteValidUntilEmpty}
      />

      <div data-billing-flow>{lifecycleAction}</div>

      {draftConflictMessage ? (
        <div
          role="alert"
          style={{
            background: TOKEN.semantic.attention.bg,
            border: `1px solid ${TOKEN.semantic.attention.border}`,
            color: TOKEN.semantic.attention.ink,
            borderRadius: 12,
            padding: "12px 14px",
            fontSize: 14,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "flex-start",
          }}
        >
          <span>{draftConflictMessage}</span>
          <button
            type="button"
            onClick={onDismissConflict}
            style={{
              border: "none",
              background: "transparent",
              color: TOKEN.semantic.attention.ink,
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 18,
              lineHeight: 1,
              padding: 0,
            }}
            aria-label={t("billing.couponIssue.close")}
          >
            ×
          </button>
        </div>
      ) : null}

      {lifecycleSuccess ? (
        <div
          role="status"
          style={{
            background: TOKEN.semantic.success.bg,
            border: `1px solid ${TOKEN.semantic.success.border}`,
            color: TOKEN.semantic.success.ink,
            borderRadius: 12,
            padding: "10px 14px",
            fontSize: 14,
            fontWeight: 600,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
          }}
        >
          <span>{lifecycleSuccess}</span>
          <button
            type="button"
            onClick={onDismissLifecycleSuccess}
            style={{
              border: "none",
              background: "transparent",
              color: TOKEN.semantic.success.ink,
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 18,
              lineHeight: 1,
              padding: 0,
            }}
            aria-label={t("billing.couponIssue.close")}
          >
            ×
          </button>
        </div>
      ) : null}

      {lifecycleError && !issueDialogOpen ? (
        <div
          role="alert"
          style={{
            background: TOKEN.semantic.urgent.bg,
            border: `1px solid ${TOKEN.semantic.urgent.border}`,
            color: TOKEN.semantic.urgent.ink,
            borderRadius: 12,
            padding: "12px 14px",
            fontSize: 14,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "flex-start",
          }}
        >
          <span>{lifecycleError}</span>
          <button
            type="button"
            onClick={onDismissLifecycleError}
            style={{
              border: "none",
              background: "transparent",
              color: TOKEN.semantic.urgent.ink,
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 18,
              lineHeight: 1,
              padding: 0,
            }}
            aria-label={t("billing.couponIssue.close")}
          >
            ×
          </button>
        </div>
      ) : null}

      {convertError ? (
        <div
          role="alert"
          style={{
            background: TOKEN.semantic.urgent.bg,
            border: `1px solid ${TOKEN.semantic.urgent.border}`,
            color: TOKEN.semantic.urgent.ink,
            borderRadius: 12,
            padding: "12px 14px",
            fontSize: 14,
          }}
        >
          {convertError}
        </div>
      ) : null}

      {customerFocus ? (
        <>
          {customerSection}
          {detailsContext}
        </>
      ) : null}

      {itemsFocus ? (
        <>
          <div data-billing-flow>{contextSummary}</div>
          {draftLinesSection}
          {detailsContext}
        </>
      ) : null}

      {readyInvoiceFocus ? (
        <>
          <div data-billing-flow>{contextSummary}</div>
          <DraftIssuePrimarySection
            issueDisabled={submitForReviewDisabled}
            issueLoading={lifecycleBusy === "issue"}
            onOpenIssue={onOpenIssueDialog}
            submitDisabled={submitForReviewDisabled}
            submitLoading={lifecycleBusy === "submit"}
            onSubmitForReview={onSubmitForReview}
            customerDirty={customerDirty}
          />
          {doc.documentType === "TAX_INVOICE" ? <IssuerSummaryBadge /> : null}
          <CollapsiblePanel title={t("billing.detail.moreEditing")}>
            {customerSection}
            {draftLinesSection}
            <TotalsCard doc={doc} showUnsavedLinesHint={dirtyLines && isDraft} />
          </CollapsiblePanel>
          {detailsContext}
        </>
      ) : null}

      {readyQuoteFocus ? (
        <>
          <div data-billing-flow>{contextSummary}</div>
          <QuoteDraftHero
            doc={doc}
            locked={quoteLocked}
            convertDisabled={convertDisabled}
            convertBusy={convertBusy}
            onConvert={onConvertQuote}
          />
          <CollapsiblePanel title={t("billing.detail.moreEditing")}>
            {customerSection}
            {draftLinesSection}
            <TotalsCard doc={doc} showUnsavedLinesHint={dirtyLines && isDraft} />
          </CollapsiblePanel>
          {detailsContext}
        </>
      ) : null}

      {convertedQuoteFocus ? (
        <>
          <QuoteDraftHero
            doc={doc}
            locked={quoteLocked}
            convertDisabled={convertDisabled}
            convertBusy={convertBusy}
            onConvert={onConvertQuote}
          />
          <div data-billing-flow>{contextSummary}</div>
          {detailsContext}
        </>
      ) : null}

      {issuedFocus ? (
        <>
          <IssuedHero doc={doc} />
          {shouldShowCollections(doc.documentType, doc.status) ? (
            <CollectionsSection doc={doc} />
          ) : null}
          <div data-billing-lines>
            <LinesSection lines={doc.lines} currency={doc.currency} />
            <TotalsCard doc={doc} />
          </div>
          <div data-billing-flow>{contextSummary}</div>
          <div data-billing-more>{detailsContext}</div>
        </>
      ) : null}

      {pendingReviewFocus ? (
        <>
        <PendingReviewLifecycleSection
          doc={doc}
          lifecycleBusy={lifecycleBusy}
          onRevert={onRevert}
          onOpenIssueDialog={onOpenIssueDialog}
        />
        <div data-billing-flow>{contextSummary}</div>
        {detailsContext}
        </>
      ) : null}
    </div>
  );

  /**
   * Above the workspace tier the same content gains a persistent context rail.
   * This is `WorkspaceLayout` — the primitive Customers and Suppliers already
   * use — in a different proportion, not a new one: the fixed-width region sits
   * at inline-start (beside the shell sidebar in RTL) and the flexible stage
   * content takes the end, exactly the spatial grammar the CRM surfaces teach.
   * `switch` with `visible: "end"` collapses every width below the tier to the
   * stage content alone — the mobile composition, untouched.
   *
   * The switch is entirely CSS. A first attempt branched on `useMediaQuery` and
   * returned a different tree per tier, which remounted the whole subtree when
   * the query resolved after hydration — and a remount re-runs child effects,
   * so `CollectionsSection` and `IssuerSummaryBadge` re-fetched. The fiscal
   * snapshot caught it as an API regression (invoice-profile 20 -> 22,
   * payments/requests 8 -> 12). Both regions are therefore always rendered and
   * CSS decides which is visible: the summary and the action exist twice in the
   * DOM and exactly once on screen. Safe because both are pure display over
   * server-derived props — neither owns state or fires an effect.
   */
  return (
    <WorkspaceLayout
      start={
        <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
          {contextSummary}
          {lifecycleAction}
        </div>
      }
      end={stageContent}
      startWidth={RAIL_WIDTH}
      breakpointStep={DOCUMENT_DESK_MIN}
      responsive={{ mode: "switch", visible: "end" }}
      startLabel={t("billing.detail.railStart")}
      endLabel={t("billing.detail.railEnd")}
    />
  );
}





/**
 * The "what's missing" entries are the primary navigation inside a draft, and
 * as bare text buttons they measured 20px tall — below the 24x24 gating target
 * (Accessibility Constitution A-7 / WCAG 2.2 §2.5.8). A centred inline-flex box
 * with a min-height reaches 24 without introducing padding that would loosen
 * the list's rhythm. Presentation only: same handler, same label, same colour.
 */
const MISSING_LINK_STYLE = {
  border: "none",
  background: "transparent",
  padding: 0,
  minHeight: 24,
  display: "inline-flex",
  alignItems: "center",
  cursor: "pointer",
  textDecoration: "underline",
  fontWeight: 600,
} as const;

function StageAwarePanel({
  stage,
  doc,
  missing,
  quoteValidUntilEmpty,
}: {
  stage: StageKey;
  doc: BillingDocumentDetail;
  missing: Array<{ key: string; label: string; actionId?: string }>;
  quoteValidUntilEmpty: boolean;
}) {
  const { t } = useI18n();
  const isQuote = doc.documentType === "QUOTE";

  const title =
    stage === "issued"
      ? t("billing.detail.stageIssued")
      : stage === "pending_review"
      ? t("billing.status.PENDING_REVIEW")
      : stage === "quote_converted"
      ? t("billing.detail.stageQuoteConverted")
      : stage === "quote_ready"
      ? t("billing.detail.stageQuoteReady")
      : stage === "draft_ready"
      ? t("billing.detail.stageDraftReady")
      : t("billing.detail.stageMissing");

  const tone =
    stage === "draft_missing"
      ? { bg: TOKEN.semantic.attention.bg, border: TOKEN.semantic.attention.border, fg: TOKEN.semantic.attention.ink }
      : stage === "issued"
      ? { bg: TOKEN.semantic.success.bg, border: TOKEN.semantic.success.border, fg: TOKEN.semantic.success.ink }
      : isQuote
      ? { bg: TOKEN.semantic.info.bg, border: TOKEN.semantic.info.border, fg: TOKEN.semantic.info.ink }
      : { bg: TOKEN.surface.card, border: TOKEN.border.DEFAULT, fg: TOKEN.ink.primary };

  return (
    <section
      style={{
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderRadius: 16,
        padding: 16,
        display: "grid",
        gap: 10,
      }}
      aria-label={t("billing.detail.nextStepAria")}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: tone.fg }}>
            {title}
          </div>
          <div style={{ fontSize: 13, color: TOKEN.ink.secondary, marginTop: 4, lineHeight: 1.55 }}>
            {stage === "draft_ready"
              ? t("billing.detail.stageDraftReadyHelp")
              : stage === "quote_ready"
              ? t("billing.detail.quoteShareHelp")
              : stage === "quote_converted"
              ? t("billing.detail.stageQuoteConvertedHelp")
              : stage === "pending_review"
              ? t("billing.detail.stagePendingHelp")
              : stage === "issued"
              ? t("billing.detail.stageIssuedHelp")
              : t("billing.detail.stageMissingHelp")}
          </div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: TOKEN.ink.muted, whiteSpace: "nowrap" }}>
          {isQuote ? t("billing.list.lifecycleQuote") : t("billing.detail.invoiceShort")} · {getStatusLabel(doc.status, t)}
        </div>
      </div>

      {missing.length > 0 || quoteValidUntilEmpty ? (
        <div
          style={{
            background: TOKEN.surface.card,
            border: `1px solid ${TOKEN.border.DEFAULT}`,
            borderRadius: 12,
            padding: 12,
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: TOKEN.ink.primary }}>
            {t("billing.detail.missingTitle")}
          </div>
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            {missing.map((m) => (
              <li key={m.key} style={{ fontSize: 13, marginBottom: 4, color: TOKEN.ink.primary }}>
                {m.actionId ? (
                  <button
                    type="button"
                    onClick={() => scrollToId(m.actionId!)}
                    style={{ ...MISSING_LINK_STYLE, color: TOKEN.ink.primary }}
                  >
                    {m.label}
                  </button>
                ) : (
                  <span style={{ fontWeight: 600 }}>{m.label}</span>
                )}
              </li>
            ))}
            {quoteValidUntilEmpty ? (
              <li style={{ fontSize: 13, marginBottom: 0, color: TOKEN.ink.primary }}>
                <button
                  type="button"
                  onClick={() => scrollToId("billing-valid-until")}
                  style={{ ...MISSING_LINK_STYLE, color: TOKEN.ink.primary }}
                >
                  {t("billing.detail.recommendValidUntil")}
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function StickyActionBar({
  stage,
  missing,
  quoteValidUntilEmpty,
  linesEditorActive,
  primaryAction,
  issueDisabled,
  onOpenIssue,
  convertDisabled,
  convertBusy,
  onConvert,
}: {
  stage: StageKey;
  missing: Array<{ key: string; label: string; actionId?: string }>;
  quoteValidUntilEmpty: boolean;
  /** True while `DraftLinesSection` is rendered — it owns the bottom region then. */
  linesEditorActive: boolean;
  primaryAction: StickyPrimaryAction;
  issueDisabled: boolean;
  onOpenIssue: () => void;
  convertDisabled: boolean;
  convertBusy: boolean;
  onConvert: () => void;
}) {
  const { t } = useI18n();
  const show =
    stage !== "draft_missing" ||
    missing.length > 0 ||
    quoteValidUntilEmpty;

  if (!show) return null;

  const firstMissingTarget =
    missing.find((m) => !!m.actionId)?.actionId ??
    (quoteValidUntilEmpty ? "billing-valid-until" : null);

  // Exactly one owner of the bottom sticky region per state. This used to be
  // discovered at runtime by an IntersectionObserver on
  // `#billing-lines-sticky-controls`, but that observer was attached in a
  // mount-once effect, and this bar renders *before* the stage branches — so
  // the element did not exist yet, `getElementById` returned null, and the
  // guard silently never armed. The stage already knows the answer, so it is
  // passed down instead of sniffed from the DOM: no timing dependency, and
  // ownership is decided per state rather than per scroll position.
  if (linesEditorActive) return null;

  // Preferred conservative rule: if we're guiding the user to lines, don't add a competing sticky bar.
  if (firstMissingTarget === "billing-lines") return null;

  const primary =
    primaryAction.kind === "open-issue-dialog" ? (
      <button
        type="button"
        onClick={onOpenIssue}
        disabled={issueDisabled}
        style={{
          ...primaryActionStyle({ disabled: issueDisabled, height: 44 }),
          padding: "12px 14px",
          fontSize: 14,
          fontWeight: 600,
          minHeight: 44,
          flex: "1 1 220px",
        }}
      >
        {t("billing.detail.issueInvoice")}
      </button>
    ) : primaryAction.kind === "convert-quote" ? (
      <button
        type="button"
        onClick={onConvert}
        disabled={convertDisabled || convertBusy}
        aria-busy={convertBusy}
        style={{
          ...primaryActionStyle({ disabled: convertDisabled || convertBusy, height: 44 }),
          padding: "12px 14px",
          fontSize: 14,
          fontWeight: 600,
          minHeight: 44,
          flex: "1 1 220px",
        }}
      >
        {convertBusy ? t("billing.detail.creatingInvoice") : t("billing.detail.convertToInvoice")}
      </button>
    ) : primaryAction.kind === "scroll" ? (
      <button
        type="button"
        onClick={() => scrollToId(primaryAction.targetId)}
        style={{
          ...primaryActionStyle({ height: 44 }),
          padding: "12px 14px",
          fontSize: 14,
          fontWeight: 600,
          minHeight: 44,
          flex: "1 1 220px",
        }}
      >
        {primaryAction.label}
      </button>
    ) : null;

  const secondary =
    firstMissingTarget !== null ? (
      <button
        type="button"
        onClick={() => scrollToId(firstMissingTarget)}
        style={{
          ...glassActionStyle({ height: 44 }),
          padding: "12px 14px",
          fontSize: 13,
          fontWeight: 600,
          minHeight: 44,
          flex: "1 1 180px",
        }}
      >
        {t("billing.detail.continueNext")}
      </button>
    ) : null;

  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        zIndex: 50,
        marginTop: 4,
      }}
    >
      <div
        style={{
          borderRadius: 16,
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          background: TOKEN.surface.card,
          backdropFilter: "blur(8px)",
          boxShadow: TOKEN.shadow.floating,
          padding: 10,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
        }}
        role="region"
        aria-label={t("billing.detail.quickActionAria")}
      >
        {primary}
        {secondary}
      </div>
    </div>
  );
}

function DraftIssuePrimarySection({
  issueDisabled,
  issueLoading,
  onOpenIssue,
  submitDisabled,
  submitLoading,
  onSubmitForReview,
  customerDirty,
}: {
  issueDisabled: boolean;
  issueLoading: boolean;
  onOpenIssue: () => void;
  submitDisabled: boolean;
  submitLoading: boolean;
  onSubmitForReview: () => void;
  customerDirty: boolean;
}) {
  const { t } = useI18n();
  const busy = issueLoading || submitLoading;
  return (
    <section
      id="billing-issue-primary"
      style={{
        background: TOKEN.surface.card,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: TOKEN.ink.primary }}>
        {t("billing.detail.approveAndIssue")}
      </div>
      <p style={{ fontSize: 13, color: TOKEN.ink.muted, margin: 0, lineHeight: 1.55 }}>
        {t("billing.detail.approveHelp")}
      </p>
      {customerDirty ? (
        <div style={{ fontSize: 12, color: TOKEN.semantic.attention.ink, lineHeight: 1.5 }}>
          {t("billing.detail.customerSavingHint")}
        </div>
      ) : null}
      <button
        type="button"
        onClick={onOpenIssue}
        disabled={issueDisabled || issueLoading}
        aria-busy={issueLoading}
        style={{
          ...primaryActionStyle({ disabled: issueDisabled || issueLoading, fullWidth: true, height: 52 }),
          padding: "14px 16px",
          fontSize: 16,
          fontWeight: 600,
          width: "100%",
        }}
      >
        {issueLoading ? t("billing.detail.openingApproval") : t("billing.detail.issueInvoice")}
      </button>

      <details
        style={{
          borderRadius: 10,
          border: `1px dashed ${TOKEN.border.hover}`,
          padding: "10px 12px",
          background: TOKEN.surface.inset,
        }}
      >
        <summary
          style={{
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600,
            color: TOKEN.ink.secondary,
          }}
        >
          {t("billing.detail.internalReviewQuestion")}
        </summary>
        <p style={{ fontSize: 12, color: TOKEN.ink.muted, margin: "10px 0 8px" }}>
          {t("billing.detail.internalReviewHelp")}
        </p>
        <button
          type="button"
          onClick={onSubmitForReview}
          disabled={submitDisabled || busy}
          aria-busy={submitLoading}
          style={{
            ...glassActionStyle({ disabled: submitDisabled || busy, fullWidth: true, height: 44 }),
            padding: "10px 14px",
            fontSize: 14,
            fontWeight: 600,
            width: "100%",
          }}
        >
          {submitLoading ? t("billing.detail.moving") : t("billing.detail.sendForReview")}
        </button>
      </details>
    </section>
  );
}

function PendingReviewLifecycleSection({
  doc,
  lifecycleBusy,
  onRevert,
  onOpenIssueDialog,
}: {
  doc: BillingDocumentDetail;
  lifecycleBusy: LifecycleAction | null;
  onRevert: () => void;
  onOpenIssueDialog: () => void;
}) {
  const { t } = useI18n();
  const busy = lifecycleBusy !== null;
  const issueDisabled =
    doc.lines.length === 0 || busy || lifecycleBusy === "revert";
  const revertDisabled = busy || lifecycleBusy === "issue";

  return (
    <section
      id="billing-pending-actions"
      style={{
        background: TOKEN.semantic.attention.bg,
        border: `1px solid ${TOKEN.semantic.attention.border}`,
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: TOKEN.semantic.attention.ink }}>
        {t("billing.status.PENDING_REVIEW")}
      </div>
      <p style={{ fontSize: 14, color: TOKEN.semantic.attention.ink, margin: 0, lineHeight: 1.5 }}>
          {t("billing.detail.pendingHelp")}
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={onOpenIssueDialog}
          disabled={issueDisabled}
          style={{
            padding: "12px 16px",
            borderRadius: 10,
            border: `1px solid ${TOKEN.brand.mid}`,
            background: issueDisabled ? TOKEN.ink.meta : TOKEN.action.primary.background,
            color: TOKEN.ink.inverse,
            fontSize: 15,
            fontWeight: 600,
            cursor: issueDisabled ? "not-allowed" : "pointer",
            width: "100%",
          }}
        >
          {t("billing.detail.issueInvoice")}
        </button>
        <button
          type="button"
          onClick={onRevert}
          disabled={revertDisabled}
          aria-busy={lifecycleBusy === "revert"}
          style={{
            padding: "12px 16px",
            borderRadius: 10,
            border: `1px solid ${TOKEN.border.hover}`,
            background: TOKEN.surface.card,
            color: TOKEN.ink.secondary,
            fontSize: 14,
            fontWeight: 600,
            cursor: revertDisabled ? "not-allowed" : "pointer",
            opacity: revertDisabled ? 0.65 : 1,
            width: "100%",
          }}
        >
          {lifecycleBusy === "revert" ? t("billing.detail.movingDots") : t("billing.detail.revertToDraft")}
        </button>
      </div>
      {doc.lines.length === 0 ? (
        <div style={{ fontSize: 12, color: TOKEN.semantic.attention.ink }}>
          {t("billing.detail.issueNeedsLine")}
        </div>
      ) : null}
    </section>
  );
}

function IssueConfirmDialog({
  issuing,
  errorMessage,
  missingTaxId = false,
  onCancel,
  onConfirm,
}: {
  issuing: boolean;
  errorMessage: string | null;
  missingTaxId?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="issue-confirm-title"
      onClick={() => {
        if (!issuing) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(35, 48, 43, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 420,
          background: TOKEN.surface.card,
          borderRadius: 16,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: TOKEN.shadow.floating,
        }}
      >
        <h2
          id="issue-confirm-title"
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: TOKEN.ink.primary,
            margin: 0,
          }}
        >
          {t("billing.detail.issueInvoice")}
        </h2>
        <p style={{ fontSize: 14, color: TOKEN.ink.secondary, margin: 0, lineHeight: 1.6 }}>
          {t("billing.detail.confirmHelp")}
        </p>
        {missingTaxId ? (
          <div
            role="alert"
            style={{
              background: TOKEN.semantic.attention.bg,
              border: `1px solid ${TOKEN.semantic.attention.border}`,
              borderRadius: 10,
              padding: "10px 12px",
              color: TOKEN.semantic.attention.ink,
              fontSize: 13,
              lineHeight: 1.55,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {t("billing.detail.taxIdMissingTitle")}
            </div>
            <div>
              {t("billing.detail.taxIdMissingBody")}
              <Link href="/business" style={{ fontWeight: 600, color: TOKEN.semantic.attention.ink }}>
                {" "}
                {t("billing.detail.taxIdMissingLink")}
              </Link>
              {t("billing.detail.taxIdMissingAfter")}
            </div>
          </div>
        ) : null}
        {errorMessage ? (
          <div
            role="alert"
            style={{
              background: TOKEN.semantic.urgent.bg,
              border: `1px solid ${TOKEN.semantic.urgent.border}`,
              color: TOKEN.semantic.urgent.ink,
              borderRadius: 10,
              padding: "8px 12px",
              fontSize: 13,
            }}
          >
            {errorMessage}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 4,
          }}
        >
          <button
            type="button"
            onClick={onConfirm}
            disabled={issuing}
            aria-busy={issuing}
            style={{
              padding: "12px 16px",
              borderRadius: 10,
              border: `1px solid ${TOKEN.brand.mid}`,
              background: TOKEN.action.primary.background,
              color: TOKEN.ink.inverse,
              fontSize: 15,
              fontWeight: 600,
              cursor: issuing ? "not-allowed" : "pointer",
              width: "100%",
            }}
          >
            {issuing ? t("billing.detail.issuing") : t("billing.detail.issueInvoice")}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={issuing}
            style={{
              padding: "10px 16px",
              borderRadius: 10,
              border: `1px solid ${TOKEN.border.hover}`,
              background: TOKEN.surface.card,
              color: TOKEN.ink.secondary,
              fontSize: 14,
              fontWeight: 600,
              cursor: issuing ? "not-allowed" : "pointer",
              width: "100%",
            }}
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

function UnsavedChangesDialog({
  saving,
  errorMessage,
  onSaveAndContinue,
  onLeaveWithoutSaving,
  onKeepEditing,
}: {
  saving: boolean;
  errorMessage: string | null;
  onSaveAndContinue: () => void;
  onLeaveWithoutSaving: () => void;
  onKeepEditing: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-changes-title"
      onClick={() => {
        if (!saving) onKeepEditing();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(35, 48, 43, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 220,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 430,
          background: TOKEN.surface.card,
          borderRadius: 16,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: TOKEN.shadow.floating,
        }}
      >
        <h2
          id="unsaved-changes-title"
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: TOKEN.ink.primary,
            margin: 0,
          }}
        >
          {t("billing.detail.unsavedTitle")}
        </h2>
        <p style={{ fontSize: 14, color: TOKEN.ink.secondary, margin: 0, lineHeight: 1.6 }}>
          {t("billing.detail.unsavedQuestion")}
        </p>
        {errorMessage ? (
          <div
            role="alert"
            style={{
              background: TOKEN.semantic.urgent.bg,
              border: `1px solid ${TOKEN.semantic.urgent.border}`,
              color: TOKEN.semantic.urgent.ink,
              borderRadius: 10,
              padding: "8px 12px",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            {errorMessage}
          </div>
        ) : null}
        <div style={{ display: "grid", gap: 8 }}>
          <button
            type="button"
            onClick={onSaveAndContinue}
            disabled={saving}
            aria-busy={saving}
            style={{
              padding: "12px 16px",
              borderRadius: 10,
              border: `1px solid ${TOKEN.brand.mid}`,
              background: saving ? TOKEN.ink.meta : TOKEN.action.primary.background,
              color: TOKEN.ink.inverse,
              fontSize: 15,
              fontWeight: 600,
              cursor: saving ? "not-allowed" : "pointer",
              width: "100%",
            }}
          >
            {saving ? t("common.saving") : t("billing.list.gateSave")}
          </button>
          <button
            type="button"
            onClick={onLeaveWithoutSaving}
            disabled={saving}
            style={{
              padding: "10px 16px",
              borderRadius: 10,
              border: `1px solid ${TOKEN.border.hover}`,
              background: TOKEN.surface.card,
              color: TOKEN.ink.secondary,
              fontSize: 14,
              fontWeight: 600,
              cursor: saving ? "not-allowed" : "pointer",
              width: "100%",
            }}
          >
            {t("billing.detail.leaveWithoutSaving")}
          </button>
          <button
            type="button"
            onClick={onKeepEditing}
            disabled={saving}
            style={{
              padding: "10px 16px",
              borderRadius: 10,
              border: `1px solid ${TOKEN.border.DEFAULT}`,
              background: TOKEN.surface.inset,
              color: TOKEN.ink.secondary,
              fontSize: 14,
              fontWeight: 600,
              cursor: saving ? "not-allowed" : "pointer",
              width: "100%",
            }}
          >
            {t("billing.detail.keepEditing")}
          </button>
        </div>
      </div>
    </div>
  );
}

function DraftEditorSection({
  doc,
  authToken,
  customerInput,
  onCustomerChange,
  patchStatus,
  patchError,
  onCustomerPickSuccess,
  disabled = false,
  showValidUntil = false,
  validUntilInput,
  onValidUntilChange,
  validUntilStatus,
  validUntilError,
  visualTone = "default",
}: {
  doc: BillingDocumentDetail;
  authToken: string;
  customerInput: string;
  onCustomerChange: (value: string) => void;
  patchStatus: PatchSaveStatus;
  patchError: string | null;
  onCustomerPickSuccess: () => void;
  disabled?: boolean;
  showValidUntil?: boolean;
  validUntilInput?: string;
  onValidUntilChange?: (value: string) => void;
  validUntilStatus?: PatchSaveStatus;
  validUntilError?: string | null;
  visualTone?: "default" | "secondary";
}) {
  const { t } = useI18n();
  let saveHint = "";
  if (patchStatus === "saving" || validUntilStatus === "saving") {
    saveHint = t("common.saving");
  } else if (patchStatus === "saved" || validUntilStatus === "saved") {
    saveHint = t("common.saved");
  }

  const isSecondary = visualTone === "secondary";

  return (
    <section
      id="billing-customer"
      style={{
        background: isSecondary ? TOKEN.surface.card : TOKEN.surface.card,
        border: isSecondary
          ? `1px solid ${TOKEN.border.DEFAULT}`
          : `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        opacity: isSecondary ? 0.82 : 1,
      }}
    >
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: TOKEN.ink.primary,
        }}
      >
        {isSecondary ? t("billing.detail.customerSavedTitle") : t("billing.customerPicker.label")}
      </div>
      <div style={{ fontSize: 13, color: TOKEN.ink.secondary, lineHeight: 1.5 }}>
        {t("billing.detail.customerHelp")}
        {showValidUntil ? (
          <>
            {" "}
            {t("billing.detail.validUntilHelp")}
          </>
        ) : null}
      </div>
      <CustomerPicker
        authToken={authToken}
        billingDocumentId={doc.id}
        linkedCustomerId={doc.customerId}
        displayName={customerInput}
        onDisplayNameChange={onCustomerChange}
        onPickSuccess={onCustomerPickSuccess}
        disabled={disabled}
      />
      {showValidUntil ? (
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span id="billing-valid-until" />
          <span style={{ fontSize: 12, fontWeight: 600, color: TOKEN.ink.muted }}>
            {t("billing.detail.validUntilLabel")}
          </span>
          <input
            type="date"
            value={validUntilInput ?? ""}
            onChange={(e) => onValidUntilChange?.(e.target.value)}
            disabled={disabled}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${TOKEN.border.hover}`,
              fontSize: 14,
              maxWidth: 220,
              boxSizing: "border-box",
            }}
          />
        </label>
      ) : null}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          minHeight: 22,
        }}
      >
        {saveHint ? (
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color:
                patchStatus === "saved" || validUntilStatus === "saved"
                  ? TOKEN.semantic.success.ink
                  : TOKEN.ink.muted,
            }}
          >
            {saveHint}
          </span>
        ) : null}
        <span style={{ fontSize: 12, color: TOKEN.ink.meta }}>
          {t("billing.doc.amountsIn", { currency: doc.currency })}
        </span>
      </div>
      {patchError ? (
        <div
          role="alert"
          style={{
            background: TOKEN.semantic.urgent.bg,
            border: `1px solid ${TOKEN.semantic.urgent.border}`,
            color: TOKEN.semantic.urgent.ink,
            borderRadius: 10,
            padding: "8px 12px",
            fontSize: 13,
          }}
        >
          {patchError}
        </div>
      ) : null}
      {validUntilError ? (
        <div
          role="alert"
          style={{
            background: TOKEN.semantic.urgent.bg,
            border: `1px solid ${TOKEN.semantic.urgent.border}`,
            color: TOKEN.semantic.urgent.ink,
            borderRadius: 10,
            padding: "8px 12px",
            fontSize: 13,
          }}
        >
          {validUntilError}
        </div>
      ) : null}
    </section>
  );
}

function DraftLinesSection({
  currency,
  linesDraft,
  docLines,
  onUpdateLine,
  onRemoveLine,
  onAddLine,
  onSaveLines,
  linesSaving,
  linesError,
  linesSaveAllowed,
  customerDirty,
  patchSaving,
  draftLocked = false,
  visualTone = "default",
}: {
  currency: string;
  linesDraft: LocalLine[];
  docLines: BillingDocumentLine[];
  onUpdateLine: (
    key: string,
    patch: Partial<
      Pick<LocalLine, "description" | "quantity" | "unitPrice" | "vatRatePercent">
    >
  ) => void;
  onRemoveLine: (key: string) => void;
  onAddLine: () => void;
  onSaveLines: () => void;
  linesSaving: boolean;
  linesError: string | null;
  linesSaveAllowed: boolean;
  customerDirty: boolean;
  patchSaving: boolean;
  draftLocked?: boolean;
  visualTone?: "default" | "secondary";
}) {
  const { t } = useI18n();
  const isSecondary = visualTone === "secondary";
  return (
    <section
      id="billing-lines"
      style={{
        background: TOKEN.surface.card,
        border: isSecondary ? `1px solid ${TOKEN.border.DEFAULT}` : `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        opacity: isSecondary ? 0.82 : 1,
      }}
    >
      <h2
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: isSecondary ? TOKEN.ink.secondary : TOKEN.ink.primary,
          margin: 0,
          letterSpacing: "0.02em",
        }}
      >
        {t(isSecondary ? "billing.detail.linesSavedTitle" : "billing.detail.linesTitle", { count: linesDraft.length })}
      </h2>

      {draftLocked ? (
        <div
          style={{
            fontSize: 13,
            color: TOKEN.semantic.info.ink,
            background: TOKEN.semantic.info.bg,
            border: `1px solid ${TOKEN.semantic.info.border}`,
            borderRadius: 10,
            padding: "10px 12px",
            lineHeight: 1.5,
          }}
        >
          {t("billing.detail.linesLocked")}
        </div>
      ) : null}

      {linesDraft.length === 0 ? (
        <div
          style={{
            border: `1px dashed ${TOKEN.border.hover}`,
            borderRadius: 10,
            padding: 16,
            textAlign: "center",
            color: TOKEN.ink.muted,
            fontSize: 14,
          }}
        >
          {t("billing.detail.noLinesYet")}
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gap: 10,
          }}
        >
          {linesDraft.map((line, idx) => (
            <DraftLineEditorCard
              key={line.key}
              indexLabel={idx + 1}
              line={line}
              currency={currency}
              serverLine={resolveServerLineForDraft(line, docLines)}
              onChange={(patch) => onUpdateLine(line.key, patch)}
              onRemove={() => onRemoveLine(line.key)}
              readOnly={draftLocked}
            />
          ))}
        </ul>
      )}

      <div
        id="billing-lines-sticky-controls"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          position: "sticky",
          bottom: 0,
          background: TOKEN.surface.card,
          paddingTop: 8,
          borderTop: `1px solid ${TOKEN.border.DEFAULT}`,
        }}
      >
        <button
          type="button"
          onClick={onAddLine}
          disabled={linesSaving || draftLocked}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: `1px solid ${TOKEN.border.hover}`,
            background: TOKEN.surface.card,
            color: TOKEN.ink.secondary,
            fontSize: 14,
            fontWeight: 600,
            cursor: linesSaving || draftLocked ? "not-allowed" : "pointer",
            opacity: linesSaving || draftLocked ? 0.55 : 1,
            flex: "1 1 140px",
          }}
        >
          {t("billing.detail.addLine")}
        </button>
        <button
          type="button"
          onClick={onSaveLines}
          disabled={!linesSaveAllowed || draftLocked}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: `1px solid ${TOKEN.brand.mid}`,
            background:
              linesSaveAllowed && !draftLocked ? TOKEN.action.primary.background : TOKEN.ink.meta,
            color: TOKEN.ink.inverse,
            fontSize: 14,
            fontWeight: 600,
            cursor:
              linesSaveAllowed && !draftLocked ? "pointer" : "not-allowed",
            flex: "1 1 160px",
          }}
        >
          {linesSaving ? t("billing.detail.savingLines") : t("billing.detail.saveLines")}
        </button>
      </div>

      {customerDirty || patchSaving ? (
        <div style={{ fontSize: 12, color: TOKEN.semantic.attention.ink, lineHeight: 1.5 }}>
          {t("billing.detail.savingCustomerFirst")}
        </div>
      ) : null}

      {linesError ? (
        <div
          role="alert"
          style={{
            background: TOKEN.semantic.urgent.bg,
            border: `1px solid ${TOKEN.semantic.urgent.border}`,
            color: TOKEN.semantic.urgent.ink,
            borderRadius: 10,
            padding: "8px 12px",
            fontSize: 13,
          }}
        >
          {linesError}
        </div>
      ) : null}
    </section>
  );
}

function DraftLineEditorCard({
  indexLabel,
  line,
  currency,
  serverLine,
  onChange,
  onRemove,
  readOnly = false,
}: {
  indexLabel: number;
  line: LocalLine;
  currency: string;
  serverLine: BillingDocumentLine | undefined;
  onChange: (
    patch: Partial<
      Pick<LocalLine, "description" | "quantity" | "unitPrice" | "vatRatePercent">
    >
  ) => void;
  onRemove: () => void;
  readOnly?: boolean;
}) {
  const { t, locale } = useI18n();
  return (
    <li
      style={{
        background: TOKEN.surface.inset,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: 10,
        padding: 12,
        display: "grid",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: TOKEN.ink.secondary,
            background: TOKEN.border.DEFAULT,
            borderRadius: 6,
            padding: "2px 8px",
          }}
        >
          #{indexLabel}
        </span>
        <button
          type="button"
          onClick={onRemove}
          disabled={readOnly}
          style={{
            border: `1px solid ${TOKEN.semantic.urgent.border}`,
            background: TOKEN.semantic.urgent.bg,
            color: TOKEN.semantic.urgent.ink,
            borderRadius: 8,
            padding: "4px 10px",
            fontSize: 12,
            fontWeight: 600,
            cursor: readOnly ? "not-allowed" : "pointer",
            opacity: readOnly ? 0.45 : 1,
          }}
        >
          {t("billing.detail.removeLine")}
        </button>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: TOKEN.ink.muted }}>
          {t("billing.detail.description")}
        </span>
        <input
          type="text"
          value={line.description}
          onChange={(e) => onChange({ description: e.target.value })}
          dir="auto"
          placeholder={t("billing.detail.descriptionPlaceholder")}
          readOnly={readOnly}
          disabled={readOnly}
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            border: `1px solid ${TOKEN.border.hover}`,
            fontSize: 14,
            width: "100%",
            boxSizing: "border-box",
            opacity: readOnly ? 0.75 : 1,
          }}
        />
      </label>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: TOKEN.ink.muted }}>
            {t("billing.detail.quantity")}
          </span>
          <input
            type="text"
            inputMode="decimal"
            dir="ltr"
            value={line.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
            readOnly={readOnly}
            disabled={readOnly}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${TOKEN.border.hover}`,
              fontSize: 14,
              width: "100%",
              boxSizing: "border-box",
              opacity: readOnly ? 0.75 : 1,
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: TOKEN.ink.muted }}>
            {t("billing.detail.unitPrice", { currency })}
          </span>
          <input
            type="text"
            inputMode="decimal"
            dir="ltr"
            value={line.unitPrice}
            onChange={(e) => onChange({ unitPrice: e.target.value })}
            readOnly={readOnly}
            disabled={readOnly}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${TOKEN.border.hover}`,
              fontSize: 14,
              width: "100%",
              boxSizing: "border-box",
              opacity: readOnly ? 0.75 : 1,
            }}
          />
        </label>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: TOKEN.ink.muted }}>
          {t("billing.detail.vatPercent")}
        </span>
        <input
          type="text"
          inputMode="decimal"
          dir="ltr"
          value={line.vatRatePercent}
          onChange={(e) => onChange({ vatRatePercent: e.target.value })}
          readOnly={readOnly}
          disabled={readOnly}
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            border: `1px solid ${TOKEN.border.hover}`,
            fontSize: 14,
            width: "100%",
            maxWidth: 160,
            boxSizing: "border-box",
            opacity: readOnly ? 0.75 : 1,
          }}
        />
      </label>

      {serverLine ? (
        <div
          style={{
            borderTop: `1px solid ${TOKEN.border.DEFAULT}`,
            paddingTop: 8,
            fontSize: 12,
            color: TOKEN.ink.muted,
            lineHeight: 1.6,
          }}
        >
          {t("billing.detail.savedLineTotal")}{" "}
          <span style={{ fontWeight: 600, color: TOKEN.ink.primary }}>
            {formatMoney(serverLine.lineTotal, currency, locale)}
          </span>
          {serverLine.description !== line.description.trim() ||
          String(serverLine.quantity).trim() !== line.quantity.trim() ||
          String(serverLine.unitPrice).trim() !== line.unitPrice.trim() ||
          String(serverLine.vatRatePercent).trim() !==
            line.vatRatePercent.trim() ? (
            <span>{t("billing.detail.updatesAfterSave")}</span>
          ) : null}
        </div>
      ) : (
        <div
          style={{
            borderTop: `1px solid ${TOKEN.border.DEFAULT}`,
            paddingTop: 8,
            fontSize: 12,
            color: TOKEN.ink.meta,
          }}
        >
          {t("billing.detail.newLineHint")}
        </div>
      )}
    </li>
  );
}

type PdfAction = "view" | "download" | "share";

function ShareOptionButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...glassActionStyle({ disabled, height: 44 }),
        padding: "10px 12px",
        fontSize: 14,
        fontWeight: 600,
        textAlign: "start",
      }}
    >
      {children}
    </button>
  );
}

function QuoteDraftHero({
  doc,
  locked,
  convertDisabled,
  convertBusy,
  onConvert,
}: {
  doc: BillingDocumentDetail;
  locked: boolean;
  convertDisabled: boolean;
  convertBusy: boolean;
  onConvert: () => void;
}) {
  const { t } = useI18n();
  const numberLabel = doc.documentNumberFormatted ?? String(doc.id);
  const pdfUrl = `/api/billing/documents/${doc.id}/pdf`;
  const downloadName = `quote-${doc.documentNumberFormatted ?? doc.id}.pdf`;

  const [loadingAction, setLoadingAction] = useState<PdfAction | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareNotice, setShareNotice] = useState<string | null>(null);

  async function fetchPdfBlob(): Promise<Blob> {
    const token = getAuthToken();
    const res = await fetch(pdfUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const err = new Error(`PDF request failed (${res.status})`) as Error & {
        status?: number;
        serverMessage?: string;
      };
      err.status = res.status;
      // Capture the server's reason (e.g. the allocation-not-yet-received
      // delivery block) so we can show it instead of a generic message.
      try {
        const data = await res.json();
        if (data && typeof data.error === "string" && data.error.trim()) {
          err.serverMessage = data.error.trim();
        }
      } catch {
      }
      throw err;
    }
    return await res.blob();
  }

  function describePdfError(err: unknown, action: PdfAction): string {
    const status =
      err && typeof err === "object" && "status" in err
        ? (err as { status?: number }).status
        : undefined;
    const serverMessage =
      err && typeof err === "object" && "serverMessage" in err
        ? (err as { serverMessage?: string }).serverMessage
        : undefined;
    if (status === 401) {
      return t("billing.detail.pdfReauth");
    }
    if (status === 403) {
      // A delivery block (allocation not yet received) carries a specific reason;
      // surface it. Only fall back to the generic authorization message otherwise.
      return serverMessage ?? t("billing.detail.pdfForbidden");
    }
    if (status === 500) {
      return t("billing.detail.pdfPrepareFailed");
    }
    return action === "view"
      ? t("billing.detail.pdfViewFailed")
      : action === "share"
      ? t("billing.detail.pdfShareFailed")
      : t("billing.detail.pdfDownloadFailed");
  }

  // Outbound message to the CUSTOMER — stays Hebrew (not interface copy; see i18n B-4).
  function handleWhatsAppQuote() {
    const body = `שלום,
מצורפת הצעת מחיר מספר ${numberLabel}.
ניתן לצרף את המסמך לאחר הורדה או שיתוף מהנייד.`;
    const url = `https://wa.me/?text=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setShareNotice(t("billing.detail.whatsappOpened"));
  }

  async function handleCopyLink() {
    try {
      const url = new URL(pdfUrl, window.location.origin).toString();
      await navigator.clipboard.writeText(url);
      setShareNotice(t("billing.detail.linkCopied"));
    } catch {
      setPdfError(t("billing.detail.copyLinkFailed"));
    }
  }

  async function handleShare() {
    if (loadingAction) return;
    setPdfError(null);
    setLoadingAction("share");
    try {
      const blob = await fetchPdfBlob();
      const safeName = `quote-${doc.documentNumberFormatted ?? doc.id}.pdf`;
      const file = new File([blob], safeName, { type: "application/pdf" });
      const shareData: ShareData = { files: [file] };
      if (navigator.share && navigator.canShare?.(shareData)) {
        await navigator.share(shareData);
        setShareNotice(t("billing.detail.readyToShare"));
      } else {
        setPdfError(t("billing.detail.fileShareUnsupported"));
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setPdfError(describePdfError(err, "share"));
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleView() {
    if (loadingAction) return;
    setPdfError(null);
    setLoadingAction("view");
    try {
      const blob = await fetchPdfBlob();
      openPdfBlobInNewTab(blob);
      setShareNotice(t("billing.detail.openedNewTab"));
    } catch (err) {
      setPdfError(describePdfError(err, "view"));
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleDownload() {
    if (loadingAction) return;
    setPdfError(null);
    setLoadingAction("download");
    let blobUrl: string | null = null;
    try {
      const blob = await fetchPdfBlob();
      blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = downloadName;
      a.style.display = "none";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setShareNotice(t("billing.detail.downloaded"));
    } catch (err) {
      setPdfError(describePdfError(err, "download"));
    } finally {
      setLoadingAction(null);
      if (blobUrl) {
        const urlToRevoke = blobUrl;
        window.setTimeout(() => URL.revokeObjectURL(urlToRevoke), 1_000);
      }
    }
  }

  const isBusy = loadingAction !== null || convertBusy;

  return (
    <section
      id="billing-quote-share"
      style={{
        background:
          `linear-gradient(135deg, ${TOKEN.semantic.info.bg} 0%, ${TOKEN.semantic.info.bg} 45%, ${TOKEN.surface.card} 100%)`,
        border: `1px solid ${TOKEN.semantic.info.border}`,
        borderRadius: 16,
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "grid", gap: 6 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: TOKEN.semantic.info.ink,
            letterSpacing: "0.04em",
          }}
        >
          {t("billing.detail.quoteBadge")}
        </span>
        <span
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: TOKEN.ink.primary,
            lineHeight: 1.15,
          }}
        >
          #{numberLabel}
        </span>
        <p style={{ margin: 0, fontSize: 13, color: TOKEN.ink.secondary, lineHeight: 1.55 }}>
          {locked
            ? t("billing.detail.quoteLockedHelp")
            : t("billing.detail.quoteShareHelp")}
        </p>
      </div>

      {pdfError ? (
        <div
          role="alert"
          style={{
            background: TOKEN.semantic.urgent.bg,
            border: `1px solid ${TOKEN.semantic.urgent.border}`,
            color: TOKEN.semantic.urgent.ink,
            borderRadius: 10,
            padding: "8px 12px",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {pdfError}
        </div>
      ) : null}

      {shareNotice ? (
        <div
          role="status"
          style={{
            background: TOKEN.semantic.success.bg,
            border: `1px solid ${TOKEN.semantic.success.border}`,
            color: TOKEN.semantic.success.ink,
            borderRadius: 10,
            padding: "8px 12px",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {shareNotice}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setShareOpen((v) => !v)}
        disabled={isBusy}
        style={{
          ...primaryActionStyle({ disabled: isBusy, fullWidth: true, height: 48 }),
          padding: "12px 16px",
          fontSize: 15,
          fontWeight: 600,
          width: "100%",
        }}
      >
        {loadingAction ? t("billing.detail.preparing") : t("billing.detail.share")}
      </button>

      {shareOpen ? (
        <div
          style={{
            border: `1px solid ${TOKEN.border.DEFAULT}`,
            background: TOKEN.surface.card,
            borderRadius: 12,
            padding: 10,
            display: "grid",
            gap: 8,
          }}
        >
          <ShareOptionButton onClick={() => void handleShare()} disabled={isBusy}>
            {t("billing.detail.shareMobile")}
          </ShareOptionButton>
          <ShareOptionButton onClick={handleWhatsAppQuote} disabled={isBusy}>
            WhatsApp
          </ShareOptionButton>
          <ShareOptionButton onClick={() => void handleView()} disabled={isBusy}>
            {t("billing.detail.viewDocument")}
          </ShareOptionButton>
          <ShareOptionButton onClick={() => void handleDownload()} disabled={isBusy}>
            {t("billing.detail.download")}
          </ShareOptionButton>
          <ShareOptionButton onClick={() => void handleCopyLink()} disabled={isBusy}>
            {t("billing.detail.copyLink")}
          </ShareOptionButton>
        </div>
      ) : null}

      {!locked ? (
        <button
          type="button"
          onClick={onConvert}
          disabled={convertDisabled || convertBusy}
          aria-busy={convertBusy}
          style={{
            ...glassActionStyle({ disabled: convertDisabled || convertBusy, fullWidth: true, height: 52 }),
            padding: "14px 16px",
            fontSize: 16,
            fontWeight: 600,
            width: "100%",
          }}
        >
          {convertBusy ? t("billing.detail.creatingInvoice") : t("billing.detail.convertWhenAgreed")}
        </button>
      ) : doc.convertedToInvoiceId !== null ? (
        <Link
          href={`/billing/${doc.convertedToInvoiceId}`}
          style={{
            display: "block",
            textAlign: "center",
            padding: "12px 16px",
            borderRadius: 12,
            border: `1px solid ${TOKEN.brand.mid}`,
            background: TOKEN.surface.card,
            color: TOKEN.brand.mid,
            fontSize: 15,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          {t("billing.detail.openCreatedInvoice")}
        </Link>
      ) : null}
    </section>
  );
}

function IssuedHero({ doc }: { doc: BillingDocumentDetail }) {
  const { t, locale } = useI18n();
  const issuedDate = formatDateTime(doc.issuedAt, locale);
  // numberLabel feeds both the screen and the outbound WhatsApp text below, which stays Hebrew.
  const numberLabel = doc.documentNumberFormatted ?? "ללא מספר";
  const screenNumberLabel = doc.documentNumberFormatted ?? t("billing.detail.noNumber");
  const pdfUrl = `/api/billing/documents/${doc.id}/pdf`;
  const downloadName = `invoice-${doc.documentNumberFormatted ?? doc.id}.pdf`;

  const [loadingAction, setLoadingAction] = useState<PdfAction | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareNotice, setShareNotice] = useState<string | null>(null);

  async function fetchPdfBlob(): Promise<Blob> {
    const token = getAuthToken();
    const res = await fetch(pdfUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const err = new Error(`PDF request failed (${res.status})`) as Error & {
        status?: number;
        serverMessage?: string;
      };
      err.status = res.status;
      // Capture the server's reason (e.g. the allocation-not-yet-received
      // delivery block) so we can show it instead of a generic message.
      try {
        const data = await res.json();
        if (data && typeof data.error === "string" && data.error.trim()) {
          err.serverMessage = data.error.trim();
        }
      } catch {
      }
      throw err;
    }
    return await res.blob();
  }

  function describePdfError(err: unknown, action: PdfAction): string {
    const status =
      err && typeof err === "object" && "status" in err
        ? (err as { status?: number }).status
        : undefined;
    const serverMessage =
      err && typeof err === "object" && "serverMessage" in err
        ? (err as { serverMessage?: string }).serverMessage
        : undefined;
    if (status === 401) {
      return t("billing.detail.pdfReauth");
    }
    if (status === 403) {
      // A delivery block (allocation not yet received) carries a specific reason;
      // surface it. Only fall back to the generic authorization message otherwise.
      return serverMessage ?? t("billing.detail.pdfForbidden");
    }
    if (status === 500) {
      return t("billing.detail.pdfIssuedPrepareFailed");
    }
    return action === "view"
      ? t("billing.detail.pdfViewFailed")
      : action === "share"
      ? t("billing.detail.pdfShareFailed")
      : t("billing.detail.pdfDownloadFailed");
  }

  // Outbound message to the CUSTOMER — stays Hebrew (not interface copy; see i18n B-4).
  function handleWhatsAppDraft() {
    const body = `שלום,
מצורפת חשבונית מס מספר ${numberLabel}.
נשמח לשלוח את המסמך — נא להשתמש בכפתור "הורד" או "שתף" באפליקציה.`;
    const url = `https://wa.me/?text=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setShareNotice(t("billing.detail.whatsappOpened"));
  }

  async function handleCopyLink() {
    try {
      const url = new URL(pdfUrl, window.location.origin).toString();
      await navigator.clipboard.writeText(url);
      setShareNotice(t("billing.detail.linkCopied"));
    } catch {
      setPdfError(t("billing.detail.copyLinkFailed"));
    }
  }

  async function handleShare() {
    if (loadingAction) return;
    setPdfError(null);
    setLoadingAction("share");
    try {
      const blob = await fetchPdfBlob();
      const safeName = `invoice-${doc.documentNumberFormatted ?? doc.id}.pdf`;
      const file = new File([blob], safeName, { type: "application/pdf" });
      const shareData: ShareData = { files: [file] };
      if (navigator.share && navigator.canShare?.(shareData)) {
        await navigator.share(shareData);
        setShareNotice(t("billing.detail.readyToShare"));
      } else {
        setPdfError(t("billing.detail.fileShareUnsupported"));
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      setPdfError(describePdfError(err, "share"));
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleView() {
    if (loadingAction) return;
    setPdfError(null);
    setLoadingAction("view");
    try {
      const blob = await fetchPdfBlob();
      openPdfBlobInNewTab(blob);
      setShareNotice(t("billing.detail.openedNewTab"));
    } catch (err) {
      setPdfError(describePdfError(err, "view"));
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleDownload() {
    if (loadingAction) return;
    setPdfError(null);
    setLoadingAction("download");
    let blobUrl: string | null = null;
    try {
      const blob = await fetchPdfBlob();
      blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = downloadName;
      a.style.display = "none";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setShareNotice(t("billing.detail.downloaded"));
    } catch (err) {
      setPdfError(describePdfError(err, "download"));
    } finally {
      setLoadingAction(null);
      if (blobUrl) {
        const urlToRevoke = blobUrl;
        window.setTimeout(() => URL.revokeObjectURL(urlToRevoke), 1_000);
      }
    }
  }

  const isBusy = loadingAction !== null;

  return (
    <section
      id="billing-issued-actions"
      style={{
        background:
          `linear-gradient(135deg, ${TOKEN.semantic.success.bg} 0%, ${TOKEN.semantic.success.bg} 50%, ${TOKEN.surface.card} 100%)`,
        border: `1px solid ${TOKEN.semantic.success.border}`,
        borderRadius: 16,
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "grid", gap: 4 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: TOKEN.semantic.success.ink,
            letterSpacing: "0.04em",
          }}
        >
          {t("billing.detail.issuedBadge")}
        </span>
        <span
          style={{
            fontSize: 28,
            fontWeight: 600,
            color: TOKEN.ink.primary,
            lineHeight: 1.1,
          }}
        >
          #{screenNumberLabel}
        </span>
        {issuedDate ? (
          <span style={{ fontSize: 14, color: TOKEN.ink.secondary }}>
            {t("billing.detail.issuedDate", { date: issuedDate })}
          </span>
        ) : null}
      </div>

      {pdfError ? (
        <div
          role="alert"
          style={{
            background: TOKEN.semantic.urgent.bg,
            border: `1px solid ${TOKEN.semantic.urgent.border}`,
            color: TOKEN.semantic.urgent.ink,
            borderRadius: 10,
            padding: "8px 12px",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {pdfError}
        </div>
      ) : null}

      {shareNotice ? (
        <div
          role="status"
          style={{
            background: TOKEN.semantic.success.bg,
            border: `1px solid ${TOKEN.semantic.success.border}`,
            color: TOKEN.semantic.success.ink,
            borderRadius: 10,
            padding: "8px 12px",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {shareNotice}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setShareOpen((v) => !v)}
      disabled={isBusy}
      style={{
        ...primaryActionStyle({ disabled: isBusy, fullWidth: true, height: 48 }),
        padding: "12px 16px",
        fontSize: 15,
        fontWeight: 600,
        width: "100%",
      }}
      >
        {loadingAction ? t("billing.detail.preparing") : t("billing.detail.share")}
      </button>

      {shareOpen ? (
        <div
          style={{
            border: `1px solid ${TOKEN.border.DEFAULT}`,
            background: TOKEN.surface.card,
            borderRadius: 12,
            padding: 10,
            display: "grid",
            gap: 8,
          }}
        >
          <ShareOptionButton onClick={() => void handleShare()} disabled={isBusy}>
            {t("billing.detail.shareMobile")}
          </ShareOptionButton>
          <ShareOptionButton onClick={handleWhatsAppDraft} disabled={isBusy}>
            WhatsApp
          </ShareOptionButton>
          <ShareOptionButton onClick={() => void handleView()} disabled={isBusy}>
            {t("billing.detail.viewDocument")}
          </ShareOptionButton>
          <ShareOptionButton onClick={() => void handleDownload()} disabled={isBusy}>
            {t("billing.detail.download")}
          </ShareOptionButton>
          <ShareOptionButton onClick={() => void handleCopyLink()} disabled={isBusy}>
            {t("billing.detail.copyLink")}
          </ShareOptionButton>
        </div>
      ) : null}
    </section>
  );
}

type PaymentRequestView = {
  id: number;
  status: PaymentRequestStatus;
  amount: string;
  currency: string;
  paymentUrl: string | null;
  createdAt: string;
};

const PAYMENT_STATUS_STYLE: Record<
  PaymentRequestStatus,
  { bg: string; border: string; fg: string }
> = {
  PENDING: { bg: TOKEN.semantic.attention.bg, border: TOKEN.semantic.attention.border, fg: TOKEN.semantic.attention.ink },
  PAID: { bg: TOKEN.semantic.success.bg, border: TOKEN.semantic.success.border, fg: TOKEN.semantic.success.ink },
  FAILED: { bg: TOKEN.semantic.urgent.bg, border: TOKEN.semantic.urgent.border, fg: TOKEN.semantic.urgent.ink },
  CANCELLED: { bg: TOKEN.surface.inset, border: TOKEN.border.DEFAULT, fg: TOKEN.ink.secondary },
  EXPIRED: { bg: TOKEN.surface.inset, border: TOKEN.border.DEFAULT, fg: TOKEN.ink.secondary },
};

function toPaymentRequestView(raw: unknown): PaymentRequestView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "number" || !isPaymentRequestStatus(r.status)) {
    return null;
  }
  return {
    id: r.id,
    status: r.status,
    amount: typeof r.amount === "string" ? r.amount : String(r.amount ?? ""),
    currency: typeof r.currency === "string" ? r.currency : "ILS",
    paymentUrl: typeof r.paymentUrl === "string" ? r.paymentUrl : null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
  };
}

/**
 * Collections ("גבייה") for an ISSUED TAX_INVOICE — שולם / נותר / גבה.
 *
 * The figures come from the one shared economic rule (issued receipts'
 * allocations and issued credit notes), the same one the collection inbox and
 * payment settlement use. "גבה" enters the single collection flow at
 * /collection/new for this customer and invoice — this screen no longer
 * creates requests of its own.
 */
function CollectionsSection({ doc }: { doc: BillingDocumentDetail }) {
  const { t, locale } = useI18n();
  type InvoiceCollectionState = {
    customerId: number | null;
    currency: string;
    total: string;
    paid: string;
    credited: string;
    remaining: string;
    latestRequest: { id: number; status: PaymentRequestStatus; amount: string; createdAt: string } | null;
  };
  const [state, setState] = useState<InvoiceCollectionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = getAuthToken();
        const res = await fetch(`/api/collection/invoices/${doc.id}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as InvoiceCollectionState;
        if (!cancelled) setState(data);
      } catch {
        if (!cancelled) setError(t("billing.detail.collectionsLoadError"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc.id, t]);

  const row = (label: string, value: string, strong = false) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: strong ? TOKEN.ink.primary : TOKEN.ink.secondary, fontWeight: strong ? 700 : 400 }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );

  return (
    <section
      style={{
        background: TOKEN.surface.card,
        border: `1px solid ${TOKEN.border.DEFAULT}`,
        borderRadius: 14,
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: TOKEN.ink.primary, letterSpacing: "-0.01em" }}>{t("billing.detail.collectionsTitle")}</span>
      {error ? <span style={{ fontSize: 13, color: TOKEN.semantic.urgent.ink }}>{error}</span> : null}
      {!state && !error ? <span style={{ fontSize: 13, color: TOKEN.ink.secondary }}>{t("common.loading")}</span> : null}
      {state ? (
        <>
          <div style={{ display: "grid", gap: 6 }}>
            {row(t("billing.detail.paid"), formatMoney(state.paid, state.currency, locale))}
            {Number(state.credited) > 0 ? row(t("billing.detail.credited"), formatMoney(state.credited, state.currency, locale)) : null}
            {row(t("billing.detail.remaining"), formatMoney(state.remaining, state.currency, locale), true)}
          </div>
          {state.latestRequest ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: TOKEN.ink.secondary }}>
              <span>{t("billing.detail.latestRequest")}</span>
              <PaymentStatusBadge status={state.latestRequest.status} />
            </div>
          ) : null}
          {Number(state.remaining) > 0 ? (
            state.customerId ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Link
                  href={`/collection/new?customerId=${state.customerId}&invoiceId=${doc.id}`}
                  style={{ ...primaryActionStyle({ height: 44 }), textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                >
                  {t("billing.detail.collect", { amount: formatMoney(state.remaining, state.currency, locale) })}
                </Link>
                <Link href={`/collection/c/${state.customerId}`} style={{ fontSize: 13, color: TOKEN.ink.secondary, alignSelf: "center" }}>
                  {t("billing.detail.toCustomerFile")}
                </Link>
              </div>
            ) : (
              <span style={{ fontSize: 13, color: TOKEN.ink.secondary }}>{t("billing.detail.collectNeedsCustomer")}</span>
            )
          ) : (
            <span style={{ fontSize: 13, color: TOKEN.ink.secondary }}>{t("billing.detail.invoiceClosed")}</span>
          )}
        </>
      ) : null}
    </section>
  );
}

function PaymentStatusBadge({ status }: { status: PaymentRequestStatus }) {
  const { t } = useI18n();
  const style = PAYMENT_STATUS_STYLE[status];
  return (
    <span
      style={{
        padding: "4px 12px",
        borderRadius: 999,
        border: `1px solid ${style.border}`,
        background: style.bg,
        color: style.fg,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {t(`billing.paymentRequestStatus.${status}`)}
    </span>
  );
}






