import { LeadCard } from "@/components/leads/LeadCard";

/**
 * Lead card route (/leads/[id]) — canonical for a single lead: deep-link,
 * refresh and back all resolve here. The card is rendered by the shared
 * <LeadCard> component (the SAME representation shown full-page on mobile and
 * inside the desktop Master–Detail panel); the layout owns the frame.
 */
export default function LeadCardPage() {
  return <LeadCard />;
}
