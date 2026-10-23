"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";
import { useI18n } from "@/components/i18n/I18nProvider";

function ContentStylePageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useI18n();

  const goal = params.get("goal");
  const intent = params.get("intent");
  const value = params.get("value");

  const [style, setStyle] = useState("");

  function next() {
    if (!style) return;

    router.push(
      `/content/mode?goal=${goal}&intent=${intent}&value=${value}&style=${style}`
    );
  }

  function card(val: string, text: string) {
    const selected = style === val;

    return (
      <div onClick={() => setStyle(val)} style={btn(selected)}>
        {text}
      </div>
    );
  }

  return (
    <div style={baseStyles.page}>
      <ProgressBar progress={50} />

      <div style={baseStyles.container}>
        <h1>{t("content.studioFlow.style.title")}</h1>

        {card("direct", t("content.studioFlow.flow.styles.direct"))}
        {card("emotional", t("content.studioFlow.flow.styles.emotional"))}
        {card("authority", t("content.studioFlow.flow.styles.professional"))}
      </div>

      <div style={baseStyles.footer}>
        <button style={baseStyles.cta} onClick={next}>
          {t("content.studioFlow.common.continue")}
        </button>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ContentStylePageInner />
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