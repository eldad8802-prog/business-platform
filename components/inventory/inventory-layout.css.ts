/** Shared layout CSS for inventory module (injected via <style>). */
export const inventoryLayoutCss = `
  .inv-subpage-root {
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--inv-page-bg, #FEF8F2);
    direction: rtl;
  }

  .inv-subpage-body {
    flex: 1;
    width: 100%;
    box-sizing: border-box;
    padding: 16px clamp(12px, 3.5vw, 24px) 16px;
  }

  .inv-subpage-main {
    width: 100%;
    max-width: var(--inv-max-width, 960px);
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--inv-gap, 18px);
    box-sizing: border-box;
    padding-bottom: var(--inv-bottom-safe, calc(96px + env(safe-area-inset-bottom, 0px)));
  }

  .inv-subpage-main--wide {
    max-width: 1080px;
  }

  .inv-progress-crumb {
    width: 100%;
    max-width: 960px;
    margin: 0 auto 12px;
    padding: 10px 14px;
    border-radius: 12px;
    background: var(--inv-card-bg);
    border: 1px solid var(--inv-border);
    font-size: 13px;
    font-weight: 600;
    color: var(--inv-text-muted);
    box-sizing: border-box;
  }

  .inv-progress-crumb strong {
    color: var(--inv-text);
    font-weight: 600;
  }

  .inv-subheader-inner {
    width: 100%;
    max-width: var(--inv-max-width, 960px);
    margin: 0 auto;
    box-sizing: border-box;
  }

  .inv-wizard-progress {
    width: 100%;
    margin-bottom: 16px;
  }

  .inv-wizard-progress-bars {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
    margin-bottom: 8px;
  }

  .inv-wizard-progress-seg {
    height: 4px;
    border-radius: 999px;
    background: var(--inv-border);
    transition: background 0.2s, height 0.2s;
  }

  .inv-wizard-progress-seg.is-done {
    background: var(--inv-brand-denim, #3D9C9A);
  }

  .inv-wizard-progress-seg.is-active {
    background: var(--inv-accent-dark, #246966);
    height: 6px;
  }

  .inv-wizard-progress-labels {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 4px;
    font-size: 10px;
    font-weight: 600;
    color: var(--inv-text-muted);
    text-align: center;
    line-height: 1.25;
  }

  .inv-wizard-progress-labels .is-active {
    color: var(--inv-text);
    font-weight: 600;
  }

  .inv-wizard-progress-labels .is-done {
    color: var(--inv-success);
  }

  @media (max-width: 520px) {
    .inv-wizard-progress-labels span:not(.is-active) {
      font-size: 0;
      line-height: 0;
      overflow: hidden;
      height: 0;
    }
    .inv-wizard-progress-labels .is-active {
      grid-column: 1 / -1;
      font-size: 12px;
      height: auto;
      line-height: 1.3;
      padding-top: 4px;
    }
  }

  .inv-action-bar {
    position: sticky;
    bottom: calc(72px + env(safe-area-inset-bottom, 0px));
    z-index: 30;
    margin-top: 8px;
    padding: 12px clamp(12px, 3.5vw, 16px);
    margin-inline: calc(-1 * clamp(12px, 3.5vw, 16px));
    background: rgba(254, 248, 242, 0.92);
    backdrop-filter: blur(12px);
    border-top: 1px solid var(--inv-border, #E9DDD0);
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-sizing: border-box;
  }

  .inv-action-bar-row {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
  }

  .inv-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 52px;
    padding: 0 20px;
    border-radius: 16px;
    font-size: 15px;
    font-weight: 600;
    text-decoration: none;
    box-sizing: border-box;
    width: 100%;
    cursor: pointer;
    border: none;
    font-family: inherit;
  }

  .inv-action-btn--primary {
    background: var(--inv-primary);
    color: var(--inv-on-accent);
    box-shadow: var(--inv-shadow-glow);
  }

  .inv-action-btn--primary:disabled,
  .inv-action-btn--primary[aria-disabled="true"] {
    background: var(--inv-surface-2);
    box-shadow: none;
    cursor: not-allowed;
    opacity: 0.85;
  }

  .inv-action-btn--secondary {
    background: var(--inv-card-bg);
    color: var(--inv-text);
    border: 1px solid var(--inv-border);
  }

  .inv-action-btn--ghost {
    background: transparent;
    color: var(--inv-text-muted);
    border: 1px solid transparent;
    min-height: 44px;
    font-size: 14px;
  }

  .inv-card-full {
    width: 100%;
    box-sizing: border-box;
  }

  @media (min-width: 640px) {
    .inv-action-bar {
      bottom: 24px;
      margin-inline: 0;
      padding: 16px;
      border-radius: 18px;
      border: 1px solid var(--inv-border, #E9DDD0);
      background: rgba(254, 248, 242, 0.96);
      box-shadow: var(--inv-shadow);
    }

    .inv-action-bar-row {
      flex-direction: row;
      align-items: center;
      justify-content: flex-end;
    }

    .inv-action-btn {
      width: auto;
      min-width: 160px;
    }

    .inv-action-btn--primary {
      flex: 1 1 220px;
      max-width: 320px;
    }

    .inv-subpage-main {
      padding-bottom: 48px;
    }
  }

  @media (min-width: 1024px) {
    .inv-subpage-body {
      padding: 0 32px 32px;
    }
  }

  .inv-order-build-grid {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  @media (min-width: 900px) {
    .inv-order-build-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
      align-items: start;
      gap: 20px;
    }
    .inv-order-cart-panel {
      position: sticky;
      top: 80px;
    }
  }
`;
