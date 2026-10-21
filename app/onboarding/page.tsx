"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import { TOKEN } from "@/lib/design/tokens";
import {
  BUSINESS_CATEGORY_OPTIONS as categoryOptions,
  BUSINESS_MODEL_OPTIONS as businessModelOptions,
} from "@/lib/business/business-categories";

export default function OnboardingPage() {
  const router = useRouter();
  const { t } = useI18n();

  const [category, setCategory] = useState("");
  const [subCategory, setSubCategory] = useState("");
  const [businessModel, setBusinessModel] = useState("service");
  const [loading, setLoading] = useState(false);

  const currentCategory = useMemo(() => {
    return categoryOptions.find((item) => item.value === category) || null;
  }, [category]);

  const availableSubCategories = currentCategory?.subCategories || [];

  const handleCategoryChange = (value: string) => {
    setCategory(value);
    setSubCategory("");
  };

  const handleSubmit = async () => {
    try {
      if (!category || !subCategory || !businessModel) {
        alert(t("account.onboarding.fillAll"));
        return;
      }

      setLoading(true);

      const token = localStorage.getItem("token");

      const res = await fetch("/api/business/profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          category,
          subCategory,
          businessModel,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || t("account.onboarding.saveFailed"));
      }

      router.replace("/app");
    } catch (err) {
      console.error(err);
      alert(t("account.onboarding.saveFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--dz-surface-muted)",
        padding: "24px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 560,
          background: "var(--dz-surface)",
          border: "1px solid var(--dz-border)",
          borderRadius: 22,
          boxShadow: "0 10px 30px rgba(52, 60, 50, 0.07)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "28px 24px 18px",
            background: "linear-gradient(135deg, var(--dz-surface-flat) 0%, var(--dz-surface-muted) 55%, var(--dz-brand-soft) 100%)",
            borderBottom: "1px solid var(--dz-border)",
          }}
        >
          <h1 style={{ margin: "0 0 8px 0", fontSize: 30, color: "var(--dz-text-primary)" }}>
            {t("account.onboarding.title")}
          </h1>

          <p style={{ margin: 0, color: "var(--dz-text-muted)", lineHeight: 1.7 }}>
            {t("account.onboarding.subtitle")}
          </p>
        </div>

        <div style={{ padding: 24 }}>
          <div style={{ marginBottom: 18 }}>
            <label
              style={{
                display: "block",
                marginBottom: 8,
                fontWeight: 700,
                color: "var(--dz-text-primary)",
                fontSize: 14,
              }}
            >
              {t("account.onboarding.categoryLabel")}
            </label>

            <select
              value={category}
              onChange={(e) => handleCategoryChange(e.target.value)}
              style={{
                width: "100%",
                padding: "12px 14px",
                border: "1px solid var(--dz-border-strong)",
                borderRadius: 12,
                fontSize: 15,
                background: "var(--dz-surface)",
                boxSizing: "border-box",
              }}
            >
              <option value="">{t("account.onboarding.categoryPlaceholder")}</option>
              {categoryOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>

            <div
              style={{
                marginTop: 8,
                color: "var(--dz-text-muted)",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              {t("account.onboarding.categoryHelp")}
            </div>
          </div>

          <div style={{ marginBottom: 18 }}>
            <label
              style={{
                display: "block",
                marginBottom: 8,
                fontWeight: 700,
                color: "var(--dz-text-primary)",
                fontSize: 14,
              }}
            >
              {t("account.onboarding.subCategoryLabel")}
            </label>

            <select
              value={subCategory}
              onChange={(e) => setSubCategory(e.target.value)}
              disabled={!category}
              style={{
                width: "100%",
                padding: "12px 14px",
                border: "1px solid var(--dz-border-strong)",
                borderRadius: 12,
                fontSize: 15,
                background: category ? "var(--dz-surface)" : "var(--dz-surface-muted)",
                boxSizing: "border-box",
              }}
            >
              <option value="">
                {category ? t("account.onboarding.subCategoryPlaceholder") : t("account.onboarding.subCategoryFirst")}
              </option>
              {availableSubCategories.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>

            <div
              style={{
                marginTop: 8,
                color: "var(--dz-text-muted)",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              {t("account.onboarding.subCategoryHelp")}
            </div>
          </div>

          <div style={{ marginBottom: 22 }}>
            <label
              style={{
                display: "block",
                marginBottom: 8,
                fontWeight: 700,
                color: "var(--dz-text-primary)",
                fontSize: 14,
              }}
            >
              {t("account.onboarding.modelLabel")}
            </label>

            <select
              value={businessModel}
              onChange={(e) => setBusinessModel(e.target.value)}
              style={{
                width: "100%",
                padding: "12px 14px",
                border: "1px solid var(--dz-border-strong)",
                borderRadius: 12,
                fontSize: 15,
                background: "var(--dz-surface)",
                boxSizing: "border-box",
              }}
            >
              {businessModelOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>

            <div
              style={{
                marginTop: 8,
                color: "var(--dz-text-muted)",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              {t("account.onboarding.modelHelp")}
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={loading}
            style={{
              width: "100%",
              padding: "14px 16px",
              borderRadius: 12,
              border: "1px solid var(--dz-text-primary)",
              background: TOKEN.action.primary.background,
              color: "var(--dz-text-on-brand)",
              cursor: loading ? "not-allowed" : "pointer",
              fontWeight: 700,
              fontSize: 15,
            }}
          >
            {loading ? t("account.onboarding.saving") : t("account.onboarding.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}