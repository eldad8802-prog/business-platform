/**
 * CRM feature theme — Design System v1 (warm cream/teal).
 *
 * Single injection point: the CRM surface renders inside `.crm-scope`, and every
 * CRM component reads `var(--crm-*)`. Values are derived from `TOKEN.dsv1` (the
 * DS source of truth) — never hand-authored literals — so a palette change flows
 * from one place. Mirrors the per-feature theme-module pattern used by
 * documents/billing/bot.
 */

import { TOKEN } from "@/lib/design/tokens";

const d = TOKEN.dsv1;

export const CRM_THEME_CSS = `
.crm-scope{
  --crm-canvas:${d.canvas};
  --crm-card:${d.card};
  --crm-surface2:${d.surface2};
  --crm-ink:${d.ink};
  --crm-muted:${d.muted};
  --crm-tertiary:${d.tertiary};
  --crm-line:${d.line};
  --crm-accent:${d.accent};
  --crm-accent-grad:${d.gradient};
  --crm-accent-grad-hover:${d.gradientHover};
  --crm-on-accent:${d.onAccent};
  --crm-success:${d.success};
  --crm-success-bg:${d.successBg};
  --crm-warning:${d.warning};
  --crm-warning-ink:${d.warningInk};
  --crm-warning-bg:${d.warningBg};
  --crm-error:${d.error};
  --crm-error-bg:${d.errorBg};
  --crm-info:${d.info};
  --crm-info-ink:${d.infoInk};
  --crm-info-bg:${d.infoBg};
  --crm-ring:${d.ring};
  --crm-backdrop:${d.backdrop};
  --crm-shadow-card:${d.shadowCard};
  --crm-shadow-card-hover:${d.shadowCardHover};
  --crm-shadow-glow:${d.shadowGlow};
  --crm-shadow-overlay:${d.shadowOverlay};
  --crm-radius-field:${d.radius.field}px;
  --crm-radius-button:${d.radius.button}px;
  --crm-radius-card:${d.radius.card}px;
  --crm-radius-dialog:${d.radius.dialog}px;
  --crm-radius-pill:${d.radius.pill}px;
  --crm-w-regular:${d.weight.regular};
  --crm-w-medium:${d.weight.medium};
  --crm-w-semibold:${d.weight.semibold};
}
`;
