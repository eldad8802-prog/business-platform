import { CustomerCard } from "@/components/customers/CustomerCard";

/**
 * Customer card route (/customers/[id]) — canonical for a single customer:
 * deep-link / refresh / back all resolve here. The card is rendered by the
 * shared <CustomerCard> component (the SAME representation shown full-page on
 * mobile/tablet and inside the desktop Master–Detail panel); the layout owns the
 * frame.
 */
export default function CustomerCardPage() {
  return <CustomerCard />;
}
