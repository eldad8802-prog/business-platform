"use client";

/**
 * The Settings hub (approved reference: settings.html).
 *
 * Three compositions (settings-hub.module.css):
 *   mobile   the 390px reference — account card, five groups, sign-out
 *   tablet   the groups flow into two columns under the account card
 *   desktop  an account band that also states what is set up (signed-in
 *            email, business-details completion, live connections), over three
 *            columns of groups
 *
 * The rows are components/settings/settings-hub.ts. Each live value is real
 * (connections from /api/settings/connections-summary; the account from
 * /api/profile/summary) or not shown at all.
 */
import Link from "next/link";
import { useState } from "react";

import { buildSettingsHub, WORKSPACE_LANGUAGE_LABEL, type HubRow } from "@/components/settings/settings-hub";
import { ChevronGlyph, LogoutGlyph } from "@/components/ui/warm-surface/glyphs";
import {
  WarmGroup,
  WarmPageHeading,
  WarmPill,
  WarmRow,
  WarmRowList,
  warmStyles,
} from "@/components/ui/warm-surface/warm-surface";
import { signOutAndRedirect } from "@/lib/client-session";
import type { ConnectionsSummary } from "@/lib/services/connections/connections-summary.service";
import type { ProfileSummary } from "@/lib/services/profile/profile-summary.service";

import { useConnectionsSummary, useProfileSummary, type Load } from "../data/use-account-data";
import { BusinessLogo } from "../ui/BusinessLogo";
import { NotificationsAction } from "../ui/header-actions";
import s from "./settings-hub.module.css";

const HUB = buildSettingsHub();

export function activeConnectionsLabel(active: number): string {
  if (active === 0) return "אין פעילים";
  if (active === 1) return "1 פעיל";
  return `${active} פעילים`;
}

export function SettingsHubScreen({ versionLabel }: { versionLabel: string }) {
  const [profile] = useProfileSummary();
  const [connections] = useConnectionsSummary();

  const connectionsCount =
    connections.state === "ready" && connections.data.available ? connections.data.active : null;

  function rowValue(row: HubRow): string | undefined {
    if (row.value === "workspace-language") return WORKSPACE_LANGUAGE_LABEL;
    if (row.value === "active-connections" && connectionsCount !== null) {
      return activeConnectionsLabel(connectionsCount);
    }
    return undefined;
  }

  return (
    <div className={`${warmStyles.surface} ${s.page}`} dir="rtl">
      <WarmPageHeading
        className={s.heading}
        title="הגדרות"
        subtitle="ניהול החשבון והעסק"
        actions={<NotificationsAction />}
      />

      <AccountCard profile={profile} connectionsCount={connectionsCount} />

      <div className={s.groups}>
        {HUB.map((group) => (
          <WarmGroup
            key={group.key}
            title={group.title}
            tone={group.tone}
            headingId={`settings-group-${group.key}`}
            className={s.group}
          >
            <WarmRowList>
              {group.rows.map((row) => (
                <WarmRow
                  key={row.key}
                  tone={group.tone}
                  icon={row.icon}
                  title={row.title}
                  subtitle={row.subtitle}
                  href={row.href}
                  external={row.external}
                  value={rowValue(row)}
                  badge={row.badge === "soon" ? <WarmPill tone="sand">בקרוב</WarmPill> : undefined}
                />
              ))}
            </WarmRowList>
          </WarmGroup>
        ))}
      </div>

      <footer className={s.footer}>
        <SignOutButton />
        <span className={s.version}>Dubiz · גרסה {versionLabel} · מופעל על ידי PRO MAX GROUP</span>
      </footer>
    </div>
  );
}

function AccountCard({
  profile,
  connectionsCount,
}: {
  profile: Load<ProfileSummary>;
  connectionsCount: ConnectionsSummary["active"];
}) {
  const data = profile.state === "ready" ? profile.data : null;
  const name = data?.business.name ?? "";

  return (
    <Link href="/profile" className={s.account}>
      <span className={s.accountLogo}>
        {data ? (
          <BusinessLogo name={name} logoDataUrl={data.business.logoDataUrl} size={54} variant="onTeal" />
        ) : (
          <span className={s.accountLogoPlaceholder} aria-hidden="true" />
        )}
      </span>
      <span className={s.accountText}>
        <span className={s.accountName}>{data ? name : "החשבון העסקי שלך"}</span>
        <span className={s.accountLink}>
          {data?.business.categoryLabel ? (
            <span className={s.accountCategory}>{data.business.categoryLabel}</span>
          ) : null}
          לפרופיל העסק
        </span>
      </span>

      {/* Desktop only: what is set up, at a glance. Only values that loaded. */}
      <span className={s.accountFacts}>
        {data ? (
          <span className={s.fact}>
            <span className={s.factLabel}>מחובר כ־</span>
            <span className={s.factValue} dir="ltr">
              {data.account.email}
            </span>
          </span>
        ) : null}
        {data ? (
          <span className={s.fact}>
            <span className={s.factLabel}>פרטי העסק</span>
            <span className={s.factValue}>{data.completion.percent}%</span>
          </span>
        ) : null}
        {connectionsCount !== null ? (
          <span className={s.fact}>
            <span className={s.factLabel}>חיבורים פעילים</span>
            <span className={s.factValue}>{connectionsCount}</span>
          </span>
        ) : null}
      </span>

      <ChevronGlyph size={18} className={s.accountChevron} />
    </Link>
  );
}

function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={s.signOut}
      disabled={busy}
      aria-busy={busy}
      onClick={async () => {
        setBusy(true);
        await signOutAndRedirect();
      }}
    >
      <LogoutGlyph size={18} />
      {busy ? "מתנתק…" : "יציאה מהחשבון"}
    </button>
  );
}
