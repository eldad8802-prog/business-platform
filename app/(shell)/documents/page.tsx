"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchDocumentsHubSummary,
  type DocumentsHubSnapshot,
} from "@/lib/documents/fetch-inbox";
import {
  HubAccountantPack,
  HubActions,
  HubBackLink,
  HubChannels,
  HubSummary,
  type HubSummaryState,
} from "@/components/documents/home/DocumentsHub";
import { monthLabel } from "@/components/documents/home/home-format";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";
import { hubCss, hubShellStyle } from "@/components/documents/home/hub-styles";
import DocumentsDesktopTable from "@/components/documents/home/DocumentsDesktopTable";
import { useDocumentsInbox } from "@/hooks/useDocumentsInbox";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: DocumentsHubSnapshot };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

// Vercel serverless functions reject request bodies larger than ~4.5MB at the
// platform edge (before our handler runs), returning a non-JSON 413. Keep the
// client cap safely below that, allowing headroom for multipart overhead.
const MAX_CLIENT_UPLOAD_BYTES = 4 * 1024 * 1024; // 4MB

function isJsonResponse(res: Response): boolean {
  return (res.headers.get("content-type") || "").includes("application/json");
}

async function uploadFailureMessage(res: Response, t: Translator): Promise<string> {
  // 413 (incl. Vercel's FUNCTION_PAYLOAD_TOO_LARGE, which is text/plain) means
  // the file exceeded the size limit. Do NOT read the body — it may not be JSON.
  if (res.status === 413) return t("documents.hub.oversize");

  // Otherwise surface an app-provided JSON error if present; never the raw body.
  if (isJsonResponse(res)) {
    try {
      const data = (await res.json()) as { error?: string };
      if (typeof data?.error === "string" && data.error) return data.error;
    } catch {
      // fall through to the generic message
    }
  }
  return t("documents.hub.uploadErrorRetry");
}

export default function DocumentsHome() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const inbox = useDocumentsInbox(authToken);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  async function load() {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    setAuthToken(token);

    if (!token) {
      router.replace("/login");
      return;
    }

    setState({ status: "loading" });
    try {
      const snapshot = await fetchDocumentsHubSummary(token);
      setState({ status: "ready", snapshot });
    } catch (e) {
      const message = errorMessage(e, t("documents.hub.loadError"));
      if (message === "Unauthorized") {
        window.localStorage.removeItem("token");
        window.localStorage.removeItem("user");
        router.replace("/login");
        return;
      }
      setState({ status: "error", message });
    }
  }

  useEffect(() => {
    void Promise.resolve().then(() => load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function uploadDocument(file: File | null | undefined) {
    if (!file) return;

    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) {
      router.replace("/login");
      return;
    }

    // Block oversized files up front with a clear message, instead of letting
    // Vercel reject the request body at the edge with a non-JSON 413 that the
    // client cannot parse.
    if (file.size > MAX_CLIENT_UPLOAD_BYTES) {
      setUploadError(t("documents.hub.oversize"));
      return;
    }

    setUploading(true);
    setUploadError("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/documents/upload", {
        method: "POST",
        body: formData,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      // Duplicate defense (409): the same file already exists — send the user
      // to the existing document instead of ingesting a second copy. The
      // dedicated upload screen offers the explicit "העלה בכל זאת" override.
      if (res.status === 409 && isJsonResponse(res)) {
        const dup = await res.json().catch(() => null);
        if (dup?.duplicate?.documentId) {
          router.push(`/documents/review/${dup.duplicate.documentId}`);
          return;
        }
      }

      // Never call res.json() blindly: an error response can carry a non-JSON
      // body (e.g. Vercel's text/plain 413 "FUNCTION_PAYLOAD_TOO_LARGE"), and
      // parsing it would throw a raw, user-hostile SyntaxError. Resolve the
      // failure to a friendly Hebrew message first.
      if (!res.ok) {
        throw new Error(await uploadFailureMessage(res, t));
      }
      if (!isJsonResponse(res)) {
        throw new Error(t("documents.hub.uploadErrorRetry"));
      }

      const data = await res.json();
      if (!data?.documentId) {
        throw new Error(data?.error || "Upload failed");
      }

      router.push(`/documents/review/${data.documentId}`);
    } catch (e) {
      setUploadError(errorMessage(e, t("documents.hub.uploadError")));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  }

  const snapshot = state.status === "ready" ? state.snapshot : null;
  const pending = snapshot?.financialPulse.inboxDocumentCounts.pendingReview ?? 0;
  // The verify tile counts the whole backlog (every month), not only this month's uploads.
  const pendingAllMonths = snapshot?.financialPulse.inboxDocumentCounts.totalPendingReview ?? pending;
  const approved = snapshot?.financialPulse.inboxDocumentCounts.approvedDocuments ?? 0;
  const pulse = snapshot?.financialPulse.fromFinancialRecords;
  const pulseMonth = snapshot?.financialPulse.period.month;
  const monthText = monthLabel(pulseMonth ?? "", locale, t);

  // Open the file picker directly within the user gesture. A deferred
  // (setTimeout) click is blocked by iOS Safari — these CTAs open it
  // synchronously with no intermediate modal.
  function pickUpload() {
    if (uploading) return;
    setUploadError("");
    uploadInputRef.current?.click();
  }
  function pickCamera() {
    if (uploading) return;
    setUploadError("");
    cameraInputRef.current?.click();
  }

  const summaryState: HubSummaryState =
    state.status === "error"
      ? { status: "error", message: state.message }
      : snapshot
        ? {
            status: "ready",
            monthText,
            income: pulse?.income ?? 0,
            expense: pulse?.expense ?? 0,
            net: pulse?.net ?? 0,
            previousNet: snapshot.previousNet ?? null,
            monthDocs: pending + approved,
            approved,
          }
        : { status: "loading" };

  return (
    <div className="dz-dh" style={hubShellStyle}>
      <style>{hubCss()}</style>
      <main className="dz-dh__content">
        <input
          ref={uploadInputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          style={{ display: "none" }}
          onChange={(e) => void uploadDocument(e.target.files?.[0])}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/jpeg,image/png"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => void uploadDocument(e.target.files?.[0])}
        />

        <div className="dz-dh-top">
          <HubBackLink />
        </div>
        <h1 className="dz-dh-title">{t("documents.hub.title")}</h1>

        <HubSummary state={summaryState} onRetry={() => void load()} />

        {uploadError ? (
          <div className="dz-dh-alert" role="alert">
            {uploadError}
          </div>
        ) : null}

        <HubActions
          pending={snapshot ? pendingAllMonths : null}
          uploading={uploading}
          onUpload={pickUpload}
          onCamera={pickCamera}
          onVerify={() => router.push("/documents/inbox")}
          onSearch={() => router.push("/documents/search")}
        />

        <div className="dz-dh-lower">
          {/* Gmail opens the manual pick + preview screen; WhatsApp intake is not open yet ("בקרוב"). */}
          <HubChannels onGmail={() => router.push("/documents/email")} />
          <HubAccountantPack onOpen={() => router.push("/documents/accountant-pack")} />
        </div>

        <h2 className="dz-dh-table-h">{t("documents.home.tableAria")}</h2>
        <DocumentsDesktopTable
          items={inbox.items}
          loading={!authToken || inbox.loading}
          error={authToken ? inbox.error : null}
          onRetry={() => inbox.refetch()}
        />
      </main>
    </div>
  );
}
