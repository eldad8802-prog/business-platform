import { inventoryCssVars } from "./inventory-tokens";

/** Module-wide foundation — scoped to [data-inventory-module] */
export const inventoryFoundationCss = `
  [data-inventory-module] {
    ${inventoryCssVars}
    overflow-x: hidden;
  }

  [data-inventory-module] .inv-page-root {
    min-height: 100vh;
    min-height: 100dvh;
    background: var(--inv-page-bg);
    direction: rtl;
    color: var(--inv-text);
  }

  [data-inventory-module] .inv-section {
    background: var(--inv-card-bg);
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-lg);
    padding: var(--inv-gap);
    box-shadow: var(--inv-shadow);
    box-sizing: border-box;
  }

  [data-inventory-module] .inv-section + .inv-section {
    margin-top: 0;
  }

  [data-inventory-module] .inv-btn-primary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 50px;
    padding: 12px 18px;
    border-radius: var(--inv-radius-button);
    border: none;
    background: var(--inv-primary);
    color: #fff;
    font-size: 15px;
    font-weight: 900;
    font-family: inherit;
    cursor: pointer;
    box-shadow: 0 6px 16px rgba(91, 91, 214, 0.22);
    box-sizing: border-box;
  }

  [data-inventory-module] .inv-btn-primary:disabled {
    background: #cbd5e1;
    box-shadow: none;
    cursor: not-allowed;
  }

  [data-inventory-module] .inv-btn-primary--full {
    width: 100%;
  }

  [data-inventory-module] .inv-btn-secondary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 10px 14px;
    border-radius: var(--inv-radius-button);
    border: 1px solid var(--inv-border);
    background: var(--inv-card-bg);
    color: var(--inv-text);
    font-size: 14px;
    font-weight: 800;
    font-family: inherit;
    cursor: pointer;
    box-sizing: border-box;
  }

  [data-inventory-module] .inv-btn-ghost {
    border: none;
    background: transparent;
    color: var(--inv-text-muted);
    font-size: 14px;
    font-weight: 800;
    font-family: inherit;
    cursor: pointer;
    padding: 8px 4px;
    min-height: 44px;
  }

  [data-inventory-module] .inv-cta-group {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
  }

  [data-inventory-module] .inv-cta-group > * {
    width: 100%;
  }

  [data-inventory-module] .inv-btn-link {
    border: none;
    background: transparent;
    color: var(--inv-accent);
    font-size: 13px;
    font-weight: 900;
    font-family: inherit;
    cursor: pointer;
    padding: 4px 0;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  [data-inventory-module] .inv-field-label {
    display: block;
    font-size: 12px;
    font-weight: 800;
    color: var(--inv-text-muted);
    margin-bottom: 6px;
  }

  [data-inventory-module] .inv-field-input,
  [data-inventory-module] .inv-field-select {
    width: 100%;
    min-height: 48px;
    padding: 0 14px;
    border-radius: 12px;
    border: 1px solid var(--inv-border);
    background: var(--inv-card-bg);
    color: var(--inv-text);
    font-size: 14px;
    font-weight: 700;
    font-family: inherit;
    box-sizing: border-box;
    outline: none;
  }

  [data-inventory-module] .inv-field-input:focus,
  [data-inventory-module] .inv-field-select:focus {
    border-color: var(--inv-accent);
    box-shadow: 0 0 0 3px rgba(5, 150, 105, 0.12);
  }

  [data-inventory-module] .inv-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  [data-inventory-module] .inv-list-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    min-width: 0;
    padding: 12px 14px;
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-md);
    background: var(--inv-card-bg);
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.03);
    box-sizing: border-box;
    text-align: right;
    font-family: inherit;
    cursor: pointer;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  [data-inventory-module] .inv-list-row:hover {
    border-color: #cbd5e1;
    box-shadow: 0 4px 14px rgba(15, 23, 42, 0.06);
  }

  [data-inventory-module] .inv-state-panel {
    margin-top: 16px;
    text-align: center;
    padding: 28px 16px;
    color: var(--inv-text-muted);
  }

  [data-inventory-module] .inv-state-card {
    background: var(--inv-card-bg);
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-lg);
    box-shadow: var(--inv-shadow);
    padding: 24px 16px;
    text-align: center;
    box-sizing: border-box;
  }

  [data-inventory-module] .inv-state-card__title {
    margin: 0;
    color: var(--inv-text);
    font-size: 17px;
    font-weight: 950;
    line-height: 1.35;
  }

  [data-inventory-module] .inv-state-card__body {
    margin-top: 8px;
    color: var(--inv-text-muted);
    font-size: 14px;
    font-weight: 700;
    line-height: 1.6;
  }

  [data-inventory-module] .inv-state-card__action {
    margin-top: 16px;
  }

  [data-inventory-module] .inv-state-panel__title {
    font-size: 15px;
    font-weight: 900;
    color: var(--inv-text);
    margin: 0 0 8px;
  }

  [data-inventory-module] .inv-state-panel--error {
    border-color: #fecaca !important;
    background: #fef2f2 !important;
    color: #991b1b;
    text-align: right;
  }

  [data-inventory-module] .inv-notice {
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 800;
    line-height: 1.45;
  }

  [data-inventory-module] .inv-notice--success {
    background: #ecfdf5;
    border: 1px solid #bbf7d0;
    color: var(--inv-accent-dark);
  }

  [data-inventory-module] .inv-notice--danger {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #991b1b;
  }

  [data-inventory-module] .inv-subheader-bar {
    position: sticky;
    top: 0;
    z-index: 40;
    background: rgba(240, 244, 248, 0.92);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border-bottom: 1px solid rgba(226, 232, 240, 0.85);
    padding: 10px 0;
  }

  [data-inventory-module] .inv-subheader-inner {
    width: 100%;
    max-width: var(--inv-max-width);
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    position: relative;
    padding: 0 clamp(16px, 3.5vw, 28px);
    box-sizing: border-box;
  }

  [data-inventory-module] .inv-subheader-title {
    font-weight: 950;
    font-size: clamp(17px, 2.5vw, 20px);
    color: var(--inv-text);
    text-align: center;
    padding-inline: 100px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin: 0;
  }

  [data-inventory-module] .inv-subheader-back {
    position: absolute;
    inset-inline-end: clamp(16px, 3.5vw, 28px);
    top: 50%;
    transform: translateY(-50%);
    height: 40px;
    border-radius: 12px;
    border: 1px solid var(--inv-border);
    background: var(--inv-card-bg);
    cursor: pointer;
    padding: 0 12px;
    font-size: 14px;
    font-weight: 900;
    color: var(--inv-text);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
    font-family: inherit;
  }

  [data-inventory-module] .inv-bottom-nav {
    display: none;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 50;
    background: rgba(255, 255, 255, 0.97);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-top: 1px solid var(--inv-border);
    padding: 4px 6px calc(4px + env(safe-area-inset-bottom, 0px));
    box-shadow: 0 -4px 24px rgba(15, 23, 42, 0.06);
  }

  [data-inventory-module] .inv-main-shell {
    padding-bottom: 28px;
  }

  [data-inventory-module] .inv-skeleton-block {
    animation: invSkeletonShift 1.35s ease-in-out infinite;
  }

  @keyframes invSkeletonShift {
    0% {
      background-position: 100% 0;
    }
    100% {
      background-position: -100% 0;
    }
  }

  @media (max-width: 720px) {
    [data-inventory-module] .inv-bottom-nav {
      display: flex;
    }
    [data-inventory-module] .inv-main-shell {
      padding-bottom: var(--inv-bottom-safe);
    }
  }

  @media (min-width: 640px) {
    [data-inventory-module] .inv-cta-group {
      flex-direction: row;
      align-items: center;
      justify-content: flex-end;
    }

    [data-inventory-module] .inv-cta-group > * {
      width: auto;
    }
  }
`;
