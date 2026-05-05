"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  card,
  primaryBtn,
  emptyState,
  pageMain,
  hero,
  heroKicker,
  heroTitle,
  heroSubText,
  alertError,
} from "../ui";
import PageHeader from "@/components/ui/page-header";

type GmailStatusResponse =
  | { error: string }
  | {
      success: true;
      connected: boolean;
      emailAddress?: string;
      status?: string;
      lastSyncedAt?: string | null;
    };

type GmailDiscoveryAttachment = {
  messageId: string;
  attachmentId: string;
  filename: string | null;
  mimeType: string;
  sizeBytes: number | null;
  fromEmail: string | null;
  subject: string | null;
  sentAt: string | null;
};

type EmailAttachmentBucket = "recommended" | "possible" | "hidden";
type EmailAttachmentUiStatus =
  | "pending"
  | "importing"
  | "imported"
  | "duplicate"
  | "failed";

type ScoredAttachment = GmailDiscoveryAttachment & {
  key: string;
  score: number;
  bucket: EmailAttachmentBucket;
  reason: string;
};

type BulkImportSummary = {
  totalRecommended: number;
  imported: number;
  duplicates: number;
  failed: number;
  lastDocumentId: number | null;
};

function normalizeText(v: string | null | undefined): string {
  return String(v ?? "").toLowerCase().trim();
}

function scoreAttachment(a: GmailDiscoveryAttachment): {
  score: number;
  bucket: EmailAttachmentBucket;
  reason: string;
} {
  let score = 0;
  const reasons: string[] = [];

  const mime = normalizeText(a.mimeType);
  const filename = normalizeText(a.filename);
  const fromEmail = normalizeText(a.fromEmail);
  const subject = normalizeText(a.subject);

  const isPdf = mime === "application/pdf" || filename.endsWith(".pdf");
  const isImage = mime.startsWith("image/") || /\.(png|jpg|jpeg|webp|gif)$/.test(filename);

  if (isPdf) {
    score += 40;
    reasons.push("PDF");
  } else if (isImage) {
    score += 25;
    reasons.push("תמונה");
  } else {
    score -= 50;
    reasons.push("סוג קובץ לא נתמך");
  }

  const size = a.sizeBytes ?? null;
  if (size != null) {
    if (size < 20_000) {
      score -= 25;
      reasons.push("קטן מאוד");
    } else if (size < 150_000) {
      score -= 5;
    } else if (size <= 8_000_000) {
      score += 10;
      reasons.push("גודל סביר");
    } else if (size <= 15_000_000) {
      score += 2;
      reasons.push("גדול");
    } else {
      score -= 30;
      reasons.push("גדול מדי");
    }
  }

  const receiptHints = ["receipt", "invoice", "חשבונית", "קבלה", "tax", "invoice_", "חשבונית מס"];
  const hasReceiptHint =
    receiptHints.some((h) => filename.includes(h)) ||
    receiptHints.some((h) => subject.includes(h));
  if (hasReceiptHint) {
    score += 15;
    reasons.push("נראה כמו קבלה/חשבונית");
  }

  const noiseHints = ["logo", "signature", "unsubscribe", "facebook", "twitter", "instagram"];
  const hasNoise =
    noiseHints.some((h) => filename.includes(h)) ||
    noiseHints.some((h) => subject.includes(h));
  if (hasNoise) {
    score -= 25;
    reasons.push("כנראה לא מסמך פיננסי");
  }

  if (fromEmail.endsWith("@gmail.com")) {
    score += 2;
  }

  const bucket: EmailAttachmentBucket =
    score >= 45 ? "recommended" : score >= 20 ? "possible" : "hidden";

  const reason =
    bucket === "recommended"
      ? `מומלץ לייבוא (${score})`
      : bucket === "possible"
        ? `אולי רלוונטי (${score})`
        : `מוסתר (${score})`;

  return { score, bucket, reason: reasons.length ? `${reason} • ${reasons.join(", ")}` : reason };
}

export default function UploadPage() {
  const [mode, setMode] = useState<"upload" | "camera" | "email">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [cameraUi, setCameraUi] = useState<
    "closed" | "loading" | "preview" | "captured" | "error"
  >("closed");
  const [cameraError, setCameraError] = useState<string>("");
  const [capturedPreviewUrl, setCapturedPreviewUrl] = useState<string>("");

  const authHeader = useMemo(() => {
    if (typeof window === "undefined") return null;
    const token = window.localStorage.getItem("token");
    if (!token) return null;
    return `Bearer ${token}`;
  }, []);

  const canUseGetUserMedia = useMemo(() => {
    if (typeof window === "undefined") return false;
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }, []);

  const isProbablyMobile = useMemo(() => {
    if (typeof window === "undefined") return false;
    const coarse =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    const ua = (navigator.userAgent || "").toLowerCase();
    const uaMobile = /android|iphone|ipad|ipod/.test(ua);
    return coarse || uaMobile;
  }, []);

  function stopCameraStream() {
    const stream = streamRef.current;
    if (stream) {
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch {
          // ignore
        }
      }
      streamRef.current = null;
    }
    const v = videoRef.current;
    if (v) {
      try {
        v.srcObject = null;
      } catch {
        // ignore
      }
    }
  }

  async function openDesktopCamera() {
    setCameraError("");
    setCapturedPreviewUrl("");
    setCameraUi("loading");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });

      streamRef.current = stream;

      const v = videoRef.current;
      if (!v) {
        stopCameraStream();
        throw new Error("Missing video element");
      }

      v.srcObject = stream;
      await v.play();
      setCameraUi("preview");
    } catch (e: any) {
      stopCameraStream();
      setCameraUi("error");
      setCameraError(
        e?.name === "NotAllowedError"
          ? "אין הרשאה למצלמה. אפשר לבחור קובץ במקום."
          : "לא הצלחנו לפתוח מצלמה. אפשר לבחור קובץ במקום."
      );
    }
  }

  function captureToFileFromVideo(): Promise<File> {
    return new Promise((resolve, reject) => {
      const v = videoRef.current;
      if (!v) return reject(new Error("Missing video"));

      const w = v.videoWidth || 0;
      const h = v.videoHeight || 0;
      if (!w || !h) return reject(new Error("Video not ready"));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas not supported"));

      ctx.drawImage(v, 0, 0, w, h);

      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("Failed to capture image"));
          const name = `camera-${Date.now()}.jpg`;
          resolve(new File([blob], name, { type: "image/jpeg" }));
        },
        "image/jpeg",
        0.92
      );
    });
  }

  const [gmailStatusLoading, setGmailStatusLoading] = useState(false);
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null);
  const [gmailEmailAddress, setGmailEmailAddress] = useState<string>("");
  const [gmailLastSyncedAt, setGmailLastSyncedAt] = useState<string>("");
  const [gmailError, setGmailError] = useState<string>("");

  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState("");
  const [attachments, setAttachments] = useState<GmailDiscoveryAttachment[]>([]);

  const [importingKey, setImportingKey] = useState<string>("");
  const [importResult, setImportResult] = useState<any>(null);
  const [importStatusByKey, setImportStatusByKey] = useState<
    Record<string, EmailAttachmentUiStatus>
  >({});
  const [bulkImportRunning, setBulkImportRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(
    null
  );
  const [bulkSummary, setBulkSummary] = useState<BulkImportSummary | null>(null);

  async function refreshGmailStatus() {
    if (!authHeader) {
      setGmailConnected(null);
      return;
    }

    setGmailStatusLoading(true);
    setGmailError("");

    try {
      const res = await fetch("/api/integrations/gmail/status", {
        headers: { authorization: authHeader },
      });

      const data = (await res.json()) as GmailStatusResponse;
      if (!res.ok) {
        setGmailConnected(null);
        setGmailError("לא ניתן לקרוא סטטוס Gmail");
        return;
      }

      if ("error" in data) {
        setGmailConnected(null);
        setGmailError(data.error || "שגיאת סטטוס Gmail");
        return;
      }

      setGmailConnected(Boolean(data.connected));
      setGmailEmailAddress(data.emailAddress || "");
      setGmailLastSyncedAt(data.lastSyncedAt ? String(data.lastSyncedAt) : "");
    } catch (e: any) {
      setGmailConnected(null);
      setGmailError(e?.message || "שגיאה בסטטוס Gmail");
    } finally {
      setGmailStatusLoading(false);
    }
  }

  useEffect(() => {
    if (mode === "email") {
      void refreshGmailStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, []);

  const scoredAttachments = useMemo((): ScoredAttachment[] => {
    return attachments.map((a) => {
      const key = `${a.messageId}:${a.attachmentId}`;
      const scored = scoreAttachment(a);
      return { ...a, key, ...scored };
    });
  }, [attachments]);

  const visibleAttachments = useMemo((): ScoredAttachment[] => {
    return scoredAttachments
      .filter((a) => a.bucket !== "hidden")
      .sort((a, b) => b.score - a.score);
  }, [scoredAttachments]);

  const recommendedAttachments = useMemo((): ScoredAttachment[] => {
    return scoredAttachments
      .filter((a) => a.bucket === "recommended")
      .sort((a, b) => b.score - a.score);
  }, [scoredAttachments]);

  async function importOne(a: GmailDiscoveryAttachment) {
    if (!authHeader) throw new Error("Missing auth");
    const key = `${a.messageId}:${a.attachmentId}`;

    setImportStatusByKey((m) => ({ ...m, [key]: "importing" }));
    setImportingKey(key);

    try {
      const res = await fetch("/api/integrations/gmail/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: authHeader,
        },
        body: JSON.stringify(a),
      });

      const data = await res.json();
      setImportResult(data);

      if (!res.ok) {
        setImportStatusByKey((m) => ({ ...m, [key]: "failed" }));
        return;
      }

      if (data?.imported === false && data?.skipped === "duplicate") {
        setImportStatusByKey((m) => ({ ...m, [key]: "duplicate" }));
        return;
      }

      if (data?.documentId) {
        setImportStatusByKey((m) => ({ ...m, [key]: "imported" }));
        return;
      }

      // unknown success shape
      setImportStatusByKey((m) => ({ ...m, [key]: "failed" }));
    } catch {
      setImportStatusByKey((m) => ({ ...m, [key]: "failed" }));
    } finally {
      setImportingKey("");
    }
  }

  async function importAllRecommendedSequential() {
    if (!authHeader) return;
    if (!recommendedAttachments.length) return;

    setBulkImportRunning(true);
    setImportResult(null);
    setBulkSummary(null);
    setBulkProgress({ current: 0, total: recommendedAttachments.length });

    try {
      let imported = 0;
      let duplicates = 0;
      let failed = 0;
      let lastDocumentId: number | null = null;

      let i = 0;
      for (const a of recommendedAttachments) {
        const current = importStatusByKey[a.key];
        if (current === "imported" || current === "duplicate") continue;
        i += 1;
        setBulkProgress({ current: i, total: recommendedAttachments.length });

        // Inline import to get deterministic outcome for summary/progress.
        setImportStatusByKey((m) => ({ ...m, [a.key]: "importing" }));
        setImportingKey(a.key);

        try {
          const res = await fetch("/api/integrations/gmail/import", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: authHeader,
            },
            body: JSON.stringify(a),
          });

          const data = await res.json();
          setImportResult(data);

          if (!res.ok) {
            failed += 1;
            setImportStatusByKey((m) => ({ ...m, [a.key]: "failed" }));
            continue;
          }

          if (data?.imported === false && data?.skipped === "duplicate") {
            duplicates += 1;
            setImportStatusByKey((m) => ({ ...m, [a.key]: "duplicate" }));
            continue;
          }

          if (data?.documentId) {
            imported += 1;
            lastDocumentId = Number(data.documentId) || lastDocumentId;
            setImportStatusByKey((m) => ({ ...m, [a.key]: "imported" }));
            continue;
          }

          failed += 1;
          setImportStatusByKey((m) => ({ ...m, [a.key]: "failed" }));
        } catch {
          failed += 1;
          setImportStatusByKey((m) => ({ ...m, [a.key]: "failed" }));
        } finally {
          setImportingKey("");
        }
      }

      setBulkSummary({
        totalRecommended: recommendedAttachments.length,
        imported,
        duplicates,
        failed,
        lastDocumentId,
      });
    } finally {
      setBulkImportRunning(false);
      setBulkProgress(null);
    }
  }

  const handleUpload = async () => {
    if (!file) return;

    setLoading(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("businessId", "1");
      formData.append("source", "file");

      const res = await fetch("/api/documents/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok || !data.documentId) {
        throw new Error(data?.error || "Upload failed");
      }

      router.push(`/documents/review/${data.documentId}`);
    } catch (e: any) {
      setError(e?.message || "אירעה שגיאה בהעלאה");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div dir="rtl">
      <PageHeader title="העלאה" />

      <main style={pageMain}>
        <section style={hero}>
          <div style={heroKicker}>קליטה</div>
          <h1 style={heroTitle}>העלאת מסמך</h1>
          <p style={heroSubText}>העלאה, צילום או ייבוא ממייל — ואז בדיקה קצרה.</p>
        </section>

        <div style={card}>
        {/* Hidden pickers triggered programmatically */}
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*,application/pdf"
          style={{ display: "none" }}
          onChange={(e) => {
            setMode("upload");
            setFile(e.target.files?.[0] || null);
          }}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => {
            setMode("camera");
            setFile(e.target.files?.[0] || null);
          }}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <button
            type="button"
            disabled={loading}
            style={{
              ...primaryBtn,
              width: "100%",
              opacity: loading ? 0.6 : 1,
            }}
            onClick={() => {
              setError("");
              setMode("upload");
              setFile(null);
              uploadInputRef.current?.click();
            }}
          >
            העלאה
          </button>

          <button
            type="button"
            disabled={loading}
            style={{
              ...primaryBtn,
              width: "100%",
              background: "#fff",
              color: "#111827",
              border: "1px solid #e5e7eb",
              opacity: loading ? 0.6 : 1,
            }}
            onClick={() => {
              setError("");
              setMode("camera");
              setFile(null);

              // Mobile: native camera capture input.
              if (isProbablyMobile) {
                cameraInputRef.current?.click();
                return;
              }

              // Desktop: try real camera preview via getUserMedia.
              if (canUseGetUserMedia) {
                void openDesktopCamera();
                return;
              }

              // Fallback: file picker.
              setCameraUi("error");
              setCameraError("המצלמה לא נתמכת בדפדפן הזה. אפשר לבחור קובץ במקום.");
              uploadInputRef.current?.click();
            }}
          >
            צילום
          </button>

          <button
            type="button"
            disabled={loading}
            style={{
              ...primaryBtn,
              width: "100%",
              opacity: loading ? 0.6 : 1,
            }}
            onClick={() => {
              setMode("email");
              setFile(null);
              setError("");
              setScanError("");
              setAttachments([]);
              setImportResult(null);
              setImportingKey("");
              setImportStatusByKey({});
              setBulkSummary(null);
              setBulkProgress(null);
            }}
          >
            מייל
          </button>
        </div>

        {mode === "email" ? (
          <div style={{ marginTop: 14 }}>
            {!authHeader ? (
              <div style={{ color: "#666", fontSize: 14 }}>
                כדי לחבר Gmail צריך להתחבר למערכת קודם.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 14, color: "#666" }}>
                  {gmailStatusLoading
                    ? "בודק סטטוס Gmail..."
                    : gmailConnected
                      ? "Gmail מחובר"
                      : "Gmail לא מחובר"}
                  {gmailConnected && gmailEmailAddress ? (
                    <div style={{ marginTop: 6 }}>מחובר כ־{gmailEmailAddress}</div>
                  ) : null}
                  {gmailLastSyncedAt ? (
                    <div style={{ marginTop: 6 }}>Sync אחרון: {gmailLastSyncedAt}</div>
                  ) : null}
                </div>

                {gmailError ? <div style={emptyState}>{gmailError}</div> : null}

                {!gmailConnected ? (
                  <button
                    type="button"
                    disabled={gmailStatusLoading}
                    style={{
                      ...primaryBtn,
                      opacity: gmailStatusLoading ? 0.6 : 1,
                    }}
                    onClick={async () => {
                      try {
                        setGmailError("");
                        const res = await fetch("/api/integrations/gmail/connect", {
                          redirect: "manual",
                          headers: { authorization: authHeader },
                        });
                        const location = res.headers.get("location");
                        if (!location) {
                          throw new Error("Missing redirect location");
                        }
                        window.location.href = location;
                      } catch (e: any) {
                        setGmailError(e?.message || "שגיאה בחיבור Gmail");
                      }
                    }}
                  >
                    חבר Gmail
                  </button>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <button
                      type="button"
                      disabled={scanLoading || bulkImportRunning}
                      style={{
                        ...primaryBtn,
                        opacity: scanLoading || bulkImportRunning ? 0.6 : 1,
                      }}
                      onClick={async () => {
                        setScanLoading(true);
                        setScanError("");
                        setBulkSummary(null);
                        setBulkProgress(null);

                        try {
                          const res = await fetch(
                            "/api/integrations/gmail/sync?maxMessages=5",
                            { headers: { authorization: authHeader } }
                          );
                          const data = await res.json();
                          if (!res.ok) {
                            throw new Error(data?.error || "Scan failed");
                          }
                          const list = Array.isArray(data.attachments)
                            ? (data.attachments as GmailDiscoveryAttachment[])
                            : [];

                          setAttachments(list);
                          setImportStatusByKey((prev) => {
                            const next = { ...prev };
                            for (const a of list) {
                              const key = `${a.messageId}:${a.attachmentId}`;
                              if (!next[key]) next[key] = "pending";
                            }
                            return next;
                          });
                        } catch (e: any) {
                          setScanError(e?.message || "שגיאה בסריקת מיילים");
                        } finally {
                          setScanLoading(false);
                        }
                      }}
                    >
                      {scanLoading ? "סורק מיילים..." : "סרוק מיילים"}
                    </button>

                    {scanError ? <div style={emptyState}>{scanError}</div> : null}

                    {attachments.length ? (
                      <div
                        style={{
                          border: "1px solid #e5e7eb",
                          borderRadius: 12,
                          padding: 12,
                          background: "#fff",
                        }}
                      >
                        <div style={{ fontWeight: 800, marginBottom: 6 }}>
                          נמצאו {attachments.length} מסמכים
                        </div>
                        <div style={{ color: "#666", fontSize: 14 }}>
                          {recommendedAttachments.length} מומלצים לייבוא,{" "}
                          {Math.max(0, visibleAttachments.length - recommendedAttachments.length)} אולי
                          רלוונטיים
                        </div>

                        <div style={{ marginTop: 12 }}>
                          <button
                            type="button"
                            disabled={bulkImportRunning || !recommendedAttachments.length}
                            style={{
                              ...primaryBtn,
                              opacity:
                                bulkImportRunning || !recommendedAttachments.length ? 0.6 : 1,
                            }}
                            onClick={() => void importAllRecommendedSequential()}
                          >
                            {bulkImportRunning
                              ? "מייבא מסמכים מומלצים..."
                              : "ייבא מסמכים מומלצים"}
                          </button>
                        </div>

                        {bulkProgress ? (
                          <div style={{ marginTop: 10, color: "#666", fontSize: 14 }}>
                            מייבא {bulkProgress.current} מתוך {bulkProgress.total}
                          </div>
                        ) : null}

                        {bulkSummary ? (
                          <div style={{ marginTop: 12 }}>
                            <div style={{ fontWeight: 800, marginBottom: 6 }}>סיכום ייבוא</div>
                            <div style={{ color: "#666", fontSize: 14 }}>
                              יובאו {bulkSummary.imported} • כפילויות {bulkSummary.duplicates} • נכשלו{" "}
                              {bulkSummary.failed}
                            </div>
                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                              <button
                                type="button"
                                style={{
                                  padding: "10px 12px",
                                  borderRadius: 12,
                                  border: "1px solid #e5e7eb",
                                  background: "#fff",
                                  fontWeight: 700,
                                  cursor: "pointer",
                                }}
                                onClick={() => router.push("/documents")}
                              >
                                עבור לרשימת מסמכים
                              </button>
                              {bulkSummary.lastDocumentId ? (
                                <button
                                  type="button"
                                  style={{
                                    padding: "10px 12px",
                                    borderRadius: 12,
                                    border: "1px solid #e5e7eb",
                                    background: "#fff",
                                    fontWeight: 700,
                                    cursor: "pointer",
                                  }}
                                  onClick={() =>
                                    router.push(`/documents/review/${bulkSummary.lastDocumentId}`)
                                  }
                                >
                                  פתח מסמך אחרון
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <details style={{ marginTop: 6 }}>
                      <summary style={{ cursor: "pointer", fontWeight: 700 }}>
                        פרטים מתקדמים (למפתחים)
                      </summary>
                      <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
                        מוצגים כאן רק לצורכי דיבוג.
                      </div>
                      {attachments.length ? (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontWeight: 700, marginBottom: 8 }}>
                            Attachments (מוצגים למפתח): {visibleAttachments.length} / {attachments.length}
                          </div>
                          <div
                            style={{ display: "flex", flexDirection: "column", gap: 8 }}
                          >
                            {visibleAttachments.map((a) => {
                              const st = importStatusByKey[a.key] || "pending";
                              return (
                                <div
                                  key={a.key}
                                  style={{
                                    border: "1px solid #e5e7eb",
                                    borderRadius: 10,
                                    padding: 10,
                                    display: "flex",
                                    justifyContent: "space-between",
                                    gap: 10,
                                  }}
                                >
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 700 }}>
                                      {a.bucket === "recommended" ? "מומלץ" : "אולי"} • {a.filename || "(no filename)"}
                                    </div>
                                    <div style={{ fontSize: 12 }}>
                                      {a.fromEmail || ""} {a.sentAt ? `• ${a.sentAt}` : ""}
                                    </div>
                                    <div style={{ fontSize: 12, marginTop: 4 }}>{a.reason}</div>
                                    <div style={{ fontSize: 12, marginTop: 4 }}>
                                      סטטוס: <b>{st}</b>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    disabled={
                                      bulkImportRunning ||
                                      st === "importing" ||
                                      st === "imported" ||
                                      (Boolean(importingKey) && importingKey !== a.key)
                                    }
                                    style={{
                                      padding: "8px 10px",
                                      borderRadius: 10,
                                      border: "1px solid #e5e7eb",
                                      background: "#fff",
                                      cursor: "pointer",
                                      fontWeight: 700,
                                      whiteSpace: "nowrap",
                                      opacity:
                                        bulkImportRunning ||
                                        st === "importing" ||
                                        st === "imported" ||
                                        (Boolean(importingKey) && importingKey !== a.key)
                                          ? 0.5
                                          : 1,
                                    }}
                                    onClick={() => void importOne(a)}
                                  >
                                    Import
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}

                      {importResult ? (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontWeight: 700, marginBottom: 6 }}>
                            Import result (debug)
                          </div>
                          <pre
                            style={{
                              margin: 0,
                              padding: 10,
                              background: "#0b1020",
                              color: "#e5e7eb",
                              borderRadius: 10,
                              fontSize: 12,
                              overflow: "auto",
                            }}
                          >
                            {JSON.stringify(importResult, null, 2)}
                          </pre>
                        </div>
                      ) : null}
                    </details>
                  </div>
                )}

              </div>
            )}
          </div>
        ) : null}

        {!file && mode !== "email" && (
          <div style={{ marginTop: 14, color: "#666", fontSize: 14 }}>
            {mode === "camera"
              ? "עדיין לא צולמה תמונה"
              : "עדיין לא נבחר קובץ"}
          </div>
        )}

        {mode === "camera" && !isProbablyMobile && (cameraUi === "loading" || cameraUi === "preview" || cameraUi === "error") ? (
          <div style={{ marginTop: 14 }}>
            {cameraUi === "loading" ? (
              <div style={{ color: "#666", fontSize: 14 }}>פותח מצלמה...</div>
            ) : null}

            {cameraUi === "error" ? (
              <div style={emptyState}>
                {cameraError || "לא הצלחנו לפתוח מצלמה."}
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    style={{
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid #e5e7eb",
                      background: "#fff",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                    onClick={() => uploadInputRef.current?.click()}
                  >
                    בחר קובץ במקום
                  </button>
                </div>
              </div>
            ) : null}

            {cameraUi === "preview" ? (
              <div
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 12,
                  overflow: "hidden",
                  background: "#000",
                }}
              >
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  style={{ width: "100%", display: "block" }}
                />
                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    padding: 10,
                    background: "#fff",
                  }}
                >
                  <button
                    type="button"
                    style={{ ...primaryBtn, flex: 1 }}
                    onClick={async () => {
                      try {
                        const f = await captureToFileFromVideo();
                        stopCameraStream();
                        setCameraUi("captured");
                        setCapturedPreviewUrl(URL.createObjectURL(f));
                        setFile(f);
                      } catch (e: any) {
                        stopCameraStream();
                        setCameraUi("error");
                        setCameraError(e?.message || "צילום נכשל. אפשר לבחור קובץ במקום.");
                      }
                    }}
                  >
                    צלם
                  </button>
                  <button
                    type="button"
                    style={{
                      padding: "12px 14px",
                      borderRadius: 12,
                      border: "1px solid #e5e7eb",
                      background: "#fff",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                    onClick={() => {
                      stopCameraStream();
                      setCameraUi("closed");
                    }}
                  >
                    סגור
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {file && mode !== "email" && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>הקובץ שנבחר</div>
            <div style={{ color: "#666", fontSize: 14 }}>{file.name}</div>
            {mode === "camera" && capturedPreviewUrl ? (
              <img
                src={capturedPreviewUrl}
                alt="תמונה שצולמה"
                style={{
                  marginTop: 10,
                  width: "100%",
                  borderRadius: 12,
                  border: "1px solid #e5e7eb",
                }}
              />
            ) : null}
          </div>
        )}
      </div>

      {error ? <div style={alertError}>{error}</div> : null}

      {mode !== "email" ? (
        <button
          onClick={handleUpload}
          disabled={loading || !file}
          style={{
            ...primaryBtn,
            opacity: loading || !file ? 0.6 : 1,
          }}
        >
          {loading ? "מעלה ומנתח..." : "המשך"}
        </button>
      ) : null}
      </main>
    </div>
  );
}