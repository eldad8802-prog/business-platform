/** Inventory Home - approved header/hero with dynamic station content. */
export const inventoryHomeCss = `
  [data-inventory-home].inv-page-root {
    min-height: 100vh;
    min-height: 100dvh;
    background: #ffffff !important;
    color: #0b1b3f;
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
    background: rgba(255, 255, 255, 0.94);
    backdrop-filter: blur(14px);
    border-bottom: 1px solid #edf2fa;
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
    font-weight: 900;
    color: #0b1b3f;
    letter-spacing: 0;
  }

  [data-inventory-home] .inv-home-brand__mark {
    width: 38px;
    height: 38px;
    border-radius: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #0f6fff;
    background: #edf5ff;
  }

  [data-inventory-home] .inv-home-brand__mark svg {
    width: 23px;
    height: 23px;
  }

  [data-inventory-home] .inv-home-search {
    justify-self: center;
    width: 100%;
    height: 42px;
    border: 1px solid #e5edf8;
    border-radius: 999px;
    background: #f8fbff;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 15px;
    color: #8aa0bf;
  }

  [data-inventory-home] .inv-home-search input {
    width: 100%;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: #263b62;
    font-size: 14px;
    text-align: right;
  }

  [data-inventory-home] .inv-home-search input::placeholder {
    color: #94a7c3;
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
    border: 1px solid #e6edf7;
    border-radius: 999px;
    background: #ffffff;
    color: #60728f;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  [data-inventory-home] .inv-home-topbar__actions .inv-home-avatar {
    background:
      radial-gradient(circle at 50% 38%, #ffffff 0 18%, transparent 19%),
      radial-gradient(circle at 50% 76%, #ffffff 0 26%, transparent 27%),
      linear-gradient(135deg, #dbe7f6, #b7c8df);
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
    border: 1px solid #e6edf7;
    border-radius: 16px;
    background: #ffffff;
    box-shadow: 0 18px 42px rgba(15, 40, 80, 0.08);
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
    color: #091a3d;
    font-size: 56px;
    line-height: 1.08;
    font-weight: 950;
    letter-spacing: 0;
  }

  [data-inventory-home] .inv-home-hero__sub,
  [data-inventory-home] .inv-home-hero__state {
    margin: 0;
    color: #54647f;
    font-size: 24px;
    line-height: 1.55;
    font-weight: 650;
  }

  [data-inventory-home] .inv-home-hero__state {
    margin-top: 24px;
  }

  [data-inventory-home] .inv-home-hero__state strong {
    color: #0f6fff;
    font-size: 30px;
    font-weight: 950;
  }

  [data-inventory-home] .inv-home-hero__cta {
    margin-top: 42px;
    min-width: 306px;
    min-height: 84px;
    border: 0;
    border-radius: 14px;
    background: #0f6fff;
    color: #ffffff;
    box-shadow: 0 14px 26px rgba(15, 111, 255, 0.24);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    font-size: 24px;
    font-weight: 850;
    cursor: pointer;
  }

  [data-inventory-home] .inv-home-hero__inventory-link {
    position: absolute;
    left: 46px;
    bottom: 58px;
    border: 0;
    background: transparent;
    color: #0f6fff;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 18px;
    font-weight: 850;
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
    background: #f2f6ff;
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
    background: #e7f0ff;
  }

  [data-inventory-home] .inv-home-illustration__clipboard {
    position: absolute;
    right: 118px;
    top: 42px;
    width: 170px;
    height: 250px;
    border: 8px solid #dbe9ff;
    border-radius: 18px;
    background: #ffffff;
    box-shadow: 0 18px 28px rgba(72, 126, 218, 0.08);
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
    background: linear-gradient(#80b2ff, #2f73e8);
  }

  [data-inventory-home] .inv-home-illustration__clip::before {
    content: "";
    position: absolute;
    width: 30px;
    height: 30px;
    border-radius: 999px;
    border: 8px solid #6ca4ff;
    background: #ffffff;
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
    background: #eaf2ff;
    position: relative;
  }

  [data-inventory-home] .inv-home-illustration__check-row span::after {
    content: "";
    position: absolute;
    width: 13px;
    height: 7px;
    border-left: 4px solid #2473ef;
    border-bottom: 4px solid #2473ef;
    transform: rotate(-45deg);
    right: 6px;
    top: 7px;
  }

  [data-inventory-home] .inv-home-illustration__check-row i {
    height: 7px;
    border-radius: 999px;
    background: #dbe8fb;
    box-shadow: 0 14px 0 #dbe8fb;
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
    background: linear-gradient(135deg, #f5c985, #cba170);
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
    background: linear-gradient(135deg, #efc181, #b88e5e);
  }

  [data-inventory-home] .inv-home-illustration__boxes span:nth-child(3) {
    width: 96px;
    height: 62px;
    right: 58px;
    bottom: 72px;
    background: linear-gradient(135deg, #f6d195, #d9ad73);
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
    background: #cbd7e8;
  }

  [data-inventory-home] .inv-home-illustration__plant i,
  [data-inventory-home] .inv-home-illustration__plant i::before,
  [data-inventory-home] .inv-home-illustration__plant i::after {
    content: "";
    position: absolute;
    border-radius: 90% 12% 90% 12%;
    background: #78d49b;
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
    color: #0b1b3f;
    font-size: 28px;
    font-weight: 950;
  }

  [data-inventory-home] .inv-home-stations__bar {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    border: 1px solid #e2ebf7;
    border-radius: 14px;
    background: #ffffff;
    box-shadow: 0 10px 24px rgba(15, 40, 80, 0.05);
    overflow: hidden;
  }

  [data-inventory-home] .inv-home-station {
    position: relative;
    min-height: 126px;
    border: 0;
    border-left: 1px solid #e8eef7;
    background: #ffffff;
    color: #0b1b3f;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 38px;
    font-size: 25px;
    font-weight: 900;
    cursor: pointer;
  }

  [data-inventory-home] .inv-home-station:first-child {
    border-left: 0;
  }

  [data-inventory-home] .inv-home-station.is-active {
    color: #0f6fff;
    background: #fbfdff;
  }

  [data-inventory-home] .inv-home-station.is-active::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: #0f6fff;
  }

  [data-inventory-home] .inv-home-station:nth-child(2):not(.is-active) {
    color: #0aa967;
  }

  [data-inventory-home] .inv-home-station:nth-child(3):not(.is-active) {
    color: #7d35ff;
  }

  [data-inventory-home] .inv-home-task-card {
    border: 1px solid #e2ebf7;
    border-radius: 14px;
    background: #ffffff;
    box-shadow: 0 12px 28px rgba(15, 40, 80, 0.05);
    overflow: hidden;
  }

  [data-inventory-home] .inv-home-task-card__header {
    min-height: 96px;
    padding: 24px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid #e9eff7;
  }

  [data-inventory-home] .inv-home-task-card__header h2 {
    margin: 0;
    font-size: 28px;
    font-weight: 950;
    color: #0b1b3f;
  }

  [data-inventory-home] .inv-home-task-card__header p {
    margin: 0;
    color: #5b6b88;
    font-size: 16px;
    font-weight: 750;
  }

  [data-inventory-home] .inv-station-content-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    padding: 24px 28px 28px;
  }

  [data-inventory-home] .inv-station-nav-card {
    min-height: 94px;
    border: 1px solid #e6edf7;
    border-radius: 14px;
    background: #ffffff;
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr) 28px;
    align-items: center;
    gap: 16px;
    padding: 16px 18px;
    text-align: right;
    cursor: pointer;
    color: #0b1b3f;
    box-shadow: 0 8px 18px rgba(15, 40, 80, 0.04);
  }

  [data-inventory-home] .inv-station-nav-card:hover {
    background: #fbfdff;
    border-color: #cfe0fb;
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
    color: #f04438;
    background: #ffe7e7;
  }

  [data-inventory-home] .inv-station-nav-card__icon--success {
    color: #0aa967;
    background: #e5f9ee;
  }

  [data-inventory-home] .inv-station-nav-card__icon--purple {
    color: #7d35ff;
    background: #f1e7ff;
  }

  [data-inventory-home] .inv-station-nav-card__icon--blue {
    color: #0f6fff;
    background: #e9f2ff;
  }

  [data-inventory-home] .inv-station-nav-card__icon--warning {
    color: #ef7d00;
    background: #fff1e4;
  }

  [data-inventory-home] .inv-station-nav-card__copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  [data-inventory-home] .inv-station-nav-card__title {
    color: #0b1b3f;
    font-size: 18px;
    line-height: 1.25;
    font-weight: 950;
  }

  [data-inventory-home] .inv-station-nav-card__meta {
    color: #5b6b88;
    font-size: 14px;
    line-height: 1.4;
    font-weight: 650;
  }

  [data-inventory-home] .inv-station-nav-card__chevron {
    color: #23446f;
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
      border-bottom: 1px solid #e8eef7;
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
