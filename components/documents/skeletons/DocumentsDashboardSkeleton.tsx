"use client";

import { card, cardSubText, cardTitle, iconWrap, metricTile } from "@/app/(shell)/documents/ui";
import { TOKEN } from "@/lib/design/documents-theme";
import {
  SkeletonBlock,
  skeletonBar,
} from "./skeleton-primitives";
import { useI18n } from "@/components/i18n/I18nProvider";

const cardHeaderRow = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 12,
};

export default function DocumentsDashboardSkeleton() {
  const { t } = useI18n();
  return (
    <SkeletonBlock>
      <div style={card}>
        <div style={cardHeaderRow}>
          <div style={iconWrap} aria-hidden>
            📊
          </div>
          <div style={cardTitle}>{t("documents.skeleton.summary")}</div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 10,
          }}
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={metricTile}>
              <div style={skeletonBar("55%", 12)} />
              <div style={{ ...skeletonBar("70%", 22), marginTop: 8 }} />
            </div>
          ))}
        </div>
      </div>

      <div style={card}>
        <div style={cardHeaderRow}>
          <div style={iconWrap} aria-hidden>
            📈
          </div>
          <div style={cardTitle}>{t("documents.skeleton.incomeVsExpense")}</div>
        </div>
        <div
          style={{
            width: "100%",
            height: 240,
            borderRadius: TOKEN.radius.card,
            background: TOKEN.surface.inset,
            animation: "documentsSkeletonPulse 1.2s ease-in-out infinite",
          }}
        />
        <div style={{ ...cardSubText, marginTop: 10 }}>
          <div style={skeletonBar("30%", 12)} />
        </div>
      </div>

      <div style={card}>
        <div style={cardHeaderRow}>
          <div style={iconWrap} aria-hidden>
            🧾
          </div>
          <div style={cardTitle}>{t("documents.skeleton.byCategory")}</div>
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto auto",
              gap: 10,
              padding: "10px 0",
              borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
            }}
          >
            <div style={skeletonBar("50%", 14)} />
            <div style={skeletonBar(72, 14)} />
            <div style={skeletonBar(40, 12)} />
          </div>
        ))}
      </div>
    </SkeletonBlock>
  );
}
