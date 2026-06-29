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

  [data-inventory-module] .inv-screen-stack {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  [data-inventory-module] .inv-surface-card {
    background: var(--inv-card-bg);
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-lg);
    padding: var(--inv-gap);
    box-shadow: var(--inv-shadow);
    box-sizing: border-box;
  }

  [data-inventory-module] .inv-center-state {
    text-align: center;
    color: var(--inv-text-muted);
    font-size: 14px;
    font-weight: 800;
    line-height: 1.6;
    padding: 28px 18px;
  }

  [data-inventory-module] .inv-center-state strong {
    display: block;
    color: var(--inv-text);
    font-size: 17px;
    font-weight: 950;
    margin-bottom: 6px;
  }

  [data-inventory-module] .inv-center-state p {
    margin: 0 0 14px;
  }

  [data-inventory-module] .inv-hero-card {
    border-radius: calc(var(--inv-radius-lg) + 6px);
    padding: 24px;
    color: #fff;
    box-shadow: 0 18px 44px rgba(15, 23, 42, 0.16);
    box-sizing: border-box;
  }

  [data-inventory-module] .inv-hero-card--green {
    background: linear-gradient(135deg, #047857 0%, #059669 100%);
  }

  [data-inventory-module] .inv-hero-card--purple {
    background: linear-gradient(135deg, #5b21b6 0%, #7c3aed 100%);
  }

  [data-inventory-module] .inv-hero-card--blue {
    background: var(--inv-primary);
  }

  [data-inventory-module] .inv-hero-card h1 {
    margin: 6px 0 8px;
    font-size: clamp(24px, 6vw, 34px);
    line-height: 1.12;
    font-weight: 950;
  }

  [data-inventory-module] .inv-hero-card p {
    margin: 0;
    max-width: 52ch;
    color: rgba(255, 255, 255, 0.9);
    font-size: 14px;
    line-height: 1.65;
    font-weight: 700;
  }

  [data-inventory-module] .inv-kicker {
    display: inline-flex;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.14);
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 900;
  }

  [data-inventory-module] .inv-section-heading {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 14px;
  }

  [data-inventory-module] .inv-section-heading h2 {
    margin: 0;
    color: var(--inv-text);
    font-size: 17px;
    line-height: 1.3;
    font-weight: 950;
  }

  [data-inventory-module] .inv-section-heading span {
    color: var(--inv-text-muted);
    font-size: 12px;
    font-weight: 850;
    line-height: 1.45;
    text-align: left;
  }

  [data-inventory-module] .inv-data-pairs {
    display: grid;
    gap: 10px;
    margin-bottom: 14px;
  }

  [data-inventory-module] .inv-data-pairs > div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-md);
    padding: 10px 12px;
    background: #f8fafc;
  }

  [data-inventory-module] .inv-data-pairs span {
    color: var(--inv-text-muted);
    font-size: 12px;
    font-weight: 800;
  }

  [data-inventory-module] .inv-data-pairs strong {
    color: var(--inv-text);
    font-size: 13px;
    font-weight: 950;
    text-align: left;
  }

  [data-inventory-module] .inv-simple-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }

  [data-inventory-module] .inv-simple-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-md);
    padding: 11px 12px;
    background: #fff;
  }

  [data-inventory-module] .inv-simple-list span {
    min-width: 0;
    color: var(--inv-text);
    font-size: 14px;
    font-weight: 900;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  [data-inventory-module] .inv-simple-list strong {
    color: var(--inv-text-muted);
    font-size: 13px;
    font-weight: 900;
    white-space: nowrap;
  }

  [data-inventory-module] .inv-action-grid {
    display: grid;
    gap: 10px;
  }

  [data-inventory-module] .inv-primary-button,
  [data-inventory-module] .inv-secondary-button {
    width: 100%;
    min-height: 48px;
    border-radius: var(--inv-radius-button);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 11px 14px;
    font: inherit;
    font-size: 14px;
    font-weight: 900;
    cursor: pointer;
    text-decoration: none;
    box-sizing: border-box;
  }

  [data-inventory-module] .inv-primary-button {
    border: 0;
    background: var(--inv-primary);
    color: #fff;
    box-shadow: 0 12px 24px rgba(36, 59, 87, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.22);
  }

  [data-inventory-module] .inv-secondary-button {
    border: 1px solid var(--inv-border);
    background: #fff;
    color: var(--inv-text);
  }

  [data-inventory-module] .inv-primary-button:disabled,
  [data-inventory-module] .inv-secondary-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    box-shadow: none;
  }

  [data-inventory-module] .inv-alert {
    border-radius: var(--inv-radius-md);
    padding: 11px 13px;
    font-size: 13px;
    font-weight: 850;
    line-height: 1.5;
  }

  [data-inventory-module] .inv-alert--error {
    border: 1px solid #fecaca;
    background: #fef2f2;
    color: #991b1b;
  }

  [data-inventory-module] .inv-alert--success {
    border: 1px solid #bbf7d0;
    background: #ecfdf5;
    color: #166534;
  }

  [data-inventory-module] .inv-mini-stepper {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }

  [data-inventory-module] .inv-mini-step {
    min-height: 34px;
    border-radius: 999px;
    background: #f1f5f9;
    color: var(--inv-text-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px 8px;
    font-size: 12px;
    font-weight: 900;
    text-align: center;
  }

  [data-inventory-module] .inv-mini-step.is-current {
    background: var(--inv-primary);
    color: #fff;
    box-shadow: 0 8px 18px rgba(36, 59, 87, 0.18);
  }

  [data-inventory-module] .inv-mini-step.is-done {
    background: #eaf2ff;
    color: #3F619C;
  }

  [data-inventory-module] .inv-modal-backdrop {
    position: fixed;
    inset: 0;
    /* Above the global BottomBar (z-index 100) so the modal is not covered or
       click-intercepted by the bottom navigation. */
    z-index: 210;
    background: rgba(15, 23, 42, 0.42);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }

  [data-inventory-module] .inv-modal-panel {
    width: 100%;
    max-width: 380px;
    border-radius: var(--inv-radius-lg);
    background: #fff;
    box-shadow: 0 24px 70px rgba(15, 23, 42, 0.26);
    padding: 18px;
    display: grid;
    gap: 10px;
  }

  [data-inventory-module] .inv-modal-panel h2 {
    margin: 0 0 4px;
    color: var(--inv-text);
    font-size: 18px;
    font-weight: 950;
    text-align: center;
  }

  [data-inventory-module] .inv-modal-panel button {
    min-height: 46px;
    border-radius: var(--inv-radius-md);
    border: 1px solid var(--inv-border);
    background: #fff;
    color: var(--inv-text);
    font: inherit;
    font-weight: 900;
    cursor: pointer;
  }

  [data-inventory-module] .inv-tabs-soft {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    border-radius: var(--inv-radius-md);
    background: #eef3f8;
    padding: 5px;
    border: 1px solid var(--inv-border);
  }

  [data-inventory-module] .inv-tabs-soft button {
    min-height: 38px;
    border-radius: 11px;
    border: 0;
    background: transparent;
    color: #64748b;
    font: inherit;
    font-size: 13px;
    font-weight: 900;
    cursor: pointer;
  }

  [data-inventory-module] .inv-tabs-soft button.is-active {
    background: var(--inv-primary);
    color: #fff;
    box-shadow: 0 10px 20px rgba(36, 59, 87, 0.18), inset 0 1px 0 rgba(255,255,255,0.22);
  }

  [data-inventory-module] .inv-row-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  [data-inventory-module] .inv-row-card-head > div {
    min-width: 0;
  }

  [data-inventory-module] .inv-row-card-head h2 {
    margin: 8px 0 4px;
    color: var(--inv-text);
    font-size: 17px;
    font-weight: 950;
    line-height: 1.3;
  }

  [data-inventory-module] .inv-row-card-head p {
    margin: 0;
    color: var(--inv-text-muted);
    font-size: 13px;
    line-height: 1.45;
    font-weight: 750;
  }

  [data-inventory-module] .inv-row-card-head .inv-secondary-button {
    width: auto;
    min-width: 86px;
  }

  [data-inventory-module] .inv-status-pill {
    display: inline-flex;
    width: fit-content;
    border-radius: 999px;
    background: #ecfdf5;
    color: #166534;
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 900;
  }

  [data-inventory-module] .inv-receive-panel {
    margin-top: 16px;
    border-top: 1px solid var(--inv-border);
    padding-top: 16px;
    display: grid;
    gap: 14px;
  }

  [data-inventory-module] .inv-receive-line {
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-md);
    background: #f8fafc;
    padding: 12px;
    display: grid;
    gap: 10px;
  }

  [data-inventory-module] .inv-receive-line strong {
    display: block;
    color: var(--inv-text);
    font-size: 14px;
    font-weight: 950;
    line-height: 1.35;
  }

  [data-inventory-module] .inv-receive-line span {
    display: block;
    margin-top: 4px;
    color: var(--inv-text-muted);
    font-size: 12px;
    font-weight: 800;
  }

  [data-inventory-module] .inv-receive-line__controls {
    display: grid;
    gap: 8px;
  }

  [data-inventory-module] .inv-receive-impact {
    border: 1px solid #bbf7d0;
    border-radius: var(--inv-radius-md);
    background: #f0fdf4;
    color: #166534;
    padding: 12px;
    font-size: 13px;
    font-weight: 850;
    line-height: 1.55;
  }

  [data-inventory-module] .inv-sale-line {
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-md);
    background: #f8fafc;
    padding: 12px;
    display: grid;
    gap: 10px;
  }

  [data-inventory-module] .inv-sale-line__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  [data-inventory-module] .inv-sale-line__head strong {
    color: var(--inv-text);
    font-size: 14px;
    font-weight: 950;
  }

  [data-inventory-module] .inv-sale-line__head button {
    min-height: 34px;
    border-radius: 10px;
    border: 1px solid #fecaca;
    background: #fef2f2;
    color: #991b1b;
    font: inherit;
    font-size: 12px;
    font-weight: 900;
    cursor: pointer;
    padding: 6px 10px;
  }

  [data-inventory-module] .inv-sale-line__stock {
    border-radius: 12px;
    background: #fff;
    border: 1px solid var(--inv-border);
    color: var(--inv-text-muted);
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 850;
    line-height: 1.45;
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
    box-shadow: 0 12px 24px rgba(36, 59, 87, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.22);
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
    display: none !important;
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
      display: none !important;
    }
    [data-inventory-module] .inv-main-shell {
      padding-bottom: 28px;
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
