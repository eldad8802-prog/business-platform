import { WarmPill } from "@/components/ui/warm-surface/warm-surface";

/**
 * "בקרוב" — the one marker for a connection that is not open yet (Meta: WhatsApp Business,
 * Facebook / Instagram; the Tax Authority). The existing sand pill the settings hub already uses
 * for "בקרוב", so every such button reads the same way.
 */
export const COMING_SOON_LABEL = "בקרוב";

export function ComingSoonPill({ className }: { className?: string }) {
  return (
    <WarmPill tone="sand" className={className}>
      {COMING_SOON_LABEL}
    </WarmPill>
  );
}
