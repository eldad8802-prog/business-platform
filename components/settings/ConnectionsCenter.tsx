"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Link from "next/link";

import { useI18n } from "@/components/i18n/I18nProvider";
import { getClientAuthToken } from "@/lib/client-session";
import type { MessageKey } from "@/lib/i18n/translate";
import {
  assembleConnectionsCenter,
  unavailableCards,
  type ConnectionCard,
  type ConnectionCategory,
  type ConnectionLink,
  type ConnectionsCenter,
  type ConnectionSourceId,
  type ConnectionState,
} from "@/lib/services/connections/connections-center.model";

import { stamp } from "./LeadSourcesPanel";

/**
 * Settings → Connections — the unified overview (S1-B · M1).
 *
 * Reads GET /api/settings/connections-center once (the same bearer the panels below use) and shows:
 *   - at the top: how many connections are live, how many need the owner, and the "דורש טיפול"
 *     list — an item with a working fix carries a button to it; an info-only item has none;
 *   - per category: one compact status row per connection, above the EXISTING management
 *     component for that category (placed by the page, unchanged).
 *
 * It only reads. Connecting, pausing and disconnecting stay in the existing panels and screens.
 * If the overview cannot load, the panels below still work on their own; the WhatsApp / Gmail
 * rows then fall back to "לא הצלחנו לבדוק כרגע" with their manage link, so no screen is lost.
 */

type Load = { state: "loading" } | { state: "error"; center: ConnectionsCenter } | { state: "ready"; center: ConnectionsCenter };

/** What the page shows when the whole overview failed: the always-reachable screens, unchecked. */
const FALLBACK_SOURCES: ConnectionSourceId[] = ["gmail", "whatsapp"];
const fallbackCenter = (): ConnectionsCenter =>
  assembleConnectionsCenter(FALLBACK_SOURCES.flatMap(unavailableCards), FALLBACK_SOURCES);

const Ctx = createContext<{ load: Load; reload: () => void }>({ load: { state: "loading" }, reload: () => {} });

export function ConnectionsCenterProvider({ children }: { children: React.ReactNode }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    const token = getClientAuthToken();
    fetch("/api/settings/connections-center", {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as ConnectionsCenter;
      })
      .then(
        (center) => live && setLoad({ state: "ready", center }),
        () => live && setLoad({ state: "error", center: fallbackCenter() })
      );
    return () => {
      live = false;
    };
  }, [nonce]);

  const reload = useCallback(() => {
    setLoad({ state: "loading" });
    setNonce((n) => n + 1);
  }, []);

  return <Ctx.Provider value={{ load, reload }}>{children}</Ctx.Provider>;
}

const STATE: Record<ConnectionState, { label: MessageKey; tone: string }> = {
  connected: { label: "account.settings.connections.center.state.connected", tone: "bg-[var(--dz-success-bg-soft)] text-[var(--dz-success)]" },
  attention: { label: "account.settings.connections.center.state.attention", tone: "bg-[var(--dz-danger-bg-soft)] text-[var(--dz-danger)]" },
  paused: { label: "account.settings.connections.center.state.paused", tone: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-muted)]" },
  disconnected: { label: "account.settings.connections.center.state.disconnected", tone: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-muted)]" },
  unavailable: { label: "account.settings.connections.center.state.unavailable", tone: "bg-[var(--dz-surface-muted)] text-[var(--dz-text-muted)]" },
};

/** An in-page anchor stays a plain <a> (smooth jump to the panel); a screen goes through the router. */
function Go({ link, primary, children }: { link: ConnectionLink; primary?: boolean; children: React.ReactNode }) {
  const tone = primary
    ? "rounded-full bg-[var(--dz-brand)] px-4 text-[var(--dz-text-on-brand)]"
    : "text-[var(--dz-text-secondary)] underline-offset-4 hover:underline";
  const className = `inline-flex min-h-11 shrink-0 items-center text-xs font-bold ${tone}`;
  return link.href.startsWith("#") ? (
    <a href={link.href} className={className}>
      {children}
    </a>
  ) : (
    <Link href={link.href} className={className}>
      {children}
    </Link>
  );
}

/** The owner's own email / number / label, isolated so an LTR address never reorders the Hebrew name. */
function AccountLabel({ label, small }: { label: string | null; small?: boolean }) {
  if (!label) return null;
  return (
    <span className={`font-normal text-[var(--dz-text-muted)] ${small ? "text-xs" : ""}`}>
      <span aria-hidden> · </span>
      <bdi>{label}</bdi>
    </span>
  );
}

function cardName(t: (k: MessageKey) => string, c: ConnectionCard) {
  return t(c.nameKey);
}

export function ConnectionsOverview() {
  const { t } = useI18n();
  const { load, reload } = useContext(Ctx);

  if (load.state === "loading") {
    return (
      <section className="mb-4 rounded-[24px] dz-mist p-4 shadow-sm" aria-busy="true">
        <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">{t("account.settings.connections.center.title")}</h2>
        <p className="sr-only">{t("account.settings.connections.center.loading")}</p>
        <div className="mt-3 space-y-2" aria-hidden>
          <div className="h-5 w-1/2 animate-pulse rounded-full bg-[var(--dz-surface-muted)]" />
          <div className="h-12 animate-pulse rounded-2xl bg-[var(--dz-surface-muted)]" />
        </div>
      </section>
    );
  }

  if (load.state === "error") {
    return (
      <section className="mb-4 rounded-[24px] dz-mist p-4 shadow-sm">
        <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">{t("account.settings.connections.center.title")}</h2>
        <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">{t("account.settings.connections.center.loadError")}</p>
        <button
          type="button"
          onClick={reload}
          className="mt-2 inline-flex min-h-11 items-center rounded-full border border-[var(--dz-border)] px-4 text-xs font-bold text-[var(--dz-text-primary)]"
        >
          {t("account.settings.connections.center.retry")}
        </button>
      </section>
    );
  }

  const { center } = load;
  const cards = center.categories.flatMap((g) => g.cards);
  const actions = cards.filter((c) => c.attention?.kind === "action");
  const infos = cards.filter((c) => c.attention?.kind === "info");
  const empty = center.counts.connected === 0 && actions.length === 0 && infos.length === 0;

  return (
    <section className="mb-4 rounded-[24px] dz-mist p-4 shadow-sm">
      <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">{t("account.settings.connections.center.title")}</h2>
      <p className="mt-1 text-base font-bold text-[var(--dz-text-primary)]">
        {t("account.settings.connections.center.summary", { connected: center.counts.connected, needsAction: center.counts.needsAction })}
      </p>
      {center.unavailableSources.length ? (
        <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">{t("account.settings.connections.center.partial")}</p>
      ) : null}

      {empty ? (
        <div className="mt-3 rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface-flat)] p-3">
          <p className="text-sm font-bold text-[var(--dz-text-primary)]">{t("account.settings.connections.center.emptyTitle")}</p>
          <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">{t("account.settings.connections.center.emptyBody")}</p>
        </div>
      ) : actions.length === 0 && infos.length === 0 ? (
        <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">{t("account.settings.connections.center.allGood")}</p>
      ) : null}

      {actions.length ? (
        <div className="mt-3">
          <h3 className="text-xs font-bold text-[var(--dz-danger)]">{t("account.settings.connections.center.needsActionTitle")}</h3>
          <ul className="mt-2 space-y-2">
            {actions.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface-flat)] px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-bold text-[var(--dz-text-primary)]">
                    {cardName(t, c)}
                    <AccountLabel label={c.accountLabel} />
                  </div>
                  <p className="mt-0.5 text-[11px] leading-5 text-[var(--dz-danger)]">{t(c.attention!.textKey)}</p>
                </div>
                {c.attention!.action ? (
                  <Go link={c.attention!.action} primary>
                    {t(c.attention!.action.labelKey)}
                  </Go>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {infos.length ? (
        <div className="mt-3">
          <h3 className="text-xs font-bold text-[var(--dz-text-muted)]">{t("account.settings.connections.center.infoTitle")}</h3>
          <ul className="mt-2 space-y-1">
            {infos.map((c) => (
              <li key={c.id} className="rounded-2xl bg-[var(--dz-surface-muted)] px-3 py-2">
                <div className="truncate text-xs font-bold text-[var(--dz-text-primary)]">
                  {cardName(t, c)}
                  <AccountLabel label={c.accountLabel} />
                </div>
                <p className="mt-0.5 text-[11px] leading-5 text-[var(--dz-text-muted)]">{t(c.attention!.textKey)}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function StatusRow({ c }: { c: ConnectionCard }) {
  const { t, locale } = useI18n();
  const state = STATE[c.state];
  return (
    <div className="rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface-flat)] px-3 py-2" data-connection-card={c.id}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-[var(--dz-text-primary)]">
            {t(c.nameKey)}
            <AccountLabel label={c.accountLabel} small />
          </div>
          {c.lastActivity ? (
            <div className="text-[11px] text-[var(--dz-text-muted)]">
              {t("account.settings.connections.center.activityAt", { label: t(c.lastActivity.labelKey), at: stamp(c.lastActivity.at, locale) })}
            </div>
          ) : null}
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${state.tone}`}>{t(state.label)}</span>
      </div>
      {c.errorKey ? (
        <p className={`mt-1 text-[11px] font-bold ${c.state === "unavailable" ? "text-[var(--dz-text-muted)]" : "text-[var(--dz-danger)]"}`}>{t(c.errorKey)}</p>
      ) : null}
      {c.provides.length || c.manage ? (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          {c.provides.length ? (
            <ul className="flex min-w-0 flex-wrap items-center gap-1" aria-label={t("account.settings.connections.center.providesLabel")}>
              {c.provides.map((p) => (
                <li key={p} className="rounded-full bg-[var(--dz-surface-muted)] px-2 py-0.5 text-[11px] text-[var(--dz-text-secondary)]">
                  {t(p)}
                </li>
              ))}
            </ul>
          ) : (
            <span />
          )}
          {c.manage ? <Go link={c.manage}>{t(c.manage.labelKey)}</Go> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One category: its heading, the read model's status rows, then the existing management
 * component (children) unchanged. A category with no management component and no cards is not
 * rendered; one with a management component always is (as before), even while loading.
 */
export function ConnectionCategorySection({
  category,
  anchorId,
  wide,
  children,
}: {
  category: ConnectionCategory;
  anchorId?: string;
  /** Spans both desktop columns (the lead / store panels were full-width before). */
  wide?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const { load } = useContext(Ctx);
  const group = load.state === "loading" ? null : load.center.categories.find((g) => g.category === category) ?? null;
  const cards = group?.cards ?? [];
  if (!children && cards.length === 0) return null;
  const titleKey = group?.titleKey ?? (`account.settings.connections.center.categories.${category === "stores_calls" ? "storesCalls" : category}` as MessageKey);
  return (
    <section id={anchorId} className={`flex scroll-mt-4 flex-col gap-3 ${wide ? "min-[1200px]:col-span-2" : ""}`} data-connection-category={category}>
      <h2 className="px-1 text-base font-bold text-[var(--dz-text-primary)]">{t(titleKey)}</h2>
      {cards.length ? (
        <div className="space-y-2">
          {cards.map((c) => (
            <StatusRow key={c.id} c={c} />
          ))}
        </div>
      ) : null}
      {children}
    </section>
  );
}
