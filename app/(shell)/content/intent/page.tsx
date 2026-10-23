"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";
import { useI18n } from "@/components/i18n/I18nProvider";

function ContentIntentPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useI18n();

  const goal = params.get("goal") || "";
  const goalDescription = params.get("goalDescription") || "";

  const [intent, setIntent] = useState("");

  function next() {
    if (!intent) return;

    router.push(
      `/content/mode?goal=${encodeURIComponent(
        goal
      )}&goalDescription=${encodeURIComponent(
        goalDescription
      )}&intent=${encodeURIComponent(intent)}`
    );
  }

  function card(val: string, text: string) {
    const selected = intent === val;

    return (
      <div onClick={() => setIntent(val)} style={btn(selected)}>
        {text}
      </div>
    );
  }

  return (
    <div style={baseStyles.page}>
      <Header title={t("content.studioFlow.intent.headerTitle")} />
      <ProgressBar progress={25} />

      <div style={baseStyles.container}>
        <h1 style={{ marginBottom: 8 }}>{t("content.studioFlow.intent.title")}</h1>

        <p style={{ marginBottom: 20, color: "var(--dz-text-secondary)" }}>
          {t("content.studioFlow.intent.subtitle")}
        </p>

        {card("message", t("content.studioFlow.intent.options.message"))}
        {card("call", t("content.studioFlow.intent.options.call"))}
        {card("follow", t("content.studioFlow.intent.options.follow"))}
        {card("watch", t("content.studioFlow.intent.options.watch"))}
      </div>

      <div style={baseStyles.footer}>
        <button
          style={{
            ...baseStyles.cta,
            opacity: intent ? 1 : 0.5,
          }}
          onClick={next}
          disabled={!intent}
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
      <ContentIntentPageInner />
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