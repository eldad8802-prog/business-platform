"use client";

import { useEffect, useMemo, useState } from "react";
import { updateInventoryItem } from "@/lib/api/inventory";
import { useI18n } from "@/components/i18n/I18nProvider";

type Props = {
  itemId: number;
  imageUrl: string | null | undefined;
  onUpdated: (updatedItem: { imageUrl?: string | null }) => void;
};

function isDisplayableImageUrl(url: string | null | undefined) {
  if (!url || !url.trim()) {
    return false;
  }

  const normalized = url.trim().toLowerCase();

  if (
    normalized.includes("example.com/product") ||
    normalized.includes("example.com/")
  ) {
    return false;
  }

  return normalized.startsWith("http://") || normalized.startsWith("https://");
}

export default function InventoryItemImageEditor({
  itemId,
  imageUrl,
  onUpdated,
}: Props) {
  const { t } = useI18n();
  const [draftUrl, setDraftUrl] = useState(imageUrl || "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftUrl(imageUrl || "");
  }, [imageUrl]);

  const previewUrl = useMemo(() => {
    if (!isDisplayableImageUrl(draftUrl)) {
      return null;
    }

    return draftUrl.trim();
  }, [draftUrl]);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    setError(null);

    try {
      const normalizedValue = draftUrl.trim() ? draftUrl.trim() : null;

      const updatedItem = await updateInventoryItem(itemId, {
        imageUrl: normalizedValue,
      });

      onUpdated(updatedItem);
      setDraftUrl(updatedItem.imageUrl || "");
      setMessage(t("customers.inventoryKit.image.saved"));
    } catch (err: any) {
      if (err?.message === "UNAUTHORIZED") {
        setError(t("customers.inventoryKit.image.unauthorizedUpdate"));
      } else if (err?.message === "NOT_FOUND") {
        setError(t("customers.inventoryKit.image.notFound"));
      } else {
        setError(err?.message || t("customers.inventoryKit.image.saveError"));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--inv-border)",
        borderRadius: "16px",
        background: "var(--inv-card-bg)",
        padding: "16px",
        marginBottom: "16px",
      }}
    >
      <div style={{ fontSize: "16px", fontWeight: 600, marginBottom: "12px", color: "var(--inv-text)" }}>
        {t("customers.inventoryKit.image.title")}
      </div>

      <div
        style={{
          width: "100%",
          minHeight: "220px",
          borderRadius: "12px",
          border: "1px dashed var(--inv-border-hover)",
          background: "var(--inv-surface-2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          marginBottom: "12px",
        }}
      >
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={t("customers.inventoryKit.image.title")}
            style={{
              width: "100%",
              maxHeight: "320px",
              objectFit: "cover",
              display: "block",
            }}
          />
        ) : (
          <div
            style={{
              color: "var(--inv-text-muted)",
              fontSize: "14px",
              textAlign: "center",
              padding: "20px",
            }}
          >
            {t("customers.inventoryKit.image.noImageYet")}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <label
          htmlFor="inventory-item-image-url"
          style={{ fontSize: "13px", fontWeight: 600 }}
        >
          {t("customers.inventoryKit.image.urlLabel")}
        </label>

        <input
          id="inventory-item-image-url"
          type="text"
          value={draftUrl}
          onChange={(e) => setDraftUrl(e.target.value)}
          placeholder="https://..."
          style={{
            width: "100%",
            minHeight: "44px",
            borderRadius: "10px",
            border: "1px solid var(--inv-border-hover)",
            padding: "10px 12px",
            fontSize: "14px",
            outline: "none",
          }}
        />

        <div
          style={{
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              minHeight: "42px",
              padding: "0 14px",
              borderRadius: "10px",
              border: "none",
              background: "var(--inv-primary)",
              color: "var(--inv-on-accent)",
              cursor: saving ? "not-allowed" : "pointer",
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? t("customers.inventoryKit.image.savingSlash") : t("customers.inventoryKit.image.save")}
          </button>

          <button
            onClick={() => {
              setDraftUrl("");
              setMessage(null);
              setError(null);
            }}
            type="button"
            style={{
              minHeight: "42px",
              padding: "0 14px",
              borderRadius: "10px",
              border: "1px solid var(--inv-border-hover)",
              background: "var(--inv-card-bg)",
              cursor: "pointer",
            }}
          >
            {t("customers.inventoryKit.image.clearField")}
          </button>
        </div>

        {message && (
          <div
            style={{
              marginTop: "4px",
              borderRadius: "10px",
              background: "var(--inv-success-bg)",
              border: "1px solid var(--inv-success-border)",
              color: "var(--inv-success)",
              padding: "10px 12px",
              fontSize: "13px",
            }}
          >
            {message}
          </div>
        )}

        {error && (
          <div
            style={{
              marginTop: "4px",
              borderRadius: "10px",
              background: "var(--inv-danger-bg)",
              border: "1px solid var(--inv-danger-border)",
              color: "var(--inv-danger)",
              padding: "10px 12px",
              fontSize: "13px",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}