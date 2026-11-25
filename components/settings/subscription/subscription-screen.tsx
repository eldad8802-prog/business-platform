"use client";

/**
 * "המנוי שלי" — the owner's subscription screen (subscriptions stage C).
 *
 * Owner decision 2026-11-25 (display only): clean and simple. NO counters, quotas, progress bars or percentages on a
 * permanent basis. The quota mechanism runs behind the scenes; this screen shows
 *   - the plan / trial / limited state as plain facts (the trial's end as a date, never a countdown bar);
 *   - a message ONLY when attention or action is needed (trial ending within 7 days, limited mode, an enforced quota
 *     nearly or fully used) — each with its one action;
 *   - the plans and their terms (each plan's limits), to read BEFORE choosing a plan;
 *   - the rights floor, always.
 * "Choosing a plan" is a request to the Dubiz team — no payment, no automatic charge. Premium is "בקרוב".
 * Data: GET /api/business/subscription (no counters in it), POST /api/business/subscription/requests.
 */
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";
import type { PlanTerm, SubscriptionAttention, SubscriptionView } from "@/lib/services/subscriptions/subscription-view.service";

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; view: SubscriptionView };
type Send = { state: "idle" } | { state: "sending"; key: string } | { state: "sent" } | { state: "open" } | { state: "failed" };

const card = "rounded-3xl border border-[var(--dz-border)] bg-[var(--dz-surface-raised-flat)] p-4 shadow-sm";
const primary =
  "flex min-h-12 w-full items-center justify-center rounded-2xl bg-[var(--dz-brand)] px-4 text-base font-semibold text-[var(--dz-text-on-brand)] hover:bg-[var(--dz-brand-hover)] disabled:opacity-60";
const secondary =
  "flex min-h-11 items-center justify-center rounded-2xl border border-[var(--dz-brand-border)] bg-[var(--dz-surface-raised-flat)] px-4 text-sm font-semibold text-[var(--dz-brand)] disabled:opacity-60";

export function SubscriptionScreen() {
  const { t, locale } = useI18n();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [send, setSend] = useState<Send>({ state: "idle" });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/business/subscription", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setLoad({ state: "ready", view: (await res.json()) as SubscriptionView });
    } catch {
      setLoad({ state: "error" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(locale === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "long", timeZone: "Asia/Jerusalem" });

  async function request(body: Record<string, string>, key: string) {
    setSend({ state: "sending", key });
    try {
      const res = await fetch("/api/business/subscription/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { created?: boolean; alreadyOpen?: boolean };
      setSend({ state: json.alreadyOpen ? "open" : "sent" });
      void refresh();
    } catch {
      setSend({ state: "failed" });
    }
  }

  if (load.state === "loading") {
    return (
      <p role="status" className="px-1 py-6 text-center text-sm text-[var(--dz-text-muted)]">
        {t("account.settings.subscriptionPage.loading")}
      </p>
    );
  }
  if (load.state === "error") {
    return (
      <p role="alert" className={`${card} text-sm text-[var(--dz-text-secondary)]`}>
        {t("account.settings.subscriptionPage.unavailable")}
      </p>
    );
  }
  const view = load.view;
  if (!view.visible) {
    return <p className={`${card} text-sm text-[var(--dz-text-secondary)]`}>{t("account.settings.subscriptionPage.none")}</p>;
  }

  const busy = send.state === "sending";
  const hasOpenRequest = view.openRequest !== null;

  return (
    <div className="flex flex-col gap-4">
      <PlanCard view={view} date={date} />

      {view.attention.length > 0 ? (
        <section aria-labelledby="subscription-attention" className="flex flex-col gap-3">
          <h2 id="subscription-attention" className="px-1 text-sm font-semibold text-[var(--dz-warning)]">
            {t("account.settings.subscriptionPage.attentionTitle")}
          </h2>
          {view.attention.map((item, i) => (
            <AttentionCard
              key={`${item.kind}-${i}`}
              item={item}
              date={date}
              busy={busy || hasOpenRequest}
              onRequestMore={(metric) => void request({ kind: "QUOTA", metric }, `quota:${metric}`)}
            />
          ))}
        </section>
      ) : null}

      <SendState send={send} hasOpenRequest={hasOpenRequest} />

      <section aria-labelledby="subscription-plans" className="flex flex-col gap-3">
        <div className="px-1">
          <h2 id="subscription-plans" className="text-base font-bold text-[var(--dz-text-primary)]">
            {t("account.settings.subscriptionPage.plansTitle")}
          </h2>
          <p className="mt-1 text-sm text-[var(--dz-text-secondary)]">{t("account.settings.subscriptionPage.plansIntro")}</p>
        </div>
        {view.plans.map((p) => {
          const current = view.status === "ACTIVE" && view.plan === p.plan;
          const name = t(`account.settings.subscriptionPage.plan.${p.plan}` as MessageKey);
          return (
            <article
              key={p.plan}
              className={`${card} flex flex-col gap-3 ${p.plan === "ADVANCED" ? "border-2 border-[var(--dz-brand)]" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg font-bold text-[var(--dz-text-primary)]">{name}</h3>
                {!p.open ? (
                  <span className="rounded-full border border-[var(--dz-warning-border)] bg-[var(--dz-warning-bg)] px-3 py-1 text-xs font-semibold text-[var(--dz-warning)]">
                    {t("account.settings.subscriptionPage.soon")}
                  </span>
                ) : p.plan === "ADVANCED" ? (
                  <span className="rounded-full bg-[var(--dz-brand-soft)] px-3 py-1 text-xs font-semibold text-[var(--dz-brand)]">
                    {t("account.settings.subscriptionPage.recommended")}
                  </span>
                ) : null}
              </div>
              <ul className="flex flex-col gap-1 ps-5 text-sm leading-relaxed text-[var(--dz-text-primary)] [list-style:disc]">
                {p.terms.map((term) => (
                  <li key={term.metric}>
                    <TermLine term={term} />
                  </li>
                ))}
              </ul>
              {p.open && !current ? (
                <button
                  type="button"
                  className={primary}
                  disabled={busy || hasOpenRequest}
                  aria-busy={send.state === "sending" && send.key === `plan:${p.plan}`}
                  onClick={() => void request({ kind: "PLAN", requestedPlan: p.plan }, `plan:${p.plan}`)}
                >
                  {send.state === "sending" && send.key === `plan:${p.plan}`
                    ? t("account.settings.subscriptionPage.sending")
                    : t("account.settings.subscriptionPage.requestPlan", { plan: name })}
                </button>
              ) : !p.open ? (
                <button type="button" disabled className="min-h-12 rounded-2xl border border-[var(--dz-border)] bg-[var(--dz-surface-muted)] text-sm text-[var(--dz-text-secondary)]">
                  {t("account.settings.subscriptionPage.opensLater")}
                </button>
              ) : null}
            </article>
          );
        })}
        <p className="px-1 text-center text-xs text-[var(--dz-text-muted)]">{t("account.settings.subscriptionPage.noCharge")}</p>
      </section>

      <p className="rounded-3xl border border-[var(--dz-brand-border)] bg-[var(--dz-brand-soft)] p-4 text-sm leading-relaxed text-[var(--dz-brand-hover)]">
        {t("account.settings.subscriptionPage.rightsFloor")}
      </p>
    </div>
  );
}

function PlanCard({ view, date }: { view: SubscriptionView; date: (iso: string) => string }) {
  const { t } = useI18n();
  const trialing = view.status === "TRIALING";
  const limited = view.status === "FREE_LIMITED";
  const name = trialing
    ? t("account.settings.subscriptionPage.trialName")
    : limited
      ? t("account.settings.subscriptionPage.limitedName")
      : view.plan
        ? t(`account.settings.subscriptionPage.plan.${view.plan}` as MessageKey)
        : "";
  const statusKey = trialing ? "trialing" : limited ? "limited" : view.status === "PAST_DUE" ? "pastDue" : "active";
  return (
    <section className={`${card} flex flex-col gap-2`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-[var(--dz-text-secondary)]">{t("account.settings.subscriptionPage.planLabel")}</span>
        <span className="rounded-full bg-[var(--dz-surface-muted)] px-3 py-1 text-xs font-semibold text-[var(--dz-text-secondary)]">
          {t(`account.settings.subscriptionPage.status.${statusKey}` as MessageKey)}
        </span>
      </div>
      <p className="text-2xl font-bold text-[var(--dz-text-primary)]">{name}</p>
      {trialing && view.trialEndsAt ? (
        <p className="text-sm text-[var(--dz-text-secondary)]">{t("account.settings.subscriptionPage.trialEnds", { date: date(view.trialEndsAt) })}</p>
      ) : null}
    </section>
  );
}

function AttentionCard({
  item,
  date,
  busy,
  onRequestMore,
}: {
  item: SubscriptionAttention;
  date: (iso: string) => string;
  busy: boolean;
  onRequestMore: (metric: string) => void;
}) {
  const { t } = useI18n();
  const box = "rounded-3xl border border-[var(--dz-warning-border)] bg-[var(--dz-warning-bg-soft)] p-4 text-sm leading-relaxed text-[var(--dz-text-primary)]";
  if (item.kind === "trial_ending") {
    return (
      <p className={box}>
        {item.daysLeft <= 1
          ? t("account.settings.subscriptionPage.attention.trialEndingToday")
          : t("account.settings.subscriptionPage.attention.trialEnding", { count: item.daysLeft })}
      </p>
    );
  }
  if (item.kind === "limited") return <p className={box}>{t("account.settings.subscriptionPage.attention.limited")}</p>;
  const text =
    item.kind === "quota_reached"
      ? t("account.settings.subscriptionPage.attention.quotaReached", { label: t(`account.settings.subscriptionPage.metric.${item.metric}` as MessageKey) })
      : t("account.settings.subscriptionPage.attention.quotaNear", { label: t(`account.settings.subscriptionPage.metric.${item.metric}` as MessageKey) });
  return (
    <div className={`${box} flex flex-col gap-3`}>
      <p>
        {text}
        {item.renewsAt ? ` ${t("account.settings.subscriptionPage.attention.renews", { date: date(item.renewsAt) })}` : null}
      </p>
      <button type="button" className={secondary} disabled={busy} onClick={() => onRequestMore(item.metric)}>
        {t("account.settings.subscriptionPage.attention.requestMore")}
      </button>
    </div>
  );
}

function TermLine({ term }: { term: PlanTerm }) {
  const { t, locale } = useI18n();
  const amount =
    term.unit === "byte"
      ? t("account.settings.subscriptionPage.gigabytes", { count: Math.round(term.quota / 1024 ** 3) })
      : term.quota.toLocaleString(locale === "he" ? "he-IL" : "en-GB");
  return (
    <>
      {term.cumulative
        ? t("account.settings.subscriptionPage.total", { amount, label: t(`account.settings.subscriptionPage.metric.${term.metric}` as MessageKey) })
        : t("account.settings.subscriptionPage.perMonth", { amount, label: t(`account.settings.subscriptionPage.metric.${term.metric}` as MessageKey) })}
    </>
  );
}

function SendState({ send, hasOpenRequest }: { send: Send; hasOpenRequest: boolean }) {
  const { t } = useI18n();
  const key =
    send.state === "sent"
      ? "account.settings.subscriptionPage.requestSent"
      : send.state === "failed"
        ? "account.settings.subscriptionPage.requestFailed"
        : send.state === "open" || hasOpenRequest
          ? "account.settings.subscriptionPage.requestOpen"
          : null;
  if (!key) return null;
  const failed = send.state === "failed";
  return (
    <p
      role={failed ? "alert" : "status"}
      className={`rounded-3xl border p-4 text-sm ${
        failed
          ? "border-[var(--dz-danger-border)] bg-[var(--dz-danger-bg-soft)] text-[var(--dz-danger)]"
          : "border-[var(--dz-success-border)] bg-[var(--dz-success-bg-soft)] text-[var(--dz-success)]"
      }`}
    >
      {t(key as MessageKey)}
    </p>
  );
}
