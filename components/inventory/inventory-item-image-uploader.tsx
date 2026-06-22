"use client";

import { useEffect, useRef, useState } from "react";
import { uploadInventoryItemImage } from "@/lib/api/inventory";

type Props = {
  itemId: number;
  imageUrl?: string | null;
  onUpdated: (item: { imageUrl?: string | null }) => void;
};

function getSafeImageUrl(imageUrl?: string | null) {
  if (!imageUrl) return null;
  if (imageUrl.includes("example.com")) return null;
  return imageUrl;
}

export default function InventoryItemImageUploader({
  itemId,
  imageUrl,
  onUpdated,
}: Props) {
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const [preview, setPreview] = useState<string | null>(
    getSafeImageUrl(imageUrl)
  );
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [successText, setSuccessText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    };
  }, []);

  function resetInputs() {
    if (galleryInputRef.current) {
      galleryInputRef.current.value = "";
    }

    if (cameraInputRef.current) {
      cameraInputRef.current.value = "";
    }
  }

  function handleSelect(selected?: File) {
    if (loading) return;

    setError(null);
    setSuccessText(null);

    if (!selected) return;

    if (!selected.type.startsWith("image/")) {
      setFile(null);
      setError("אפשר להעלות קובץ תמונה בלבד");
      resetInputs();
      return;
    }

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
    }

    const nextObjectUrl = URL.createObjectURL(selected);
    objectUrlRef.current = nextObjectUrl;

    setFile(selected);
    setPreview(nextObjectUrl);
  }

  function handleGalleryChange(e: React.ChangeEvent<HTMLInputElement>) {
    handleSelect(e.target.files?.[0]);
  }

  function handleCameraChange(e: React.ChangeEvent<HTMLInputElement>) {
    handleSelect(e.target.files?.[0]);
  }

  function clearSelectedImage() {
    if (loading) return;

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    setFile(null);
    setPreview(getSafeImageUrl(imageUrl));
    setError(null);
    setSuccessText(null);
    resetInputs();
  }

  async function handleUpload() {
    if (loading) return;

    if (!file) {
      setError("צריך לבחור או לצלם תמונה לפני העלאה");
      setSuccessText(null);
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessText(null);

    try {
      const updated = await uploadInventoryItemImage(itemId, file);

      onUpdated(updated);

      const updatedImageUrl = getSafeImageUrl(updated?.imageUrl);
      setPreview(updatedImageUrl);
      setFile(null);
      setSuccessText("התמונה עודכנה בהצלחה");

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }

      resetInputs();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : null;
      if (message === "UNAUTHORIZED") {
        setError("אין הרשאה להעלות תמונה. צריך להתחבר מחדש.");
      } else {
        setError(message || "העלאת התמונה נכשלה");
      }

      setSuccessText(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: "18px",
        background: "#ffffff",
        padding: "16px",
      }}
    >
      <div
        style={{
          marginBottom: "6px",
          fontWeight: 800,
          fontSize: "16px",
          color: "#111827",
        }}
      >
        תמונת פריט
      </div>

      <div
        style={{
          marginBottom: "12px",
          fontSize: "13px",
          color: "#6b7280",
          lineHeight: 1.5,
        }}
      >
        אפשר לבחור תמונה מהגלריה או לצלם פריט חדש.
      </div>

      <div
        style={{
          width: "100%",
          height: 220,
          border: "1px dashed #d1d5db",
          borderRadius: "16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          background: "#f9fafb",
          marginBottom: "12px",
        }}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt="תמונת פריט"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
        ) : (
          <div
            style={{
              color: "#6b7280",
              fontSize: "14px",
              textAlign: "center",
              lineHeight: 1.6,
            }}
          >
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: 14,
                border: "1px solid #dbe3ef",
                background: "#ffffff",
                color: "#94a3b8",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: "8px",
              }}
            >
              <BoxIcon />
            </div>
            אין תמונה
          </div>
        )}
      </div>

      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        disabled={loading}
        onChange={handleGalleryChange}
        style={{ display: "none" }}
      />

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        disabled={loading}
        onChange={handleCameraChange}
        style={{ display: "none" }}
      />

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "8px",
          marginBottom: "10px",
        }}
      >
        <button
          type="button"
          disabled={loading}
          onClick={() => galleryInputRef.current?.click()}
          style={{
            minHeight: "42px",
            padding: "9px 13px",
            borderRadius: "12px",
            border: "1px solid #d1d5db",
            background: "#ffffff",
            color: "#111827",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.65 : 1,
            fontWeight: 700,
          }}
        >
          בחירה מהגלריה
        </button>

        <button
          type="button"
          disabled={loading}
          onClick={() => cameraInputRef.current?.click()}
          style={{
            minHeight: "42px",
            padding: "9px 13px",
            borderRadius: "12px",
            border: "1px solid #d1d5db",
            background: "#ffffff",
            color: "#111827",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.65 : 1,
            fontWeight: 700,
          }}
        >
          צילום פריט
        </button>

        {file && (
          <button
            type="button"
            disabled={loading}
            onClick={clearSelectedImage}
            style={{
              minHeight: "42px",
              padding: "9px 13px",
              borderRadius: "12px",
              border: "1px solid #fecaca",
              background: "#fef2f2",
              color: "#991b1b",
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.65 : 1,
              fontWeight: 700,
            }}
          >
            ביטול בחירה
          </button>
        )}

        <button
          type="button"
          onClick={handleUpload}
          disabled={loading || !file}
          style={{
            minHeight: "42px",
            padding: "9px 15px",
            borderRadius: "12px",
            background:
              loading || !file
                ? "#9ca3af"
                : "linear-gradient(90deg, #243B57 0%, #9DB4D4 100%)",
            color: "#ffffff",
            border: "none",
            cursor: loading || !file ? "not-allowed" : "pointer",
            fontWeight: 800,
          }}
        >
          {loading ? "מעלה..." : "העלאת תמונה"}
        </button>
      </div>

      {file && (
        <div
          style={{
            fontSize: "13px",
            color: "#374151",
            marginBottom: "8px",
            lineHeight: 1.5,
          }}
        >
          קובץ נבחר: {file.name}
        </div>
      )}

      {successText && (
        <div
          style={{
            color: "#166534",
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: "12px",
            padding: "10px 12px",
            fontSize: "13px",
            lineHeight: 1.5,
          }}
        >
          {successText}
        </div>
      )}

      {error && (
        <div
          style={{
            color: "#b91c1c",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "12px",
            padding: "10px 12px",
            fontSize: "13px",
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      )}
    </section>
  );
}

function BoxIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
