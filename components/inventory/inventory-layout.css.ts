/** Shared layout CSS for inventory module (injected via <style>). */
export const inventoryLayoutCss = `
  .inv-subpage-root {
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--inv-page-bg, #f0f4f8);
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
    background: #fff;
    border: 1px solid #e2e8f0;
    font-size: 13px;
    font-weight: 800;
    color: #64748b;
    box-sizing: border-box;
  }

  .inv-progress-crumb strong {
    color: #0f172a;
    font-weight: 950;
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
    background: #e2e8f0;
    transition: background 0.2s, height 0.2s;
  }

  .inv-wizard-progress-seg.is-done {
    background: #059669;
  }

  .inv-wizard-progress-seg.is-active {
    background: #0A0A0F;
    height: 6px;
  }

  .inv-wizard-progress-labels {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 4px;
    font-size: 10px;
    font-weight: 800;
    color: #94a3b8;
    text-align: center;
    line-height: 1.25;
  }

  .inv-wizard-progress-labels .is-active {
    color: #0A0A0F;
    font-weight: 950;
  }

  .inv-wizard-progress-labels .is-done {
    color: #059669;
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
    background: rgba(240, 244, 248, 0.92);
    backdrop-filter: blur(12px);
    border-top: 1px solid var(--inv-border, #e2e8f0);
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
    font-weight: 950;
    text-decoration: none;
    box-sizing: border-box;
    width: 100%;
    cursor: pointer;
    border: none;
    font-family: inherit;
  }

  .inv-action-btn--primary {
    background: #0A0A0F;
    color: #fff;
    box-shadow: 0 8px 20px rgba(10, 10, 15, 0.18);
  }

  .inv-action-btn--primary:disabled,
  .inv-action-btn--primary[aria-disabled="true"] {
    background: #cbd5e1;
    box-shadow: none;
    cursor: not-allowed;
    opacity: 0.85;
  }

  .inv-action-btn--secondary {
    background: #fff;
    color: #0f172a;
    border: 1px solid #e2e8f0;
  }

  .inv-action-btn--ghost {
    background: transparent;
    color: #64748b;
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
      border: 1px solid var(--inv-border, #e2e8f0);
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 8px 32px rgba(15, 23, 42, 0.08);
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
