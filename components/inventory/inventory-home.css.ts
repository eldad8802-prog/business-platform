/** Inventory Home - approved header/hero with dynamic station content. */
export const inventoryHomeCss = `
  [data-inventory-home].inv-page-root {
    min-height: 100vh;
    min-height: 100dvh;
    background: var(--inv-card-bg) !important;
    color: var(--inv-text);
    direction: rtl;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }

  [data-inventory-home] *,
  [data-inventory-home] *::before,
  [data-inventory-home] *::after {
    box-sizing: border-box;
  }

  [data-inventory-home] button,
  [data-inventory-home] input {
    font: inherit;
  }

  [data-inventory-home] .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  [data-inventory-home] .inv-home-topbar {
    position: sticky;
    top: 0;
    z-index: 40;
    background: rgba(254, 248, 242, 0.94);
    backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--inv-border);
  }

  [data-inventory-home] .inv-home-topbar__inner {
    width: 100%;
    max-width: 1216px;
    min-height: 72px;
    margin: 0 auto;
    padding: 0 34px;
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(240px, 420px) minmax(180px, 1fr);
    align-items: center;
    gap: 22px;
  }

  [data-inventory-home] .inv-home-brand {
    justify-self: start;
    direction: ltr;
    display: inline-flex;
    align-items: center;
    gap: 11px;
    font-size: 21px;
    font-weight: 600;
    color: var(--inv-text);
    letter-spacing: 0;
  }

  [data-inventory-home] .inv-home-brand__mark {
    width: 38px;
    height: 38px;
    border-radius: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--inv-accent);
    background: var(--inv-success-bg);
  }

  [data-inventory-home] .inv-home-brand__mark svg {
    width: 23px;
    height: 23px;
  }

  [data-inventory-home] .inv-home-search {
    justify-self: center;
    width: 100%;
    height: 42px;
    border: 1px solid var(--inv-border);
    border-radius: 999px;
    background: var(--inv-surface-2);
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 15px;
    color: var(--inv-text-muted);
  }

  [data-inventory-home] .inv-home-search input {
    width: 100%;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--inv-text);
    font-size: 14px;
    text-align: right;
  }

  [data-inventory-home] .inv-home-search input::placeholder {
    color: var(--inv-text-muted);
  }

  [data-inventory-home] .inv-home-topbar__actions {
    justify-self: end;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    direction: ltr;
  }

  [data-inventory-home] .inv-home-topbar__actions button {
    width: 40px;
    height: 40px;
    border: 1px solid var(--inv-border);
    border-radius: 999px;
    background: var(--inv-card-bg);
    color: var(--inv-text-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  [data-inventory-home] .inv-home-topbar__actions .inv-home-avatar {
    background:
      radial-gradient(circle at 50% 38%, var(--inv-card-bg) 0 18%, transparent 19%),
      radial-gradient(circle at 50% 76%, var(--inv-card-bg) 0 26%, transparent 27%),
      var(--inv-primary);
  }

  [data-inventory-home] .inv-workspace {
    width: 100%;
    max-width: 1216px;
    margin: 0 auto;
    padding: 24px 34px 46px;
    display: flex;
    flex-direction: column;
    gap: 34px;
  }

  [data-inventory-home] .inv-home-hero {
    position: relative;
    min-height: 560px;
    border: 1px solid var(--inv-border);
    border-radius: 16px;
    background: var(--inv-card-bg);
    box-shadow: var(--inv-shadow);
    overflow: hidden;
    display: grid;
    grid-template-columns: minmax(360px, 1fr) minmax(340px, 0.95fr);
    align-items: center;
    gap: 28px;
    padding: 72px 62px 74px;
  }

  [data-inventory-home] .inv-home-hero__copy {
    justify-self: end;
    max-width: 470px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    text-align: right;
  }

  [data-inventory-home] .inv-home-hero__copy h1 {
    margin: 0 0 18px;
    color: var(--inv-text);
    font-size: 56px;
    line-height: 1.08;
    font-weight: 600;
    letter-spacing: 0;
  }

  [data-inventory-home] .inv-home-hero__sub,
  [data-inventory-home] .inv-home-hero__state {
    margin: 0;
    color: var(--inv-text-muted);
    font-size: 24px;
    line-height: 1.55;
    font-weight: 400;
  }

  [data-inventory-home] .inv-home-hero__state {
    margin-top: 24px;
  }

  [data-inventory-home] .inv-home-hero__state strong {
    color: var(--inv-accent);
    font-size: 30px;
    font-weight: 600;
  }

  [data-inventory-home] .inv-home-hero__cta {
    margin-top: 42px;
    min-width: 306px;
    min-height: 84px;
    border: 0;
    border-radius: 14px;
    background: var(--inv-primary);
    color: var(--inv-on-accent);
    box-shadow: var(--inv-shadow-glow);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    font-size: 24px;
    font-weight: 600;
    cursor: pointer;
  }

  [data-inventory-home] .inv-home-hero__inventory-link {
    position: absolute;
    left: 46px;
    bottom: 58px;
    border: 0;
    background: transparent;
    color: var(--inv-accent);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 18px;
    font-weight: 600;
    cursor: pointer;
  }

  [data-inventory-home] .inv-home-illustration {
    position: relative;
    justify-self: start;
    width: 460px;
    height: 330px;
  }

  [data-inventory-home] .inv-home-illustration__blob {
    position: absolute;
    border-radius: 42% 58% 52% 48%;
    background: var(--inv-surface-2);
  }

  [data-inventory-home] .inv-home-illustration__blob--one {
    width: 250px;
    height: 210px;
    right: 110px;
    top: 10px;
  }

  [data-inventory-home] .inv-home-illustration__blob--two {
    width: 210px;
    height: 170px;
    right: 280px;
    top: 108px;
  }

  [data-inventory-home] .inv-home-illustration__floor {
    position: absolute;
    left: 16px;
    right: 10px;
    bottom: 18px;
    height: 10px;
    border-radius: 999px;
    background: var(--inv-success-bg);
  }

  [data-inventory-home] .inv-home-illustration__clipboard {
    position: absolute;
    right: 118px;
    top: 42px;
    width: 170px;
    height: 250px;
    border: 8px solid var(--inv-border);
    border-radius: 18px;
    background: var(--inv-card-bg);
    box-shadow: var(--inv-shadow);
    padding: 48px 28px 24px;
  }

  [data-inventory-home] .inv-home-illustration__clip {
    position: absolute;
    top: -22px;
    right: 50%;
    transform: translateX(50%);
    width: 74px;
    height: 28px;
    border-radius: 6px 6px 4px 4px;
    background: var(--inv-primary);
  }

  [data-inventory-home] .inv-home-illustration__clip::before {
    content: "";
    position: absolute;
    width: 30px;
    height: 30px;
    border-radius: 999px;
    border: 8px solid var(--inv-accent);
    background: var(--inv-card-bg);
    top: -21px;
    right: 22px;
  }

  [data-inventory-home] .inv-home-illustration__check-row {
    display: grid;
    grid-template-columns: 28px 1fr;
    align-items: center;
    gap: 14px;
    margin-bottom: 25px;
  }

  [data-inventory-home] .inv-home-illustration__check-row span {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: var(--inv-success-bg);
    position: relative;
  }

  [data-inventory-home] .inv-home-illustration__check-row span::after {
    content: "";
    position: absolute;
    width: 13px;
    height: 7px;
    border-left: 4px solid var(--inv-accent);
    border-bottom: 4px solid var(--inv-accent);
    transform: rotate(-45deg);
    right: 6px;
    top: 7px;
  }

  [data-inventory-home] .inv-home-illustration__check-row i {
    height: 7px;
    border-radius: 999px;
    background: var(--inv-border);
    box-shadow: 0 14px 0 var(--inv-border);
  }

  [data-inventory-home] .inv-home-illustration__boxes {
    position: absolute;
    right: 286px;
    bottom: 26px;
    width: 154px;
    height: 140px;
  }

  [data-inventory-home] .inv-home-illustration__boxes span {
    position: absolute;
    border-radius: 4px;
    background: var(--inv-warning-bg);
  }

  [data-inventory-home] .inv-home-illustration__boxes span:nth-child(1) {
    width: 86px;
    height: 72px;
    right: 10px;
    bottom: 0;
  }

  [data-inventory-home] .inv-home-illustration__boxes span:nth-child(2) {
    width: 86px;
    height: 72px;
    right: 76px;
    bottom: 0;
    background: var(--inv-warning-bg);
  }

  [data-inventory-home] .inv-home-illustration__boxes span:nth-child(3) {
    width: 96px;
    height: 62px;
    right: 58px;
    bottom: 72px;
    background: var(--inv-warning-bg);
  }

  [data-inventory-home] .inv-home-illustration__plant {
    position: absolute;
    right: 52px;
    bottom: 30px;
    width: 56px;
    height: 110px;
  }

  [data-inventory-home] .inv-home-illustration__plant span {
    position: absolute;
    bottom: 0;
    right: 14px;
    width: 34px;
    height: 40px;
    border-radius: 4px 4px 9px 9px;
    background: var(--inv-border-hover);
  }

  [data-inventory-home] .inv-home-illustration__plant i,
  [data-inventory-home] .inv-home-illustration__plant i::before,
  [data-inventory-home] .inv-home-illustration__plant i::after {
    content: "";
    position: absolute;
    border-radius: 90% 12% 90% 12%;
    background: var(--inv-success);
  }

  [data-inventory-home] .inv-home-illustration__plant i {
    width: 24px;
    height: 54px;
    right: 17px;
    bottom: 38px;
    transform: rotate(22deg);
  }

  [data-inventory-home] .inv-home-illustration__plant i::before {
    width: 24px;
    height: 42px;
    right: -22px;
    top: 26px;
    transform: rotate(-62deg);
  }

  [data-inventory-home] .inv-home-illustration__plant i::after {
    width: 24px;
    height: 42px;
    right: 24px;
    top: 42px;
    transform: rotate(36deg);
  }

  [data-inventory-home] .inv-home-stations {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 24px;
  }

  [data-inventory-home] .inv-home-stations h2 {
    margin: 0;
    text-align: center;
    color: var(--inv-text);
    font-size: 28px;
    font-weight: 600;
  }

  [data-inventory-home] .inv-home-stations__bar {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    border: 1px solid var(--inv-border);
    border-radius: 14px;
    background: var(--inv-card-bg);
    box-shadow: var(--inv-shadow);
    overflow: hidden;
  }

  [data-inventory-home] .inv-home-station {
    position: relative;
    min-height: 126px;
    border: 0;
    border-left: 1px solid var(--inv-border);
    background: var(--inv-card-bg);
    color: var(--inv-text);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 38px;
    font-size: 25px;
    font-weight: 600;
    cursor: pointer;
  }

  [data-inventory-home] .inv-home-station:first-child {
    border-left: 0;
  }

  [data-inventory-home] .inv-home-station.is-active {
    color: var(--inv-accent);
    background: var(--inv-surface-2);
  }

  [data-inventory-home] .inv-home-station.is-active::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: var(--inv-accent);
  }

  [data-inventory-home] .inv-home-station:nth-child(2):not(.is-active) {
    color: var(--inv-success);
  }

  [data-inventory-home] .inv-home-station:nth-child(3):not(.is-active) {
    color: var(--inv-accent);
  }

  [data-inventory-home] .inv-home-task-card {
    border: 1px solid var(--inv-border);
    border-radius: 14px;
    background: var(--inv-card-bg);
    box-shadow: var(--inv-shadow);
    overflow: hidden;
  }

  [data-inventory-home] .inv-home-task-card__header {
    min-height: 96px;
    padding: 24px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid var(--inv-border);
  }

  [data-inventory-home] .inv-home-task-card__header h2 {
    margin: 0;
    font-size: 28px;
    font-weight: 600;
    color: var(--inv-text);
  }

  [data-inventory-home] .inv-home-task-card__header p {
    margin: 0;
    color: var(--inv-text-muted);
    font-size: 16px;
    font-weight: 400;
  }

  [data-inventory-home] .inv-station-content-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    padding: 24px 28px 28px;
  }

  [data-inventory-home] .inv-station-nav-card {
    min-height: 94px;
    border: 1px solid var(--inv-border);
    border-radius: 14px;
    background: var(--inv-card-bg);
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr) 28px;
    align-items: center;
    gap: 16px;
    padding: 16px 18px;
    text-align: right;
    cursor: pointer;
    color: var(--inv-text);
    box-shadow: var(--inv-shadow);
  }

  [data-inventory-home] .inv-station-nav-card:hover {
    background: var(--inv-surface-2);
    border-color: var(--inv-border-hover);
  }

  [data-inventory-home] .inv-station-nav-card__icon {
    width: 56px;
    height: 56px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  [data-inventory-home] .inv-station-nav-card__icon--danger {
    color: var(--inv-danger);
    background: var(--inv-danger-bg);
  }

  [data-inventory-home] .inv-station-nav-card__icon--success {
    color: var(--inv-success);
    background: var(--inv-success-bg);
  }

  [data-inventory-home] .inv-station-nav-card__icon--purple {
    color: var(--inv-accent);
    background: var(--inv-success-bg);
  }

  [data-inventory-home] .inv-station-nav-card__icon--blue {
    color: var(--inv-accent);
    background: var(--inv-success-bg);
  }

  [data-inventory-home] .inv-station-nav-card__icon--warning {
    color: var(--inv-warning);
    background: var(--inv-warning-bg);
  }

  [data-inventory-home] .inv-station-nav-card__copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  [data-inventory-home] .inv-station-nav-card__title {
    color: var(--inv-text);
    font-size: 18px;
    line-height: 1.25;
    font-weight: 600;
  }

  [data-inventory-home] .inv-station-nav-card__meta {
    color: var(--inv-text-muted);
    font-size: 14px;
    line-height: 1.4;
    font-weight: 400;
  }

  [data-inventory-home] .inv-station-nav-card__chevron {
    color: var(--inv-text-muted);
    display: inline-flex;
  }

  [data-inventory-home] .inv-bottom-nav {
    display: none !important;
  }

  @media (max-width: 900px) {
    [data-inventory-home] .inv-home-topbar__inner {
      grid-template-columns: auto 1fr auto;
      padding: 0 16px;
    }

    [data-inventory-home] .inv-home-search {
      display: none;
    }

    [data-inventory-home] .inv-workspace {
      padding: 18px 14px 104px;
      gap: 24px;
    }

    [data-inventory-home] .inv-home-hero {
      min-height: auto;
      grid-template-columns: 1fr;
      padding: 36px 24px 76px;
    }

    [data-inventory-home] .inv-home-hero__copy h1 {
      font-size: 40px;
    }

    [data-inventory-home] .inv-home-hero__sub,
    [data-inventory-home] .inv-home-hero__state {
      font-size: 19px;
    }

    [data-inventory-home] .inv-home-hero__cta {
      min-width: 0;
      width: 100%;
      min-height: 64px;
      font-size: 19px;
    }

    [data-inventory-home] .inv-home-hero__inventory-link {
      right: 24px;
      left: auto;
      bottom: 28px;
      font-size: 16px;
    }

    [data-inventory-home] .inv-home-illustration {
      width: min(100%, 420px);
      height: 280px;
      justify-self: center;
      order: -1;
      transform: scale(0.9);
      transform-origin: center;
    }

    [data-inventory-home] .inv-home-station {
      min-height: 82px;
      gap: 16px;
      font-size: 20px;
    }

    [data-inventory-home] .inv-station-content-grid {
      grid-template-columns: 1fr;
      padding: 18px 16px 20px;
    }

    [data-inventory-home] .inv-bottom-nav {
      display: flex !important;
    }
  }

  @media (max-width: 560px) {
    [data-inventory-home] .inv-home-brand span:last-child {
      display: none;
    }

    [data-inventory-home] .inv-home-topbar__actions button[aria-label="עזרה"] {
      display: none;
    }

    [data-inventory-home] .inv-home-illustration {
      transform: scale(0.72);
      margin-block: -36px;
    }

    [data-inventory-home] .inv-home-stations__bar {
      grid-template-columns: 1fr;
    }

    [data-inventory-home] .inv-home-station {
      border-left: 0;
      border-bottom: 1px solid var(--inv-border);
    }

    [data-inventory-home] .inv-home-task-card__header {
      align-items: flex-start;
      flex-direction: column;
      padding: 18px 16px;
    }

    [data-inventory-home] .inv-station-nav-card {
      grid-template-columns: 52px minmax(0, 1fr) 22px;
      gap: 12px;
      padding: 14px;
    }

    [data-inventory-home] .inv-station-nav-card__icon {
      width: 48px;
      height: 48px;
    }
  }
`;
