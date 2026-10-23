"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";
import { useI18n } from "@/components/i18n/I18nProvider";

function ContentContextPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useI18n();

  const goal = params.get("goal") || "";
  const goalDescription = params.get("goalDescription") || "";
  const intent = params.get("intent") || "";
  const mode = params.get("mode") || "";

  const [audienceDescription, setAudienceDescription] = useState("");
  const [ageRange, setAgeRange] = useState("");

  const isValidEntry = useMemo(() => {
    return !!goal && !!goalDescription && !!intent && !!mode;
  }, [goal, goalDescription, intent, mode]);

  useEffect(() => {
    if (!isValidEntry) {
      router.replace("/content");
    }
  }, [isValidEntry, router]);

  function handleContinue() {
    if (!audienceDescription.trim() || !ageRange) return;

    const contentFlow = {
      goal,
      goalDescription,
      intent,
      mode,
      audienceDescription: audienceDescription.trim(),
      ageRange,
    };

    localStorage.setItem("content_flow", JSON.stringify(contentFlow));
    router.push("/content/direction");
  }

  return (
    <div style={baseStyles.page}>
      <Header title={t("content.studioFlow.flow.audience")} />
      <ProgressBar progress={75} />

      <div style={baseStyles.container}>
        <h1 style={{ marginBottom: 8 }}>{t("content.studioFlow.context.title")}</h1>

        <p style={{ marginBottom: 20, color: "var(--dz-text-secondary)" }}>
          {t("content.studioFlow.context.subtitle")}
        </p>

        <p style={{ marginBottom: 8, fontWeight: 600 }}>{t("content.studioFlow.context.audienceLabel")}</p>

        <textarea
          value={audienceDescription}
          onChange={(e) => setAudienceDescription(e.target.value)}
          placeholder={t("content.studioFlow.context.audiencePlaceholder")}
          style={{
            width: "100%",
            minHeight: 120,
            padding: 16,
            borderRadius: 12,
            border: "1px solid var(--dz-border)",
            fontSize: 14,
            marginBottom: 20,
          }}
        />

        <p style={{ marginBottom: 8, fontWeight: 600 }}>{t("content.studioFlow.context.ageRange")}</p>

        {["18-25", "25-35", "35-50", "50+"].map((range) => (
          <div
            key={range}
            onClick={() => setAgeRange(range)}
            style={buttonStyle(ageRange === range)}
          >
            {range}
          </div>
        ))}
      </div>

      <div style={baseStyles.footer}>
        <button
          style={{
            ...baseStyles.cta,
            opacity: audienceDescription.trim() && ageRange ? 1 : 0.5,
          }}
          onClick={handleContinue}
          disabled={!audienceDescription.trim() || !ageRange}
        >
          {t("content.studioFlow.common.continue")}
        </button>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ContentContextPageInner />
    </Suspense>
  );
}

const buttonStyle = (selected: boolean) => ({
  padding: 12,
  borderRadius: 10,
  border: selected ? "2px solid var(--dz-text-primary)" : "1px solid var(--dz-border)",
  marginTop: 10,
  cursor: "pointer",
});