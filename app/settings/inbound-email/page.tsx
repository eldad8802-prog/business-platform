import { SettingsSubPageHeader } from "@/components/settings/SettingsSubPageHeader";
import { InboundEmailCard } from "@/components/settings/InboundEmailCard";
import { isInboundEmailEnabled } from "@/lib/inbound-email/inbound-email-flag";
import { notFound } from "next/navigation";

/**
 * Settings → ייבוא מסמכים במייל.
 *
 * The flag is checked HERE as well as in every endpoint the card calls. Neither
 * check is decorative: this one stops the page existing, and the endpoint checks
 * stop the data being reachable by anybody who guesses the URL. A page that only
 * hid its navigation link would still be a live management surface for an
 * unfinished feature.
 */
export default function SettingsInboundEmailPage() {
  if (!isInboundEmailEnabled()) notFound();

  return (
    <>
      <SettingsSubPageHeader title="ייבוא מסמכים במייל" />
      <div className="mb-4">
        <InboundEmailCard />
      </div>
    </>
  );
}
