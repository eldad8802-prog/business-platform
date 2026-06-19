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
import { CustomerPicker } from "@/components/billing/CustomerPicker";
import { IssuerSummaryBadge } from "@/components/billing/IssuerSummaryBadge";

type BillingStatus = "DRAFT" | "PENDING_REVIEW" | "ISSUED";

type BillingDocumentLine = {
  id: number;
  lineIndex: number;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRatePercent: string;
  lineSubtotal: string;
  vatAmount: string;
  lineTotal: string;
};

type BillingDocumentDetail = {
  id: number;
  documentType: string;
  status: BillingStatus;
  documentNumber: number | null;
  documentNumberFormatted: string | null;
  customerId: number | null;
  customerNameSnapshot: string | null;
  validUntil: string | null;
  convertedToInvoiceId: number | null;
  subtotalAmount: string;
  vatAmount: string;
  totalAmount: string;
  currency: string;
  issuedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: BillingDocumentLine[];
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "not-found" }
  | { kind: "ready"; doc: BillingDocumentDetail };

type LocalLine = {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRatePercent: string;
};

type PatchSaveStatus = "idle" | "saving" | "saved" | "error";

type LifecycleAction = "submit" | "revert" | "issue";

type PendingNavigation = { href: string } | null;

type StageKey =
  | "draft_missing"
  | "draft_ready"
  | "quote_ready"
  | "quote_converted"
  | "pending_review"
  | "issued";

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Opens a fetched PDF in a new tab without async window.open popup blocking. */
function openPdfBlobInNewTab(blob: Blob): void {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

type StickyPrimaryAction =
  | { kind: "none" }
  | { kind: "open-issue-dialog" }
  | { kind: "convert-quote" }
  | { kind: "scroll"; targetId: string; label: string };

function mapServerLinesToLocal(lines: BillingDocumentLine[]): LocalLine[] {
  return lines.map((l) => ({
    key: `s-${l.id}`,
    description: l.description,
    quantity: String(l.quantity),
    unitPrice: String(l.unitPrice),
    vatRatePercent: String(l.vatRatePercent),
  }));
}

function generateLocalLineKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `n-${crypto.randomUUID()}`;
  }
  return `n-local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newEmptyLocalLine(): LocalLine {
  return {
    key: generateLocalLineKey(),
    description: "",
    quantity: "1",
    unitPrice: "0",
    vatRatePercent: "17",
  };
}

function normalizeNumericForCompare(value: string): string {
  const t = value.trim();
  if (t === "") return "";
  const parsed = Number(t);
  if (!Number.isFinite(parsed)) return t;
  // Normalize numerically equivalent inputs (e.g. "1" === "1.00", "17" === "17.0")
  return String(parsed);
}

function linesAreDirty(
  draft: LocalLine[],
  serverLines: BillingDocumentLine[]
): boolean {
  const a = draft.map((l) => ({
    description: l.description.trim(),
    quantity: normalizeNumericForCompare(l.quantity),
    unitPrice: normalizeNumericForCompare(l.unitPrice),
    vatRatePercent: normalizeNumericForCompare(l.vatRatePercent),
  }));
  const b = serverLines.map((l) => ({
    description: l.description.trim(),
    quantity: normalizeNumericForCompare(String(l.quantity)),
    unitPrice: normalizeNumericForCompare(String(l.unitPrice)),
    vatRatePercent: normalizeNumericForCompare(String(l.vatRatePercent)),
  }));
  return JSON.stringify(a) !== JSON.stringify(b);
}

function looksLikeDecimalInput(value: string): boolean {
  const t = value.trim();
  if (t === "") return false;
  return /^-?\d+(\.\d+)?$/.test(t);
}

const STATUS_LABEL: Record<BillingStatus, string> = {
  DRAFT: "טיוטה",
  PENDING_REVIEW: "ממתין לאישור",
  ISSUED: "הופק",
};

const STATUS_STYLE: Record<
  BillingStatus,
  { bg: string; fg: string; border: string }
> = {
  DRAFT: { bg: "#f1f5f9", fg: "#334155", border: "#e2e8f0" },
  PENDING_REVIEW: { bg: "#fef3c7", fg: "#92400e", border: "#fde68a" },
  ISSUED: { bg: "#dcfce7", fg: "#166534", border: "#bbf7d0" },
};

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  TAX_INVOICE: "חשבונית מס",
  QUOTE: "הצעת מחיר",
};

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: currency || "ILS",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return iso;
  }
}

function formatQuantity(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat("he-IL", {
    maximumFractionDigits: 4,
  }).format(n);
}

function formatPercent(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value}%`;
  const formatted = new Intl.NumberFormat("he-IL", {
    maximumFractionDigits: 2,
  }).format(n);
  return `${formatted}%`;
}

function getDocumentTypeLabel(type: string): string {
  return DOCUMENT_TYPE_LABEL[type] ?? type;
}

function resolveServerLineForDraft(
  line: LocalLine,
  docLines: BillingDocumentLine[]
): BillingDocumentLine | undefined {
  if (line.key.startsWith("s-")) {
    const lid = Number(line.key.slice(2));
    if (!Number.isFinite(lid)) return undefined;
    return docLines.find((l) => l.id === lid);
  }
  return undefined;
}

export default function BillingDocumentWorkspacePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id || "";
  const router = useRouter();

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
      setState({ kind: "error", message: "מזהה מסמך חסר" });
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
        let message = "אירעה שגיאה בטעינת המסמך";
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
        setState({ kind: "error", message: "התקבלה תגובה לא תקינה" });
        return;
      }

      setState({ kind: "ready", doc });
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "אירעה שגיאה בטעינת המסמך",
      });
    }
  }, [id]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const message = window.sessionStorage.getItem("billing:completion");
    if (!message) return;
    window.sessionStorage.removeItem("billing:completion");
    const t = window.setTimeout(() => setCompletionNotice(message), 0);
    return () => window.clearTimeout(t);
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
    const t = window.setTimeout(async () => {
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
          setDraftConflictMessage(
            "המסמך עודכן או הופק ממקום אחר"
          );
          setPatchStatus("idle");
          return;
        }

        if (!res.ok) {
          let message = "שגיאה בשמירת שם הלקוח";
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
          setPatchError("התקבלה תגובה לא תקינה");
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
        setPatchError("לא הצלחנו להתחבר כדי לשמור את שם הלקוח. נסו שוב בעוד רגע.");
        setPatchStatus("error");
      }
    }, 800);

    return () => {
      window.clearTimeout(t);
    };
  }, [customerInput, id, load, state]);

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
    const t = window.setTimeout(async () => {
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
          setDraftConflictMessage(
            "המסמך עודכן או הופק ממקום אחר"
          );
          setValidUntilStatus("idle");
          return;
        }

        if (!res.ok) {
          let message = "שגיאה בשמירת תוקף ההצעה";
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
          setValidUntilError("התקבלה תגובה לא תקינה");
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
        setValidUntilError("לא הצלחנו להתחבר כדי לשמור את תוקף ההצעה. נסו שוב בעוד רגע.");
        setValidUntilStatus("error");
      }
    }, 800);

    return () => {
      window.clearTimeout(t);
    };
  }, [validUntilInput, id, load, state]);

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
        setDraftConflictMessage(
          "המסמך עודכן או הופק ממקום אחר"
        );
        return false;
      }

      if (!res.ok) {
        let message = "שגיאה בשמירת הפריטים";
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
        setLinesError("התקבלה תגובה לא תקינה");
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
        setLifecycleSuccess("המסמך עודכן.");
      }
      return true;
    } catch {
      setLinesError("לא הצלחנו לשמור את הפריטים. נסו שוב בעוד רגע.");
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
        setDraftConflictMessage(
          "המסמך עודכן או הופק ממקום אחר"
        );
        return;
      }

      if (!res.ok) {
        let message = "לא ניתן להמיר כעת";
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
        setConvertError("התקבלה תגובה לא תקינה");
        return;
      }

      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(
          "billing:completion",
          "החשבונית נוצרה מההצעה. אפשר לבדוק ולהפיק אותה כשמוכנים."
        );
      }
      router.push(`/billing/${invId}`);
    } catch {
      setConvertError("לא הצלחנו להתחבר כדי להמיר את ההצעה. נסו שוב בעוד רגע.");
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
          setDraftConflictMessage(
            "המסמך עודכן או הופק ממקום אחר"
          );
          if (action === "issue") setIssueConfirmOpen(false);
          return;
        }

        if (!res.ok) {
          const baseMessage =
            action === "submit"
              ? "לא הצלחנו לשלוח את המסמך לאישור."
              : action === "revert"
              ? "לא הצלחנו להחזיר את המסמך לטיוטה."
              : "לא הצלחנו להפיק את המסמך.";
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
          setLifecycleError("התקבלה תגובה לא תקינה");
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
          setLifecycleSuccess("המסמך נשלח לאישור.");
        } else if (action === "revert") {
          setLifecycleSuccess("המסמך הוחזר לטיוטה.");
        } else if (action === "issue") {
          setLifecycleSuccess("המסמך הופק בהצלחה.");
          setIssueConfirmOpen(false);
        }
      } catch {
        setLifecycleError("לא הצלחנו להתחבר. נסו שוב בעוד רגע.");
      } finally {
        setLifecycleBusy(null);
      }
    },
    [id, load]
  );

  useEffect(() => {
    if (!lifecycleSuccess) return;
    const t = window.setTimeout(() => setLifecycleSuccess(null), 4000);
    return () => window.clearTimeout(t);
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
          ? "הצעת מחיר"
          : "טיוטה ללא מספר")
      : "מסמך ללקוח";

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
        setPatchError("כדי לשמור לפני יציאה צריך שם לקוח.");
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
        setPatchError("לא הצלחנו לשמור את פרטי המסמך. נסו שוב.");
        setPatchStatus("error");
        return false;
      }
      const data = await res.json();
      const nextDoc: BillingDocumentDetail | undefined = data?.document;
      if (!nextDoc || typeof nextDoc.id !== "number") {
        setPatchError("התקבלה תגובה לא תקינה");
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
      setPatchError("לא הצלחנו להתחבר כדי לשמור. נסו שוב בעוד רגע.");
      setPatchStatus("error");
      return false;
    }
  }

  function requestNavigation(href: string) {
    if (hasUnsavedDraftChanges) {
      setLeavingError(null);
      setPendingNavigation({ href });
      return;
    }
    router.push(href);
  }

  async function handleSaveAndContinueNavigation() {
    if (!pendingNavigation || leavingSaveBusy) return;
    setLeavingSaveBusy(true);
    setLeavingError(null);
    try {
      const fieldsSaved = await saveDraftFieldsNow();
      if (!fieldsSaved) {
        setLeavingError("לא הצלחנו לשמור את כל השינויים. אפשר להמשיך לערוך ולנסות שוב.");
        return;
      }
      const linesSaved = dirtyLines ? await handleSaveLines(false) : true;
      if (!linesSaved) {
        setLeavingError("לא הצלחנו לשמור את הפריטים. אפשר להמשיך לערוך ולנסות שוב.");
        return;
      }
      const href = pendingNavigation.href;
      setPendingNavigation(null);
      router.push(href);
    } finally {
      setLeavingSaveBusy(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100dvh",
        background: "#f8fafc",
        padding: "24px 16px 80px",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <header
          style={{
            direction: "rtl",
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 16,
          }}
        >
          <Link
            href="/billing"
            onClick={(event) => {
              event.preventDefault();
              requestNavigation("/billing");
            }}
            aria-label="חזרה"
            style={{
              minHeight: 40,
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 12,
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              textDecoration: "none",
              color: "#0f172a",
              padding: "0 12px",
              fontSize: 14,
              fontWeight: 800,
              whiteSpace: "nowrap",
            }}
          >
            חזרה
          </Link>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: "#0f172a",
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
              direction: "rtl",
              background: "#ecfdf5",
              border: "1px solid #bbf7d0",
              color: "#166534",
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
                color: "#166534",
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 18,
                lineHeight: 1,
                padding: 0,
              }}
              aria-label="סגור"
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
            const href = pendingNavigation.href;
            setPendingNavigation(null);
            router.push(href);
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

function StatusBadge({ status }: { status: BillingStatus }) {
  const style = STATUS_STYLE[status];
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
      {STATUS_LABEL[status]}
    </span>
  );
}

function WorkspaceSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      style={{ display: "grid", gap: 12 }}
    >
      {[120, 100, 220].map((h, i) => (
        <div
          key={i}
          aria-hidden="true"
          style={{
            height: h,
            borderRadius: 14,
            background:
              "linear-gradient(90deg, #f1f5f9 0%, #e2e8f0 50%, #f1f5f9 100%)",
            backgroundSize: "200% 100%",
            animation: "billing-skeleton 1.2s ease-in-out infinite",
            border: "1px solid #e2e8f0",
          }}
        />
      ))}
      <style>{`
        @keyframes billing-skeleton {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        background: "#fef2f2",
        border: "1px solid #fecaca",
        color: "#991b1b",
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 15 }}>שגיאה בטעינת המסמך</div>
      <div style={{ fontSize: 14, lineHeight: 1.5 }}>{message}</div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          alignSelf: "flex-start",
          padding: "8px 14px",
          borderRadius: 10,
          border: "1px solid #991b1b",
          background: "#991b1b",
          color: "#ffffff",
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        נסה שוב
      </button>
    </div>
  );
}

function NotFoundCard() {
  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px dashed #cbd5e1",
        borderRadius: 14,
        padding: "32px 16px",
        textAlign: "center",
        color: "#475569",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 700 }}>המסמך לא נמצא</div>
      <div style={{ fontSize: 14 }}>
        ייתכן שהקישור שגוי או שהמסמך הוסר.
      </div>
      <Link
        href="/billing"
        style={{
          padding: "8px 16px",
          borderRadius: 10,
          border: "1px solid #0f172a",
          background: "#0f172a",
          color: "#ffffff",
          fontSize: 14,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        חזרה לרשימת המסמכים
      </Link>
    </div>
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
      label: "חסר שם לקוח",
      actionId: "billing-customer",
    });
  }
  if (isDraft && !linesOk) {
    missing.push({
      key: "lines",
      label: "חסרה לפחות שורת פריט אחת",
      actionId: "billing-lines",
    });
  }
  if (isDraft && dirtyLines) {
    missing.push({
      key: "unsaved-lines",
      label: "יש שינויים בפריטים שלא נשמרו",
      actionId: "billing-lines",
    });
  }
  if (isDraft && customerDirty) {
    missing.push({
      key: "unsaved-customer",
      label: "שם הלקוח עוד לא נשמר",
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
      ? { kind: "scroll", targetId: "billing-quote-share", label: "פעולות הצעה" }
      : stage === "pending_review"
      ? {
          kind: "scroll",
          targetId: "billing-pending-actions",
          label: "פעולות אישור/הפקה",
        }
      : stage === "issued"
      ? { kind: "scroll", targetId: "billing-issued-actions", label: "שיתוף המסמך" }
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
    <CollapsiblePanel title="פרטים נוספים">
      <DetailsCard doc={doc} hideCustomer={isDraft} />
      {isDraft ? null : <LinesSection lines={doc.lines} currency={doc.currency} />}
      <TotalsCard doc={doc} showUnsavedLinesHint={dirtyLines && isDraft} />
      {doc.documentType === "TAX_INVOICE" ? <IssuerSummaryBadge /> : null}
    </CollapsiblePanel>
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <StageAwarePanel
        stage={stage}
        doc={doc}
        missing={missing}
        quoteValidUntilEmpty={quoteValidUntilEmpty}
      />

      <StickyActionBar
        stage={stage}
        missing={missing}
        quoteValidUntilEmpty={quoteValidUntilEmpty}
        primaryAction={stickyPrimaryAction}
        issueDisabled={submitForReviewDisabled}
        onOpenIssue={onOpenIssueDialog}
        convertDisabled={convertDisabled}
        convertBusy={convertBusy}
        onConvert={onConvertQuote}
      />

      {draftConflictMessage ? (
        <div
          role="alert"
          style={{
            background: "#fffbeb",
            border: "1px solid #fde68a",
            color: "#92400e",
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
              color: "#92400e",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 18,
              lineHeight: 1,
              padding: 0,
            }}
            aria-label="סגור"
          >
            ×
          </button>
        </div>
      ) : null}

      {lifecycleSuccess ? (
        <div
          role="status"
          style={{
            background: "#ecfdf5",
            border: "1px solid #bbf7d0",
            color: "#166534",
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
              color: "#166534",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 18,
              lineHeight: 1,
              padding: 0,
            }}
            aria-label="סגור"
          >
            ×
          </button>
        </div>
      ) : null}

      {lifecycleError && !issueDialogOpen ? (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
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
              color: "#991b1b",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: 18,
              lineHeight: 1,
              padding: 0,
            }}
            aria-label="סגור"
          >
            ×
          </button>
        </div>
      ) : null}

      {convertError ? (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
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
          <CustomerSummaryCard doc={doc} />
          {draftLinesSection}
          <TotalsCard doc={doc} showUnsavedLinesHint={dirtyLines && isDraft} />
          {detailsContext}
        </>
      ) : null}

      {readyInvoiceFocus ? (
        <>
          <ReviewSummaryCard doc={doc} />
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
          <CollapsiblePanel title="עריכה נוספת">
            {customerSection}
            {draftLinesSection}
            <TotalsCard doc={doc} showUnsavedLinesHint={dirtyLines && isDraft} />
          </CollapsiblePanel>
          {detailsContext}
        </>
      ) : null}

      {readyQuoteFocus ? (
        <>
          <ReviewSummaryCard doc={doc} />
          <QuoteDraftHero
            doc={doc}
            locked={quoteLocked}
            convertDisabled={convertDisabled}
            convertBusy={convertBusy}
            onConvert={onConvertQuote}
          />
          <CollapsiblePanel title="עריכה נוספת">
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
          <ReviewSummaryCard doc={doc} />
          {detailsContext}
        </>
      ) : null}

      {issuedFocus ? (
        <>
          <IssuedHero doc={doc} />
          <ReviewSummaryCard doc={doc} />
          {detailsContext}
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
        <ReviewSummaryCard doc={doc} />
        {detailsContext}
        </>
      ) : null}
    </div>
  );
}

function CollapsiblePanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 14,
        background: "#ffffff",
        padding: "10px 14px",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 800,
          color: "#475569",
        }}
      >
        {title}
      </summary>
      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>{children}</div>
    </details>
  );
}

function CustomerSummaryCard({ doc }: { doc: BillingDocumentDetail }) {
  return (
    <section
      style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: 14,
        padding: "10px 14px",
        color: "#334155",
        fontSize: 13,
      }}
      aria-label="לקוח במסמך"
    >
      <span style={{ color: "#64748b" }}>לקוח: </span>
      <span style={{ color: "#0f172a", fontWeight: 800 }}>
        {doc.customerNameSnapshot ?? "לא הוגדר"}
      </span>
    </section>
  );
}

function ReviewSummaryCard({ doc }: { doc: BillingDocumentDetail }) {
  const customer = doc.customerNameSnapshot ?? "לא הוגדר";
  const total = formatMoney(doc.totalAmount, doc.currency);
  const itemCount = doc.lines.length;
  const isQuote = doc.documentType === "QUOTE";

  return (
    <section
      style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: 14,
        padding: 16,
        display: "grid",
        gap: 10,
      }}
      aria-label="בדיקת המסמך"
    >
      <div style={{ fontSize: 15, fontWeight: 900, color: "#0f172a" }}>
        בדיקה קצרה
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <ReviewSummaryRow label="לקוח" value={customer} />
        <ReviewSummaryRow
          label="פריטים"
          value={itemCount === 1 ? "פריט אחד" : `${itemCount} פריטים`}
        />
        <ReviewSummaryRow label="סכום" value={total} emphasized />
      </div>
      <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
        {isQuote
          ? "זה מה שהלקוח יקבל בהצעה."
          : doc.status === "ISSUED"
          ? "זה המסמך הרשמי שמוכן לשיתוף."
          : "לאחר ההפקה המסמך יקבל מספר רשמי ויינעל לעריכה."}
      </div>
    </section>
  );
}

function ReviewSummaryRow({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        alignItems: "baseline",
      }}
    >
      <span style={{ fontSize: 13, color: "#64748b" }}>{label}</span>
      <span
        style={{
          fontSize: emphasized ? 16 : 14,
          color: "#0f172a",
          fontWeight: emphasized ? 900 : 700,
          textAlign: "left",
        }}
      >
        {value}
      </span>
    </div>
  );
}

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
  const isQuote = doc.documentType === "QUOTE";

  const title =
    stage === "issued"
      ? "המסמך הופק"
      : stage === "pending_review"
      ? "ממתין לאישור"
      : stage === "quote_converted"
      ? "הצעת המחיר הומרה לחשבונית"
      : stage === "quote_ready"
      ? "ההצעה מוכנה ללקוח"
      : stage === "draft_ready"
      ? "הטיוטה מוכנה להפקה"
      : "כדי לאשר את המסמך חסרים פרטים";

  const tone =
    stage === "draft_missing"
      ? { bg: "#fffbeb", border: "#fde68a", fg: "#92400e" }
      : stage === "issued"
      ? { bg: "#ecfdf5", border: "#bbf7d0", fg: "#166534" }
      : isQuote
      ? { bg: "#EEF3F9", border: "#C7D6E9", fg: "#3F619C" }
      : { bg: "#ffffff", border: "#e2e8f0", fg: "#0f172a" };

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
      aria-label="השלב הבא"
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 900, color: tone.fg }}>
            {title}
          </div>
          <div style={{ fontSize: 13, color: "#475569", marginTop: 4, lineHeight: 1.55 }}>
            {stage === "draft_ready"
              ? "הכל מוכן לבדיקה אחרונה. הפעולה הבאה היא הפקה רשמית ללקוח."
              : stage === "quote_ready"
              ? "שתפו את ההצעה עם הלקוח. כשיש הסכמה, אפשר להפוך אותה לחשבונית."
              : stage === "quote_converted"
              ? "ההמרה בוצעה. הפעולה הבאה היא לפתוח את החשבונית."
              : stage === "pending_review"
              ? "המסמך נבדק ומוכן להחלטה: הפקה רשמית או חזרה לעריכה."
              : stage === "issued"
              ? "המסמך הרשמי מוכן לשיתוף, הורדה או צפייה."
              : "השלימו את החסר ונוביל אתכם לפעולה הבאה."}
          </div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 900, color: "#64748b", whiteSpace: "nowrap" }}>
          {isQuote ? "הצעה" : "חשבונית"} · {STATUS_LABEL[doc.status] ?? doc.status}
        </div>
      </div>

      {missing.length > 0 || quoteValidUntilEmpty ? (
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: 12,
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 900, color: "#0f172a" }}>
            מה חסר כדי לאשר את המסמך
          </div>
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            {missing.map((m) => (
              <li key={m.key} style={{ fontSize: 13, marginBottom: 4, color: "#0f172a" }}>
                {m.actionId ? (
                  <button
                    type="button"
                    onClick={() => scrollToId(m.actionId!)}
                    style={{
                      border: "none",
                      background: "transparent",
                      padding: 0,
                      cursor: "pointer",
                      textDecoration: "underline",
                      color: "#0f172a",
                      fontWeight: 800,
                    }}
                  >
                    {m.label}
                  </button>
                ) : (
                  <span style={{ fontWeight: 800 }}>{m.label}</span>
                )}
              </li>
            ))}
            {quoteValidUntilEmpty ? (
              <li style={{ fontSize: 13, marginBottom: 0, color: "#0f172a" }}>
                <button
                  type="button"
                  onClick={() => scrollToId("billing-valid-until")}
                  style={{
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    cursor: "pointer",
                    textDecoration: "underline",
                    color: "#0f172a",
                    fontWeight: 800,
                  }}
                >
                  מומלץ למלא &quot;בתוקף עד&quot; להצעה
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
  primaryAction: StickyPrimaryAction;
  issueDisabled: boolean;
  onOpenIssue: () => void;
  convertDisabled: boolean;
  convertBusy: boolean;
  onConvert: () => void;
}) {
  const [linesStickyVisible, setLinesStickyVisible] = useState(false);

  useEffect(() => {
    const el = document.getElementById("billing-lines-sticky-controls");
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        setLinesStickyVisible(!!entry?.isIntersecting);
      },
      { root: null, threshold: 0.2 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const show =
    stage !== "draft_missing" ||
    missing.length > 0 ||
    quoteValidUntilEmpty;

  if (!show) return null;

  const firstMissingTarget =
    missing.find((m) => !!m.actionId)?.actionId ??
    (quoteValidUntilEmpty ? "billing-valid-until" : null);

  // Avoid double-sticky on mobile: Draft lines already has its own sticky controls.
  if (linesStickyVisible) return null;

  // Preferred conservative rule: if we're guiding the user to lines, don't add a competing sticky bar.
  if (firstMissingTarget === "billing-lines") return null;

  const primary =
    primaryAction.kind === "open-issue-dialog" ? (
      <button
        type="button"
        onClick={onOpenIssue}
        disabled={issueDisabled}
        style={{
          padding: "12px 14px",
          borderRadius: 12,
          border: "1px solid #0f172a",
          background: issueDisabled ? "#94a3b8" : "#0f172a",
          color: "#ffffff",
          fontSize: 14,
          fontWeight: 900,
          cursor: issueDisabled ? "not-allowed" : "pointer",
          minHeight: 44,
          flex: "1 1 220px",
        }}
      >
        הפק חשבונית
      </button>
    ) : primaryAction.kind === "convert-quote" ? (
      <button
        type="button"
        onClick={onConvert}
        disabled={convertDisabled || convertBusy}
        aria-busy={convertBusy}
        style={{
          padding: "12px 14px",
          borderRadius: 12,
          border: "1px solid #0f172a",
          background: convertDisabled || convertBusy ? "#94a3b8" : "#0f172a",
          color: "#ffffff",
          fontSize: 14,
          fontWeight: 900,
          cursor: convertDisabled || convertBusy ? "not-allowed" : "pointer",
          minHeight: 44,
          flex: "1 1 220px",
        }}
      >
        {convertBusy ? "יוצר חשבונית…" : "הפוך לחשבונית"}
      </button>
    ) : primaryAction.kind === "scroll" ? (
      <button
        type="button"
        onClick={() => scrollToId(primaryAction.targetId)}
        style={{
          padding: "12px 14px",
          borderRadius: 12,
          border: "1px solid #243B57",
          background: "linear-gradient(90deg, #243B57 0%, #9DB4D4 100%)",
          color: "#ffffff",
          fontSize: 14,
          fontWeight: 900,
          cursor: "pointer",
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
          padding: "12px 14px",
          borderRadius: 12,
          border: "1px solid #cbd5e1",
          background: "#ffffff",
          color: "#334155",
          fontSize: 13,
          fontWeight: 900,
          cursor: "pointer",
          minHeight: 44,
          flex: "1 1 180px",
        }}
      >
        המשך לשלב הבא
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
          border: "1px solid rgba(226,232,240,0.9)",
          background: "rgba(255,255,255,0.96)",
          backdropFilter: "blur(8px)",
          boxShadow: "0 -8px 24px rgba(15,23,42,0.08)",
          padding: 10,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
        }}
        role="region"
        aria-label="פעולה מהירה"
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
  const busy = issueLoading || submitLoading;
  return (
    <section
      id="billing-issue-primary"
      style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a" }}>
        אישור והפקה
      </div>
      <p style={{ fontSize: 13, color: "#64748b", margin: 0, lineHeight: 1.55 }}>
        בדקו שהלקוח, הפריטים והסכום נכונים. לאחר ההפקה יוקצה מספר רשמי והמסמך
        יינעל לעריכה.
      </p>
      {customerDirty ? (
        <div style={{ fontSize: 12, color: "#b45309", lineHeight: 1.5 }}>
          יש שינוי בשם הלקוח שעדיין נשמר — המתינו ל&quot;נשמר&quot; או בחרו לקוח
          מהרשימה.
        </div>
      ) : null}
      <button
        type="button"
        onClick={onOpenIssue}
        disabled={issueDisabled || issueLoading}
        aria-busy={issueLoading}
        style={{
          padding: "14px 16px",
          borderRadius: 12,
          border: "1px solid #0f172a",
          background: issueDisabled || issueLoading ? "#94a3b8" : "#0f172a",
          color: "#ffffff",
          fontSize: 16,
          fontWeight: 800,
          cursor: issueDisabled || issueLoading ? "not-allowed" : "pointer",
          width: "100%",
        }}
      >
        {issueLoading ? "פותח אישור…" : "הפק חשבונית"}
      </button>

      <details
        style={{
          borderRadius: 10,
          border: "1px dashed #cbd5e1",
          padding: "10px 12px",
          background: "#f8fafc",
        }}
      >
        <summary
          style={{
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600,
            color: "#475569",
          }}
        >
          צריך אישור פנימי לפני הפקה?
        </summary>
        <p style={{ fontSize: 12, color: "#64748b", margin: "10px 0 8px" }}>
          מתאים כשמישהו נוסף צריך לבדוק את המסמך לפני שהוא הופך לרשמי.
        </p>
        <button
          type="button"
          onClick={onSubmitForReview}
          disabled={submitDisabled || busy}
          aria-busy={submitLoading}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #94a3b8",
            background: "#ffffff",
            color: "#334155",
            fontSize: 14,
            fontWeight: 600,
            cursor: submitDisabled || busy ? "not-allowed" : "pointer",
            width: "100%",
          }}
        >
          {submitLoading ? "מעביר…" : "שלח לאישור"}
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
  const busy = lifecycleBusy !== null;
  const issueDisabled =
    doc.lines.length === 0 || busy || lifecycleBusy === "revert";
  const revertDisabled = busy || lifecycleBusy === "issue";

  return (
    <section
      id="billing-pending-actions"
      style={{
        background: "#fffbeb",
        border: "1px solid #fde68a",
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: "#92400e" }}>
        ממתין לאישור
      </div>
      <p style={{ fontSize: 14, color: "#78350f", margin: 0, lineHeight: 1.5 }}>
          אפשר להפוך את המסמך לרשמי, או להחזיר אותו לעריכה אם משהו עוד לא סגור.
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
            border: "1px solid #0f172a",
            background: issueDisabled ? "#94a3b8" : "#0f172a",
            color: "#ffffff",
            fontSize: 15,
            fontWeight: 700,
            cursor: issueDisabled ? "not-allowed" : "pointer",
            width: "100%",
          }}
        >
          הפק חשבונית
        </button>
        <button
          type="button"
          onClick={onRevert}
          disabled={revertDisabled}
          aria-busy={lifecycleBusy === "revert"}
          style={{
            padding: "12px 16px",
            borderRadius: 10,
            border: "1px solid #cbd5e1",
            background: "#ffffff",
            color: "#334155",
            fontSize: 14,
            fontWeight: 600,
            cursor: revertDisabled ? "not-allowed" : "pointer",
            opacity: revertDisabled ? 0.65 : 1,
            width: "100%",
          }}
        >
          {lifecycleBusy === "revert" ? "מעביר..." : "החזר לטיוטה"}
        </button>
      </div>
      {doc.lines.length === 0 ? (
        <div style={{ fontSize: 12, color: "#b45309" }}>
          לא ניתן להפיק מסמך לפני שמוסיפים ושומרים לפחות פריט אחד.
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
        background: "rgba(15, 23, 42, 0.5)",
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
          background: "#ffffff",
          borderRadius: 16,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: "0 12px 40px rgba(0,0,0,0.2)",
        }}
      >
        <h2
          id="issue-confirm-title"
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: "#0f172a",
            margin: 0,
          }}
        >
          הפק חשבונית
        </h2>
        <p style={{ fontSize: 14, color: "#475569", margin: 0, lineHeight: 1.6 }}>
          זה רגע האישור הסופי. למסמך יוקצה מספר רשמי ולא ניתן יהיה לערוך אותו
          לאחר ההפקה.
        </p>
        {missingTaxId ? (
          <div
            role="alert"
            style={{
              background: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 10,
              padding: "10px 12px",
              color: "#92400e",
              fontSize: 13,
              lineHeight: 1.55,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              מספר עוסק / ח.פ. לא הוגדר
            </div>
            <div>
              החשבונית תהיה אמינה וברורה יותר עם מספר עוסק. ניתן להוסיף אותו ב
              <Link href="/business" style={{ fontWeight: 700, color: "#92400e" }}>
                {" "}
                הגדרות העסק
              </Link>
              {" — או להמשיך כך."}
            </div>
          </div>
        ) : null}
        {errorMessage ? (
          <div
            role="alert"
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
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
              border: "1px solid #0f172a",
              background: "#0f172a",
              color: "#ffffff",
              fontSize: 15,
              fontWeight: 700,
              cursor: issuing ? "not-allowed" : "pointer",
              width: "100%",
            }}
          >
            {issuing ? "מפיק..." : "הפק חשבונית"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={issuing}
            style={{
              padding: "10px 16px",
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              color: "#475569",
              fontSize: 14,
              fontWeight: 600,
              cursor: issuing ? "not-allowed" : "pointer",
              width: "100%",
            }}
          >
            ביטול
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
        background: "rgba(15, 23, 42, 0.5)",
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
          background: "#ffffff",
          borderRadius: 16,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: "0 12px 40px rgba(0,0,0,0.2)",
          direction: "rtl",
        }}
      >
        <h2
          id="unsaved-changes-title"
          style={{
            fontSize: 18,
            fontWeight: 800,
            color: "#0f172a",
            margin: 0,
          }}
        >
          יש שינויים שלא נשמרו
        </h2>
        <p style={{ fontSize: 14, color: "#475569", margin: 0, lineHeight: 1.6 }}>
          לשמור לפני שיוצאים?
        </p>
        {errorMessage ? (
          <div
            role="alert"
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
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
              border: "1px solid #0f172a",
              background: saving ? "#94a3b8" : "#0f172a",
              color: "#ffffff",
              fontSize: 15,
              fontWeight: 800,
              cursor: saving ? "not-allowed" : "pointer",
              width: "100%",
            }}
          >
            {saving ? "שומר…" : "שמור והמשך"}
          </button>
          <button
            type="button"
            onClick={onLeaveWithoutSaving}
            disabled={saving}
            style={{
              padding: "10px 16px",
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              color: "#334155",
              fontSize: 14,
              fontWeight: 700,
              cursor: saving ? "not-allowed" : "pointer",
              width: "100%",
            }}
          >
            צא בלי לשמור
          </button>
          <button
            type="button"
            onClick={onKeepEditing}
            disabled={saving}
            style={{
              padding: "10px 16px",
              borderRadius: 10,
              border: "1px solid #e2e8f0",
              background: "#f8fafc",
              color: "#475569",
              fontSize: 14,
              fontWeight: 700,
              cursor: saving ? "not-allowed" : "pointer",
              width: "100%",
            }}
          >
            המשך עריכה
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
  let saveHint = "";
  if (patchStatus === "saving" || validUntilStatus === "saving") {
    saveHint = "שומר…";
  } else if (patchStatus === "saved" || validUntilStatus === "saved") {
    saveHint = "נשמר";
  }

  const isSecondary = visualTone === "secondary";

  return (
    <section
      id="billing-customer"
      style={{
        background: isSecondary ? "#ffffff" : "#ffffff",
        border: isSecondary
          ? "1px solid #e2e8f0"
          : "1px solid #e2e8f0",
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
          fontWeight: 700,
          color: "#0f172a",
        }}
      >
        {isSecondary ? "פרטי לקוח (נשמרו)" : "למי המסמך מיועד?"}
      </div>
      <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
        בחרו לקוח או כתבו שם כפי שיופיע במסמך. הפריטים שסוכמו נשמרים בנפרד.
        {showValidUntil ? (
          <>
            {" "}
            ניתן להוסיף תאריך תוקף להצעה — הוא יופיע במסמך ללקוח.
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
          <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>
            בתוקף עד (אופציונלי)
          </span>
          <input
            type="date"
            value={validUntilInput ?? ""}
            onChange={(e) => onValidUntilChange?.(e.target.value)}
            disabled={disabled}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
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
                  ? "#166534"
                  : "#64748b",
            }}
          >
            {saveHint}
          </span>
        ) : null}
        <span style={{ fontSize: 12, color: "#94a3b8" }}>
          סכומים ב־{doc.currency}
        </span>
      </div>
      {patchError ? (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
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
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
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
  const isSecondary = visualTone === "secondary";
  return (
    <section
      id="billing-lines"
      style={{
        background: "#ffffff",
        border: isSecondary ? "1px solid #e2e8f0" : "1px solid #e2e8f0",
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
          fontWeight: 700,
          color: isSecondary ? "#334155" : "#0f172a",
          margin: 0,
          letterSpacing: "0.02em",
        }}
      >
        {isSecondary ? "פריטים שסוכמו (נשמרו)" : "מה סוכם עם הלקוח?"} ({linesDraft.length})
      </h2>

      {draftLocked ? (
        <div
          style={{
            fontSize: 13,
            color: "#155e75",
            background: "#ecfeff",
            border: "1px solid #a5f3fc",
            borderRadius: 10,
            padding: "10px 12px",
            lineHeight: 1.5,
          }}
        >
          ההצעה כבר הפכה לחשבונית — הפריטים נעולים לעריכה.
        </div>
      ) : null}

      {linesDraft.length === 0 ? (
        <div
          style={{
            border: "1px dashed #cbd5e1",
            borderRadius: 10,
            padding: 16,
            textAlign: "center",
            color: "#64748b",
            fontSize: 14,
          }}
        >
          עדיין אין פריטים. הוסיפו את השירות, המוצר או התוצר שהלקוח יקבל.
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
          background: "#ffffff",
          paddingTop: 8,
          borderTop: "1px solid #f1f5f9",
        }}
      >
        <button
          type="button"
          onClick={onAddLine}
          disabled={linesSaving || draftLocked}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #cbd5e1",
            background: "#ffffff",
            color: "#334155",
            fontSize: 14,
            fontWeight: 600,
            cursor: linesSaving || draftLocked ? "not-allowed" : "pointer",
            opacity: linesSaving || draftLocked ? 0.55 : 1,
            flex: "1 1 140px",
          }}
        >
          + הוסף פריט
        </button>
        <button
          type="button"
          onClick={onSaveLines}
          disabled={!linesSaveAllowed || draftLocked}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #0f172a",
            background:
              linesSaveAllowed && !draftLocked ? "#0f172a" : "#94a3b8",
            color: "#ffffff",
            fontSize: 14,
            fontWeight: 600,
            cursor:
              linesSaveAllowed && !draftLocked ? "pointer" : "not-allowed",
            flex: "1 1 160px",
          }}
        >
          {linesSaving ? "שומר פריטים..." : "שמור פריטים"}
        </button>
      </div>

      {customerDirty || patchSaving ? (
        <div style={{ fontSize: 12, color: "#b45309", lineHeight: 1.5 }}>
          נשמור קודם את פרטי הלקוח
        </div>
      ) : null}

      {linesError ? (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
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
  return (
    <li
      style={{
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
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
            fontWeight: 700,
            color: "#475569",
            background: "#e2e8f0",
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
            border: "1px solid #fecaca",
            background: "#fef2f2",
            color: "#991b1b",
            borderRadius: 8,
            padding: "4px 10px",
            fontSize: 12,
            fontWeight: 600,
            cursor: readOnly ? "not-allowed" : "pointer",
            opacity: readOnly ? 0.45 : 1,
          }}
        >
          הסר פריט
        </button>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>
          תיאור
        </span>
        <input
          type="text"
          value={line.description}
          onChange={(e) => onChange({ description: e.target.value })}
          dir="auto"
          placeholder="תיאור פריט"
          readOnly={readOnly}
          disabled={readOnly}
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid #cbd5e1",
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
          <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>
            כמות
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
              border: "1px solid #cbd5e1",
              fontSize: 14,
              width: "100%",
              boxSizing: "border-box",
              opacity: readOnly ? 0.75 : 1,
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>
            מחיר ליחידה ({currency})
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
              border: "1px solid #cbd5e1",
              fontSize: 14,
              width: "100%",
              boxSizing: "border-box",
              opacity: readOnly ? 0.75 : 1,
            }}
          />
        </label>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>
          אחוז מע&quot;מ
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
            border: "1px solid #cbd5e1",
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
            borderTop: "1px solid #e2e8f0",
            paddingTop: 8,
            fontSize: 12,
            color: "#64748b",
            lineHeight: 1.6,
          }}
        >
          סה&quot;כ שמור לפריט זה:{" "}
          <span style={{ fontWeight: 700, color: "#0f172a" }}>
            {formatMoney(serverLine.lineTotal, currency)}
          </span>
          {serverLine.description !== line.description.trim() ||
          String(serverLine.quantity).trim() !== line.quantity.trim() ||
          String(serverLine.unitPrice).trim() !== line.unitPrice.trim() ||
          String(serverLine.vatRatePercent).trim() !==
            line.vatRatePercent.trim() ? (
            <span> — יתעדכן אחרי שמירת הפריטים</span>
          ) : null}
        </div>
      ) : (
        <div
          style={{
            borderTop: "1px solid #e2e8f0",
            paddingTop: 8,
            fontSize: 12,
            color: "#94a3b8",
          }}
        >
          פריט חדש — הסכום יחושב אחרי השמירה.
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
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid #e2e8f0",
        background: "#f8fafc",
        color: "#334155",
        fontSize: 14,
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        textAlign: "right",
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
      const err = new Error(`PDF request failed (${res.status})`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return await res.blob();
  }

  function describePdfError(err: unknown, action: PdfAction): string {
    const status =
      err && typeof err === "object" && "status" in err
        ? (err as { status?: number }).status
        : undefined;
    if (status === 401) {
      return "נדרש להתחבר מחדש כדי לפתוח את המסמך.";
    }
    if (status === 403) {
      return "אין הרשאה לפתוח את המסמך הזה.";
    }
    if (status === 500) {
      return "הכנת המסמך לשיתוף נכשלה. נסו שוב.";
    }
    return action === "view"
      ? "לא הצלחנו לפתוח את המסמך. נסו שוב."
      : action === "share"
      ? "לא הצלחנו להכין את המסמך לשיתוף. נסו הורדה."
      : "לא הצלחנו להוריד את המסמך. נסו שוב.";
  }

  function handleWhatsAppQuote() {
    const body = `שלום,
מצורפת הצעת מחיר מספר ${numberLabel}.
ניתן לצרף את המסמך לאחר הורדה או שיתוף מהנייד.`;
    const url = `https://wa.me/?text=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setShareNotice("פתחנו הודעה מוכנה ללקוח.");
  }

  async function handleCopyLink() {
    try {
      const url = new URL(pdfUrl, window.location.origin).toString();
      await navigator.clipboard.writeText(url);
      setShareNotice("הקישור למסמך הועתק.");
    } catch {
      setPdfError("לא הצלחנו להעתיק קישור. אפשר להוריד את המסמך ולשתף ידנית.");
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
        setShareNotice("המסמך מוכן לשיתוף.");
      } else {
        setPdfError(
          "שיתוף קבצים לא נתמך בדפדפן הזה. נסו הורדה או שלחו הודעה בווטסאפ והעבירו את המסמך ידנית."
        );
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
      setShareNotice("המסמך נפתח בלשונית חדשה.");
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
      setShareNotice("המסמך ירד למחשב.");
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
          "linear-gradient(135deg, #ecfeff 0%, #f0fdfa 45%, #ffffff 100%)",
        border: "1px solid #99f6e4",
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
            color: "#3F619C",
            letterSpacing: "0.04em",
          }}
        >
          הצעת מחיר — מסמך עסקי (לא חשבונית מס)
        </span>
        <span
          style={{
            fontSize: 22,
            fontWeight: 800,
            color: "#0f172a",
            lineHeight: 1.15,
          }}
        >
          #{numberLabel}
        </span>
        <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
          {locked
            ? "ההצעה כבר הפכה לחשבונית. ניתן עדיין לשמור עותק של ההצעה המקורית."
            : "שתפו את ההצעה עם הלקוח. כשיש הסכמה, אפשר להפוך אותה לחשבונית."}
        </p>
      </div>

      {pdfError ? (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
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
            background: "#ecfdf5",
            border: "1px solid #bbf7d0",
            color: "#166534",
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
          padding: "12px 16px",
          borderRadius: 12,
          border: "1px solid #243B57",
          background: "linear-gradient(90deg, #243B57 0%, #9DB4D4 100%)",
          color: "#ffffff",
          fontSize: 15,
          fontWeight: 800,
          cursor: isBusy ? "not-allowed" : "pointer",
          opacity: isBusy ? 0.65 : 1,
          width: "100%",
        }}
      >
        {loadingAction ? "מכין מסמך..." : "שתף"}
      </button>

      {shareOpen ? (
        <div
          style={{
            border: "1px solid #ccfbf1",
            background: "#ffffff",
            borderRadius: 12,
            padding: 10,
            display: "grid",
            gap: 8,
          }}
        >
          <ShareOptionButton onClick={() => void handleShare()} disabled={isBusy}>
            שיתוף מהנייד
          </ShareOptionButton>
          <ShareOptionButton onClick={handleWhatsAppQuote} disabled={isBusy}>
            WhatsApp
          </ShareOptionButton>
          <ShareOptionButton onClick={() => void handleView()} disabled={isBusy}>
            צפייה במסמך
          </ShareOptionButton>
          <ShareOptionButton onClick={() => void handleDownload()} disabled={isBusy}>
            הורדה
          </ShareOptionButton>
          <ShareOptionButton onClick={() => void handleCopyLink()} disabled={isBusy}>
            העתק קישור
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
            padding: "14px 16px",
            borderRadius: 12,
            border: "1px solid #cbd5e1",
            background: "#ffffff",
            color: convertDisabled || convertBusy ? "#94a3b8" : "#334155",
            fontSize: 16,
            fontWeight: 700,
            cursor: convertDisabled || convertBusy ? "not-allowed" : "pointer",
            width: "100%",
          }}
        >
          {convertBusy ? "יוצר חשבונית…" : "הפוך לחשבונית כשיש הסכמה"}
        </button>
      ) : doc.convertedToInvoiceId !== null ? (
        <Link
          href={`/billing/${doc.convertedToInvoiceId}`}
          style={{
            display: "block",
            textAlign: "center",
            padding: "12px 16px",
            borderRadius: 12,
            border: "1px solid #0e7490",
            background: "#ffffff",
            color: "#0e7490",
            fontSize: 15,
            fontWeight: 800,
            textDecoration: "none",
          }}
        >
          פתח את החשבונית שנוצרה
        </Link>
      ) : null}
    </section>
  );
}

function IssuedHero({ doc }: { doc: BillingDocumentDetail }) {
  const issuedDate = formatDateTime(doc.issuedAt);
  const numberLabel = doc.documentNumberFormatted ?? "ללא מספר";
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
      const err = new Error(`PDF request failed (${res.status})`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return await res.blob();
  }

  function describePdfError(err: unknown, action: PdfAction): string {
    const status =
      err && typeof err === "object" && "status" in err
        ? (err as { status?: number }).status
        : undefined;
    if (status === 401) {
      return "נדרש להתחבר מחדש כדי לפתוח את המסמך.";
    }
    if (status === 403) {
      return "אין הרשאה לפתוח את המסמך הזה.";
    }
    if (status === 500) {
      return "המסמך הופק, אבל ההכנה לשיתוף נכשלה. נסו שוב.";
    }
    return action === "view"
      ? "לא הצלחנו לפתוח את המסמך. נסו שוב."
      : action === "share"
      ? "לא הצלחנו להכין את המסמך לשיתוף. נסו הורדה."
      : "לא הצלחנו להוריד את המסמך. נסו שוב.";
  }

  function handleWhatsAppDraft() {
    const body = `שלום,
מצורפת חשבונית מס מספר ${numberLabel}.
נשמח לשלוח את המסמך — נא להשתמש בכפתור "הורד" או "שתף" באפליקציה.`;
    const url = `https://wa.me/?text=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setShareNotice("פתחנו הודעה מוכנה ללקוח.");
  }

  async function handleCopyLink() {
    try {
      const url = new URL(pdfUrl, window.location.origin).toString();
      await navigator.clipboard.writeText(url);
      setShareNotice("הקישור למסמך הועתק.");
    } catch {
      setPdfError("לא הצלחנו להעתיק קישור. אפשר להוריד את המסמך ולשתף ידנית.");
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
        setShareNotice("המסמך מוכן לשיתוף.");
      } else {
        setPdfError(
          "שיתוף קבצים לא נתמך בדפדפן הזה. נסו הורדה או שלחו הודעה בווטסאפ והעבירו את המסמך ידנית."
        );
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
      setShareNotice("המסמך נפתח בלשונית חדשה.");
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
      setShareNotice("המסמך ירד למחשב.");
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
          "linear-gradient(135deg, #ecfdf5 0%, #f0fdf4 50%, #ffffff 100%)",
        border: "1px solid #bbf7d0",
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
            color: "#166534",
            letterSpacing: "0.04em",
          }}
        >
          מסמך הופק
        </span>
        <span
          style={{
            fontSize: 28,
            fontWeight: 800,
            color: "#0f172a",
            lineHeight: 1.1,
          }}
        >
          #{numberLabel}
        </span>
        {issuedDate ? (
          <span style={{ fontSize: 14, color: "#475569" }}>
            תאריך הפקה: {issuedDate}
          </span>
        ) : null}
      </div>

      {pdfError ? (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
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
            background: "#ecfdf5",
            border: "1px solid #bbf7d0",
            color: "#166534",
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
          padding: "12px 16px",
          borderRadius: 12,
          border: "1px solid #0f172a",
          background: "#0f172a",
          color: "#ffffff",
          fontSize: 15,
          fontWeight: 800,
          cursor: isBusy ? "not-allowed" : "pointer",
          opacity: isBusy ? 0.65 : 1,
          width: "100%",
        }}
      >
        {loadingAction ? "מכין מסמך..." : "שתף"}
      </button>

      {shareOpen ? (
        <div
          style={{
            border: "1px solid #e2e8f0",
            background: "#ffffff",
            borderRadius: 12,
            padding: 10,
            display: "grid",
            gap: 8,
          }}
        >
          <ShareOptionButton onClick={() => void handleShare()} disabled={isBusy}>
            שיתוף מהנייד
          </ShareOptionButton>
          <ShareOptionButton onClick={handleWhatsAppDraft} disabled={isBusy}>
            WhatsApp
          </ShareOptionButton>
          <ShareOptionButton onClick={() => void handleView()} disabled={isBusy}>
            צפייה במסמך
          </ShareOptionButton>
          <ShareOptionButton onClick={() => void handleDownload()} disabled={isBusy}>
            הורדה
          </ShareOptionButton>
          <ShareOptionButton onClick={() => void handleCopyLink()} disabled={isBusy}>
            העתק קישור
          </ShareOptionButton>
        </div>
      ) : null}
    </section>
  );
}

function DetailsCard({
  doc,
  hideCustomer = false,
}: {
  doc: BillingDocumentDetail;
  hideCustomer?: boolean;
}) {
  const customer = doc.customerNameSnapshot ?? "—";
  const created = formatDateTime(doc.createdAt);
  const issued = formatDateTime(doc.issuedAt);
  const validUntil =
    doc.documentType === "QUOTE" && doc.validUntil
      ? formatDate(doc.validUntil)
      : "";

  return (
    <section
      style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: 14,
        padding: 16,
      }}
    >
      <h2
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: "#0f172a",
          margin: "0 0 12px 0",
          letterSpacing: "0.02em",
        }}
      >
        פרטי המסמך ללקוח
      </h2>
      <dl style={{ display: "grid", gap: 10, margin: 0 }}>
        {hideCustomer ? null : <DetailRow label="לקוח" value={customer} />}
        <DetailRow
          label="סוג מסמך"
          value={getDocumentTypeLabel(doc.documentType)}
        />
        <DetailRow label="סטטוס" value={STATUS_LABEL[doc.status] ?? doc.status} />
        {validUntil ? (
          <DetailRow label="בתוקף עד" value={validUntil} />
        ) : null}
        {created ? <DetailRow label="נוצר" value={created} /> : null}
        {issued ? <DetailRow label="הופק" value={issued} /> : null}
      </dl>
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <dt
        style={{
          fontSize: 13,
          color: "#64748b",
          margin: 0,
          fontWeight: 500,
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          fontSize: 14,
          color: "#0f172a",
          margin: 0,
          fontWeight: 600,
          textAlign: "left",
        }}
      >
        {value}
      </dd>
    </div>
  );
}

function TotalsCard({
  doc,
  showUnsavedLinesHint = false,
}: {
  doc: BillingDocumentDetail;
  showUnsavedLinesHint?: boolean;
}) {
  const subtotal = formatMoney(doc.subtotalAmount, doc.currency);
  const vat = formatMoney(doc.vatAmount, doc.currency);
  const total = formatMoney(doc.totalAmount, doc.currency);

  return (
    <section
      style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: 14,
        padding: 16,
      }}
    >
      <h2
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: "#0f172a",
          margin: "0 0 12px 0",
          letterSpacing: "0.02em",
        }}
      >
        סיכום לתשלום
      </h2>
      {showUnsavedLinesHint ? (
        <div
          style={{
            fontSize: 12,
            color: "#64748b",
            marginBottom: 10,
            lineHeight: 1.5,
            padding: "8px 10px",
            background: "#f8fafc",
            borderRadius: 8,
            border: "1px solid #e2e8f0",
          }}
        >
          יש שינויים שלא נשמרו — הסכומים משקפים את הגרסה האחרונה שנשמרה
        </div>
      ) : null}
      <div style={{ display: "grid", gap: 8 }}>
        <TotalRow label="סכום ביניים" value={subtotal} />
        <TotalRow label='מע"מ' value={vat} />
        <div
          style={{
            height: 1,
            background: "#e2e8f0",
            margin: "4px 0",
          }}
        />
        <TotalRow label='סה"כ לתשלום' value={total} emphasized />
        <div
          style={{
            fontSize: 12,
            color: "#94a3b8",
            marginTop: 4,
            textAlign: "left",
          }}
        >
          סכומים ב־{doc.currency}
        </div>
      </div>
    </section>
  );
}

function TotalRow({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
      }}
    >
      <span
        style={{
          fontSize: emphasized ? 15 : 14,
          color: emphasized ? "#0f172a" : "#475569",
          fontWeight: emphasized ? 700 : 500,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: emphasized ? 18 : 14,
          color: "#0f172a",
          fontWeight: emphasized ? 800 : 600,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function LinesSection({
  lines,
  currency,
}: {
  lines: BillingDocumentLine[];
  currency: string;
}) {
  return (
    <section
      style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: 14,
        padding: 16,
      }}
    >
      <h2
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: "#0f172a",
          margin: "0 0 12px 0",
          letterSpacing: "0.02em",
        }}
      >
        פריטים במסמך ({lines.length})
      </h2>
      {lines.length === 0 ? (
        <div
          style={{
            border: "1px dashed #cbd5e1",
            borderRadius: 10,
            padding: 16,
            textAlign: "center",
            color: "#64748b",
            fontSize: 14,
          }}
        >
          אין פריטים במסמך
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gap: 8,
          }}
        >
          {lines.map((line) => (
            <LineCard key={line.id} line={line} currency={currency} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LineCard({
  line,
  currency,
}: {
  line: BillingDocumentLine;
  currency: string;
}) {
  const qty = formatQuantity(line.quantity);
  const unit = formatMoney(line.unitPrice, currency);
  const subtotal = formatMoney(line.lineSubtotal, currency);
  const vatLabel = formatPercent(line.vatRatePercent);
  const vat = formatMoney(line.vatAmount, currency);
  const total = formatMoney(line.lineTotal, currency);

  return (
    <li
      style={{
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        padding: 12,
        display: "grid",
        gap: 8,
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
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            flex: 1,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "#475569",
              background: "#e2e8f0",
              borderRadius: 6,
              padding: "2px 8px",
              flexShrink: 0,
            }}
          >
            #{line.lineIndex}
          </span>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "#0f172a",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={line.description}
          >
            {line.description}
          </span>
        </div>
      </div>

      <div
        style={{
          fontSize: 13,
          color: "#475569",
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <span>כמות: {qty}</span>
        <span style={{ color: "#cbd5e1" }}>·</span>
        <span>מחיר ליחידה: {unit}</span>
        <span style={{ color: "#cbd5e1" }}>·</span>
        <span>סכום: {subtotal}</span>
      </div>

      <div
        style={{
          fontSize: 13,
          color: "#475569",
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <span>מע&quot;מ {vatLabel}:</span>
        <span style={{ fontWeight: 600, color: "#0f172a" }}>{vat}</span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          borderTop: "1px solid #e2e8f0",
          paddingTop: 8,
        }}
      >
        <span style={{ fontSize: 13, color: "#475569", fontWeight: 500 }}>
          סה&quot;כ פריט
        </span>
        <span style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
          {total}
        </span>
      </div>
    </li>
  );
}
