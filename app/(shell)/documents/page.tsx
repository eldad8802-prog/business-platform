"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchDocumentsHubSummary,
  type DocumentsHubSnapshot,
} from "@/lib/documents/fetch-inbox";
import { glassActionStyle } from "@/lib/design/documents-theme";
import DocumentsHubSkeleton from "@/components/documents/skeletons/DocumentsHubSkeleton";
import PulseCard from "@/components/documents/home/PulseCard";
import CaptureHero from "@/components/documents/home/CaptureHero";
import StationsSection from "@/components/documents/home/StationsSection";
import { monthLabel } from "@/components/documents/home/home-format";
import {
  homeCss,
  pageShellStyle,
  contentStyle,
} from "@/components/documents/home/home-styles";

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
const OVERSIZE_MESSAGE =
  "הקובץ גדול מדי (עד 4MB). נסה קובץ קטן יותר או צלם באיכות נמוכה יותר.";

function isJsonResponse(res: Response): boolean {
  return (res.headers.get("content-type") || "").includes("application/json");
}

async function uploadFailureMessage(res: Response): Promise<string> {
  // 413 (incl. Vercel's FUNCTION_PAYLOAD_TOO_LARGE, which is text/plain) means
  // the file exceeded the size limit. Do NOT read the body — it may not be JSON.
  if (res.status === 413) return OVERSIZE_MESSAGE;

  // Otherwise surface an app-provided JSON error if present; never the raw body.
  if (isJsonResponse(res)) {
    try {
      const data = (await res.json()) as { error?: string };
      if (typeof data?.error === "string" && data.error) return data.error;
    } catch {
      // fall through to the generic message
    }
  }
  return "אירעה שגיאה בהעלאת המסמך. נסה שוב.";
}

export default function DocumentsHome() {
  const router = useRouter();
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  async function load() {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;

    if (!token) {
      router.replace("/login");
      return;
    }

    setState({ status: "loading" });
    try {
      const snapshot = await fetchDocumentsHubSummary(token);
      setState({ status: "ready", snapshot });
    } catch (e) {
      const message = errorMessage(e, "שגיאה בטעינת המסמכים");
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
      setUploadError(OVERSIZE_MESSAGE);
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

      // Never call res.json() blindly: an error response can carry a non-JSON
      // body (e.g. Vercel's text/plain 413 "FUNCTION_PAYLOAD_TOO_LARGE"), and
      // parsing it would throw a raw, user-hostile SyntaxError. Resolve the
      // failure to a friendly Hebrew message first.
      if (!res.ok) {
        throw new Error(await uploadFailureMessage(res));
      }
      if (!isJsonResponse(res)) {
        throw new Error("אירעה שגיאה בהעלאת המסמך. נסה שוב.");
      }

      const data = await res.json();
      if (!data?.documentId) {
        throw new Error(data?.error || "Upload failed");
      }

      router.push(`/documents/review/${data.documentId}`);
    } catch (e) {
      setUploadError(errorMessage(e, "אירעה שגיאה בהעלאת המסמך"));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  }

  const snapshot = state.status === "ready" ? state.snapshot : null;
  const pending = snapshot?.financialPulse.inboxDocumentCounts.pendingReview ?? 0;
  const pulse = snapshot?.financialPulse.fromFinancialRecords;
  const pulseMonth = snapshot?.financialPulse.period.month;

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

  return (
    <div dir="rtl" className="dz-docs-home" style={pageShellStyle}>
      <style>{homeCss()}</style>
      <main className="dz-docs-home__content" style={contentStyle}>
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*,application/pdf"
          style={{ display: "none" }}
          onChange={(e) => void uploadDocument(e.target.files?.[0])}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => void uploadDocument(e.target.files?.[0])}
        />

        {state.status === "loading" ? <DocumentsHubSkeleton /> : null}

        {state.status === "error" ? (
          <section className="dz-alert">
            <div className="dz-alert__title">לא הצלחנו לטעון את מרכז המסמכים.</div>
            <p className="dz-alert__text">{state.message}</p>
            <button
              type="button"
              onClick={() => void load()}
              style={{
                ...glassActionStyle({ fullWidth: true, height: 44 }),
                width: "100%",
                minHeight: 44,
                marginTop: 14,
              }}
            >
              נסה שוב
            </button>
          </section>
        ) : null}

        {state.status === "ready" ? (
          <>
            {uploadError ? (
              <section className="dz-alert">
                <div className="dz-alert__title">{uploadError}</div>
              </section>
            ) : null}

            <PulseCard
              monthLabel={monthLabel(pulseMonth ?? "")}
              income={pulse?.income ?? 0}
              expense={pulse?.expense ?? 0}
              net={pulse?.net ?? 0}
              previousNet={snapshot?.previousNet ?? null}
            />

            <CaptureHero
              onUpload={pickUpload}
              onCamera={pickCamera}
              onGmail={() => router.push("/documents/email")}
              onWhatsapp={() => router.push("/settings/whatsapp")}
              uploading={uploading}
            />

            <StationsSection
              pendingCount={pending}
              onQueue={() => router.push("/documents/inbox")}
              onSearch={() => router.push("/documents/search")}
              onPack={() => router.push("/documents/accountant-pack")}
            />
          </>
        ) : null}
      </main>
    </div>
  );
}
