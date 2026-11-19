"use client";

import { useI18n } from "@/components/i18n/I18nProvider";
import BackButton from "@/components/ui/back-button";
import { EntityIcon } from "@/components/ui/entity/entity-icon";
import { TOOLS } from "@/lib/navigation/home-routes";
import { HOME_V4_CSS } from "@/features/home/v4/home-v4";
import { IconRetry } from "@/features/home/v4/home-v4-icons";
import { inactiveTools } from "@/features/home/v4/home-v4-model";
import { useHomeAccess } from "@/features/home/v4/use-home-access";

/**
 * "יכולות נוספות" (/tools/more) — the ONE place an owner discovers capabilities that are not active for the
 * business. Informational only: no row opens the capability (it is not active), and there is no price or
 * upgrade button — the product has no plan model, and how a capability gets turned on is an owner decision
 * still to be made (see the PR). The workspace never shows these as locked tiles.
 */
export function MoreCapabilitiesScreen() {
  const { t } = useI18n();
  const { access, retry } = useHomeAccess();
  const inactive = access.state === "ready" ? inactiveTools(TOOLS, access.value) : [];

  return (
    <div className="h4">
      <style>{HOME_V4_CSS}</style>
      <main className="h4-col h4-wide">
        <div style={{ paddingTop: 4 }}>
          <BackButton />
        </div>
        <header className="h4-header" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
          <h1 className="h4-name">{t("home.v4.more.title")}</h1>
          <p style={{ margin: 0, fontSize: 14, color: "var(--h4-muted)", lineHeight: 1.5 }}>{t("home.v4.more.intro")}</p>
        </header>
        {access.state === "loading" ? (
          <div className="h4-sk" style={{ height: 160, borderRadius: 24 }} aria-hidden />
        ) : access.state === "failed" ? (
          <div className="h4-note" role="status">
            <span>{t("home.v4.tools.failed")}</span>
            <button type="button" onClick={retry}>
              <IconRetry size={16} />
              {t("home.v4.tools.retry")}
            </button>
          </div>
        ) : inactive.length === 0 ? (
          <div className="h4-card" role="status" style={{ fontSize: 15 }}>{t("home.v4.more.empty")}</div>
        ) : (
          <ul className="h4-card" style={{ listStyle: "none", margin: 0, padding: "4px 16px" }}>
            {inactive.map((tool, i) => (
              <li key={tool.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 0", borderTop: i === 0 ? 0 : "1px solid var(--h4-line)" }}>
                <span style={{ opacity: 0.75 }}>
                  <EntityIcon entity={tool.entity} size={30} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 15, fontWeight: 700 }}>{t(tool.labelKey)}</span>
                  <span style={{ display: "block", fontSize: 13, color: "var(--h4-muted)" }}>{t(tool.descriptionKey)}</span>
                </span>
                <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 999, background: "#EFEDE6", color: "var(--h4-muted)" }}>
                  {tool.comingSoon ? t("home.v4.more.comingSoon") : t("home.v4.more.inactive")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
