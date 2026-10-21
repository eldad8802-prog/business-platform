"use client";

import type { ReviewState } from "@/lib/documents/review/types";
import { TOKEN } from "@/lib/design/documents-theme";
import { useI18n } from "@/components/i18n/I18nProvider";

export default function ReviewHero({ state }: { state: ReviewState }) {
  const { t } = useI18n();
  return (
    <section style={{ textAlign: "center", padding: "22px 0 8px" }}>
      <h1
        style={{
          margin: 0,
          color: TOKEN.ink.primary,
          fontSize: 42,
          lineHeight: 1.2,
          fontWeight: 950,
          letterSpacing: 0,
        }}
      >
        {state === "done" ? t("documents.review.hero.titleDone") : t("documents.review.hero.title")}
      </h1>
      <p
        style={{
          margin: "12px auto 0",
          color: TOKEN.ink.muted,
          fontSize: 18,
          lineHeight: 1.6,
          fontWeight: 600,
          maxWidth: 560,
        }}
      >
        {state === "done"
          ? t("documents.review.hero.bodyDone")
          : t("documents.review.hero.body")}
      </p>
    </section>
  );
}
