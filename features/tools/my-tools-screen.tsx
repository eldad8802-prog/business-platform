"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { EntityIcon } from "@/components/ui/entity/entity-icon";
import { TOOLS, TOOL_GROUPS, type Tool } from "@/lib/navigation/home-routes";
import { HOME_V4_CSS } from "@/features/home/v4/home-v4";
import { useHomePref } from "@/features/home/v4/home-prefs";
import { IconChevronForward, IconRetry } from "@/features/home/v4/home-v4-icons";
import { SIMPLE_TOOLS_MAX, availableTools, favoriteTools } from "@/features/home/v4/home-v4-model";
import { useHomeAccess } from "@/features/home/v4/use-home-access";

const TOOLS_CSS = `
.mt-sub { margin:2px 0 0; font-size:14px; color:var(--h4-muted); }
.mt-search { width:100%; min-height:48px; padding:10px 16px; border-radius:999px; border:1px solid var(--h4-line); background:var(--h4-card); font:inherit; font-size:16px; color:var(--h4-ink); }
.mt-search::placeholder { color:#8A928B; }
.mt-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:10px; margin-top:10px; }
.mt-tile { position:relative; height:100%; display:flex; flex-direction:column; align-items:flex-start; gap:10px; min-height:104px; padding:14px; border-radius:20px; background:var(--h4-card); border:1px solid rgba(227,229,221,.8); box-shadow:var(--h4-shadow); color:var(--h4-ink); text-decoration:none; }
.mt-tile-name { font-size:15px; font-weight:700; line-height:1.25; overflow-wrap:anywhere; }
.mt-tile-desc { font-size:12.5px; color:var(--h4-muted); line-height:1.35; }
.mt-star { position:absolute; top:6px; inset-inline-end:6px; width:40px; height:40px; border:0; border-radius:999px; background:transparent; color:#B9A15A; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:20px; }
.mt-sec { margin-top:18px; }
.mt-sec-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.mt-sec-title { margin:0; font-size:16px; font-weight:700; }
.mt-more { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:22px; padding:16px; border-radius:20px; background:transparent; border:1px dashed var(--h4-sage-2); color:var(--h4-ink); text-decoration:none; }
.mt-more-title { font-size:15px; font-weight:700; }
.mt-more-body { font-size:13px; color:var(--h4-muted); }
`;

/**
 * "הכלים שלי" (/tools) — the bottom bar's "כלים" tab (HOME v4).
 *
 * Shows ONLY tools the business can open now: the tool registry (lib/navigation/home-routes.ts → TOOLS), minus
 * every tool whose platform feature is OFF and every "coming soon" entry (`availableTools`). The layout follows
 * the count: up to SIMPLE_TOOLS_MAX tools → one clean grid; more → favourites on top, search, and the families
 * that actually have tools (an empty family is never drawn). Capabilities that are not active live behind the
 * separate "יכולות נוספות" entry — never as locked tiles here.
 */
export function MyToolsScreen() {
  const { t } = useI18n();
  const { access, retry } = useHomeAccess();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const businessId = access.state === "ready" ? access.value.businessId : null;
  const [chosenFavs, setChosenFavs] = useHomePref<string[] | null>(businessId, "tools.favorites", null);

  const available = useMemo(() => (access.state === "ready" ? availableTools(TOOLS, access.value) : []), [access]);
  const simple = available.length <= SIMPLE_TOOLS_MAX;
  const favorites = access.state === "ready" ? favoriteTools(available, access.value.kind, chosenFavs) : [];
  const favKeys = favorites.map((f) => f.key);
  const q = query.trim().toLowerCase();
  const matches = (tool: Tool) => !q || t(tool.labelKey).toLowerCase().includes(q) || t(tool.descriptionKey).toLowerCase().includes(q);

  const toggleFav = (key: string) => setChosenFavs(favKeys.includes(key) ? favKeys.filter((k) => k !== key) : [...favKeys, key]);

  const tile = (tool: Tool) => (
    <div key={tool.key} style={{ position: "relative" }}>
      <Link href={tool.href} prefetch={false} className="mt-tile">
        <EntityIcon entity={tool.entity} size={32} />
        <span>
          <span className="mt-tile-name" style={{ display: "block" }}>{t(tool.labelKey)}</span>
          <span className="mt-tile-desc" style={{ display: "block" }}>{t(tool.descriptionKey)}</span>
        </span>
      </Link>
      {editing ? (
        <button
          type="button"
          className="mt-star"
          aria-pressed={favKeys.includes(tool.key)}
          aria-label={favKeys.includes(tool.key) ? t("home.v4.tools.removeFavorite", { name: t(tool.labelKey) }) : t("home.v4.tools.addFavorite", { name: t(tool.labelKey) })}
          onClick={() => toggleFav(tool.key)}
        >
          {favKeys.includes(tool.key) ? "★" : "☆"}
        </button>
      ) : null}
    </div>
  );

  let body: React.ReactNode;
  if (access.state === "loading") {
    body = (
      <div className="mt-grid" role="status" aria-label={t("home.v4.tools.loading")}>
        {[0, 1, 2, 3].map((i) => <div key={i} className="h4-sk" style={{ height: 104, borderRadius: 20 }} />)}
      </div>
    );
  } else if (access.state === "failed") {
    body = (
      <div className="h4-note" role="status">
        <span>{t("home.v4.tools.failed")}</span>
        <button type="button" onClick={retry}>
          <IconRetry size={16} />
          {t("home.v4.tools.retry")}
        </button>
      </div>
    );
  } else if (simple) {
    body = <div className="mt-grid">{available.map(tile)}</div>;
  } else {
    const groups = TOOL_GROUPS.map((g) => ({ g, tools: available.filter((tool) => tool.group === g.key && matches(tool)) })).filter((x) => x.tools.length > 0);
    body = (
      <>
        <input className="mt-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("home.v4.tools.search")} aria-label={t("home.v4.tools.search")} enterKeyHint="search" />
        {!q && favorites.length > 0 ? (
          <section className="mt-sec" aria-labelledby="mt-fav">
            <div className="mt-sec-head">
              <h2 className="mt-sec-title" id="mt-fav">{t("home.v4.tools.favorites")}</h2>
              <button type="button" className="h4-textbtn" onClick={() => setEditing((v) => !v)} aria-pressed={editing}>
                {editing ? t("home.v4.tools.done") : t("home.v4.tools.edit")}
              </button>
            </div>
            <div className="mt-grid">{favorites.map(tile)}</div>
          </section>
        ) : null}
        {groups.map(({ g, tools }) => (
          <section key={g.key} className="mt-sec" aria-labelledby={`mt-g-${g.key}`}>
            <h2 className="mt-sec-title" id={`mt-g-${g.key}`}>{t(g.labelKey)}</h2>
            <div className="mt-grid">{tools.map(tile)}</div>
          </section>
        ))}
        {groups.length === 0 ? <p className="mt-sub" role="status" style={{ marginTop: 16 }}>{t("home.v4.tools.noResults")}</p> : null}
      </>
    );
  }

  return (
    <div className="h4">
      <style>{HOME_V4_CSS + TOOLS_CSS}</style>
      <main className="h4-col">
        <header className="h4-header" style={{ flexDirection: "column", alignItems: "stretch", gap: 0 }}>
          <h1 className="h4-name">{t("home.v4.tools.title")}</h1>
          {access.state === "ready" ? (
            <p className="mt-sub">{available.length === 1 ? t("home.v4.tools.countOne") : t("home.v4.tools.countMany", { count: available.length })}</p>
          ) : null}
        </header>
        <div>
          {body}
          <Link href="/tools/more" prefetch={false} className="mt-more">
            <span>
              <span className="mt-more-title" style={{ display: "block" }}>{t("home.v4.tools.more")}</span>
              <span className="mt-more-body" style={{ display: "block" }}>{t("home.v4.tools.moreBody")}</span>
            </span>
            <IconChevronForward size={22} />
          </Link>
        </div>
      </main>
    </div>
  );
}
