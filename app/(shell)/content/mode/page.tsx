"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";
import { useI18n } from "@/components/i18n/I18nProvider";

function ContentModePageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useI18n();

  const goal = params.get("goal") || "";
  const goalDescription = params.get("goalDescription") || "";
  const intent = params.get("intent") || "";

  const [mode, setMode] = useState("");

  function next() {
    if (!mode) return;

    router.push(
      `/content/context?goal=${encodeURIComponent(
        goal
      )}&goalDescription=${encodeURIComponent(
        goalDescription
      )}&intent=${encodeURIComponent(intent)}&mode=${encodeURIComponent(mode)}`
    );
  }

  function card(val: string, title: string, description: string) {
    const selected = mode === val;

    return (
      <div onClick={() => setMode(val)} style={btn(selected)}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 14, color: "var(--dz-text-secondary)" }}>{description}</div>
      </div>
    );
  }

  return (
    <div style={baseStyles.page}>
      <Header title={t("content.studioFlow.mode.headerTitle")} />
      <ProgressBar progress={50} />

      <div style={baseStyles.container}>
        <h1 style={{ marginBottom: 8 }}>{t("content.studioFlow.mode.title")}</h1>

        <p style={{ marginBottom: 20, color: "var(--dz-text-secondary)" }}>
          {t("content.studioFlow.mode.subtitle")}
        </p>

        {card("camera", t("content.studioFlow.mode.options.camera.title"), t("content.studioFlow.mode.options.camera.description"))}
        {card("voice", t("content.studioFlow.mode.options.voice.title"), t("content.studioFlow.mode.options.voice.description"))}
        {card("ai", t("content.studioFlow.mode.options.ai.title"), t("content.studioFlow.mode.options.ai.description"))}
      </div>

      <div style={baseStyles.footer}>
        <button
          style={{
            ...baseStyles.cta,
            opacity: mode ? 1 : 0.5,
          }}
          onClick={next}
          disabled={!mode}
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
      <ContentModePageInner />
    </Suspense>
  );
}

const btn = (selected: boolean) => ({
  padding: 14,
  borderRadius: 12,
  border: selected ? "2px solid var(--dz-text-primary)" : "1px solid var(--dz-border)",
  marginTop: 10,
  cursor: "pointer",
});