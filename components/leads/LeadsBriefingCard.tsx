"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getLeadBriefing, type LeadBriefing } from "@/lib/api/leads";
import { TOKEN } from "@/lib/design/tokens";
import { useI18n } from "@/components/i18n/I18nProvider";

const DS = TOKEN.dsv1;

/**
 * M5 — the Secretary's lead line: what in the sales pipeline needs you today.
 *
 * One canonical source (GET /api/leads/briefing → the lead attention contract),
 * counts first, then the few leads that matter most, each saying whether its
 * reason is a FACT or an INFERENCE and — separately — what Dubiz proposes.
 * Read-only: it links to the lead; it never changes a stage, sends a message
 * or contacts anyone. Silent when there is nothing to say.
 */
export function LeadsBriefingCard() {
  const { t } = useI18n();
  const [briefing, setBriefing] = useState<LeadBriefing | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLeadBriefing()
      .then((b) => {
        if (!cancelled) setBriefing(b);
      })
      .catch(() => {
        // The payment Secretary must keep working if this section cannot load.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const arrivals = briefing?.arrivals;
  const calls = briefing?.calls;
  const owedCalls = calls ? calls.unreturned.knownCustomers + calls.unreturned.unknownNumbers : 0;
  const commerce = briefing?.commerce;
  const storeExceptions = commerce ? commerce.reversals.total + commerce.connections.length : 0;
  if (!briefing || (briefing.counts.needsAttention === 0 && !arrivals?.today && owedCalls === 0 && storeExceptions === 0)) return null;
  const c = briefing.counts;
  const lines: string[] = [];
  // M6 — today's arrivals with their sources ("3 מפייסבוק/אינסטגרם, 2 מגוגל"): context, not a separate inbox.
  if (arrivals && arrivals.today > 0) {
    const sources = arrivals.bySource.length > 1 || (arrivals.bySource[0] && arrivals.bySource[0].group !== "manual")
      ? " · " + arrivals.bySource.map((s) => (s.group === "manual" ? `${s.count} ${s.label}` : t("customers.leads.briefing.fromSource", { count: s.count, label: s.label }))).join(", ")
      : "";
    lines.push(
      arrivals.today === 1
        ? t("customers.leads.briefing.arrivalsOne", { sources })
        : t("customers.leads.briefing.arrivalsMany", { count: arrivals.today, sources })
    );
  }
  if (c.CUSTOMER_CALLED) lines.push(t("customers.leads.briefing.customerCalled", { count: c.CUSTOMER_CALLED }));
  // M7-A — calls nobody returned (known customers vs numbers Dubiz does not know). Never a number.
  if (calls && calls.unreturned.unknownNumbers > 0) {
    lines.push(
      calls.unreturned.unknownNumbers === 1
        ? t("customers.leads.briefing.unknownCallerOne")
        : t("customers.leads.briefing.unknownCallerMany", { count: calls.unreturned.unknownNumbers })
    );
  }
  // M7-B / M7-C — exceptions only: a cancel / refund on a customer with an open lead, a connection to fix.
  if (commerce && commerce.reversals.total > 0) {
    lines.push(
      commerce.reversals.total === 1
        ? t("customers.leads.briefing.reversalOne")
        : t("customers.leads.briefing.reversalMany", { count: commerce.reversals.total })
    );
  }
  if (commerce && commerce.connections.length > 0) {
    lines.push(
      commerce.connections.length === 1
        ? t("customers.leads.briefing.connectionOne")
        : t("customers.leads.briefing.connectionMany", { count: commerce.connections.length })
    );
  }
  if (c.CUSTOMER_WROTE) lines.push(t("customers.leads.briefing.customerWrote", { count: c.CUSTOMER_WROTE }));
  if (c.FOLLOWUP_OVERDUE) lines.push(t("customers.leads.briefing.followUpOverdue", { count: c.FOLLOWUP_OVERDUE }));
  if (c.FOLLOWUP_DUE_TODAY) lines.push(t("customers.leads.briefing.followUpDueToday", { count: c.FOLLOWUP_DUE_TODAY }));
  if (c.NEW_UNHANDLED) lines.push(t("customers.leads.briefing.newUnhandled", { count: c.NEW_UNHANDLED }));
  if (c.AWAITING_OWNER_DECISION) lines.push(t("customers.leads.briefing.awaitingDecision", { count: c.AWAITING_OWNER_DECISION }));
  if (c.QUOTE_NO_ACTIVITY) lines.push(t("customers.leads.briefing.quoteNoActivity", { count: c.QUOTE_NO_ACTIVITY }));
  if (c.STALLED) lines.push(t("customers.leads.briefing.stalled", { count: c.STALLED }));

  return (
    <section
      aria-label={t("customers.leads.briefing.ariaLabel")}
      style={{
        margin: "16px auto",
        width: "min(100% - 32px, 720px)",
        boxSizing: "border-box",
        background: DS.card,
        border: `1px solid ${DS.line}`,
        borderRadius: 16,
        padding: 16,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 17, color: DS.ink }}>{t("customers.leads.briefing.title")}</h2>
      <ul style={{ margin: "8px 0 12px", paddingInlineStart: 18, color: DS.ink, lineHeight: 1.7 }}>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <div style={{ display: "grid", gap: 8 }}>
        {briefing.items.map((item) => (
          <Link
            key={item.leadId}
            href={item.href}
            style={{
              display: "block",
              textDecoration: "none",
              color: DS.ink,
              background: DS.surface2,
              borderRadius: 12,
              padding: "10px 12px",
            }}
          >
            <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
              <bdi>{item.name}</bdi> — {item.label}
            </div>
            <div style={{ color: DS.muted, fontSize: 14 }}>
              {item.evidenceClass === "fact" ? t("customers.leads.common.fact") : t("customers.leads.common.inference")}
              {item.summary ? ` · ${item.summary}` : ""}
            </div>
            {item.suggestion ? (
              <div style={{ color: DS.accent, fontSize: 14 }}>{t("customers.leads.common.dubizSuggests", { label: item.suggestion.label })}</div>
            ) : null}
          </Link>
        ))}
      </div>
      {!briefing.complete ? (
        <p style={{ margin: "8px 0 0", color: DS.tertiary, fontSize: 13 }}>
          {t("customers.leads.briefing.incomplete")}
        </p>
      ) : null}
      <Link href="/attention" style={{ display: "inline-block", marginTop: 12, color: DS.accent }}>
        {t("customers.leads.briefing.toQueue")}
      </Link>
    </section>
  );
}
