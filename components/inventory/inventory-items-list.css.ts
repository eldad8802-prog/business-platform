export const inventoryItemsListCss = `
  [data-inventory-items-list] {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: 100%;
  }

  [data-inventory-items-list] .inv-items-list__header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  [data-inventory-items-list] .inv-items-list__title-block {
    min-width: 0;
  }

  [data-inventory-items-list] .inv-items-list__counts {
    margin: 4px 0 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--inv-muted, #777067);
  }

  [data-inventory-items-list] .inv-items-list__add-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 40px;
    padding: 0 16px;
    border: var(--inv-primary-border, 1px solid rgba(254, 248, 242, 0.22));
    border-radius: var(--inv-radius-button, 18px);
    background: var(--inv-primary);
    color: var(--inv-on-accent);
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: var(--inv-primary-shadow-soft, var(--inv-shadow-glow));
  }

  [data-inventory-items-list] .inv-items-list__add-btn:hover {
    background: var(--inv-primary);
  }

  [data-inventory-items-list] .inv-items-list__search-wrap {
    position: relative;
  }

  [data-inventory-items-list] .inv-items-list__search {
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
    padding: 10px 14px 10px 40px;
    border: 1px solid var(--inv-border, #E9DDD0);
    border-radius: 12px;
    background: var(--inv-surface, #FDF4EB);
    font-size: 14px;
    font-family: inherit;
    color: var(--inv-text, #2D2B28);
  }

  [data-inventory-items-list] .inv-items-list__search:focus {
    outline: 2px solid var(--inv-text);
    outline-offset: 1px;
  }

  [data-inventory-items-list] .inv-items-list__search-icon {
    position: absolute;
    top: 50%;
    inset-inline-start: 12px;
    transform: translateY(-50%);
    color: var(--inv-dim, #A79C8D);
    pointer-events: none;
    display: flex;
  }

  [data-inventory-items-list] .inv-items-list__filters {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  [data-inventory-items-list] .inv-items-list__filter-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  [data-inventory-items-list] .inv-items-list__filter-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--inv-muted, #777067);
    flex-shrink: 0;
    min-width: 52px;
  }

  [data-inventory-items-list] .inv-items-list__chip {
    border: 1px solid var(--inv-border, #E9DDD0);
    border-radius: 999px;
    background: var(--inv-card-bg);
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    color: var(--inv-text, #2D2B28);
    cursor: pointer;
    transition: background 0.1s ease, border-color 0.1s ease;
  }

  [data-inventory-items-list] .inv-items-list__chip:hover {
    background: var(--inv-surface-2);
  }

  [data-inventory-items-list] .inv-items-list__chip[data-active="true"] {
    border-color: var(--inv-success-border);
    background: var(--inv-success-bg);
    color: var(--inv-success);
  }

  [data-inventory-items-list] .inv-items-list__chip--critical[data-active="true"] {
    border-color: var(--inv-danger-border);
    background: var(--inv-danger-bg);
    color: var(--inv-danger);
  }

  [data-inventory-items-list] .inv-items-list__chip--low[data-active="true"] {
    border-color: var(--inv-warning-border);
    background: var(--inv-warning-bg);
    color: var(--inv-warning-ink);
  }

  [data-inventory-items-list] .inv-items-list__results {
    font-size: 12px;
    font-weight: 600;
    color: var(--inv-muted, #777067);
    margin: 0;
  }

  [data-inventory-items-list] .inv-items-list__panel {
    background: var(--inv-surface, #FDF4EB);
    border: 1px solid var(--inv-border, #E9DDD0);
    border-radius: var(--inv-radius-lg, 16px);
    box-shadow: var(--inv-shadow-sm, var(--inv-shadow));
    overflow: hidden;
  }

  [data-inventory-items-list] .inv-items-list__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  [data-inventory-items-list] .inv-items-list__row {
    display: grid;
    grid-template-columns: 48px minmax(0, 1.4fr) minmax(120px, 1fr) minmax(72px, 0.55fr) auto auto auto;
    align-items: center;
    gap: 18px;
    width: 100%;
    padding: 12px 20px;
    border: none;
    border-bottom: 1px solid var(--inv-border-soft, #F6ECDD);
    background: transparent;
    cursor: pointer;
    text-align: right;
    font-family: inherit;
    box-sizing: border-box;
    min-height: 64px;
    transition: background 0.1s ease;
  }

  [data-inventory-items-list] .inv-items-list__list li:last-child .inv-items-list__row {
    border-bottom: none;
  }

  [data-inventory-items-list] .inv-items-list__row:hover {
    background: var(--inv-surface-2);
  }

  [data-inventory-items-list] .inv-items-list__row:focus-visible {
    outline: 2px solid var(--inv-text);
    outline-offset: -2px;
    border-radius: 4px;
  }

  [data-inventory-items-list] .inv-items-list__thumb {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    object-fit: cover;
    border: 1px solid var(--inv-border, #E9DDD0);
    background: var(--inv-card-bg);
  }

  [data-inventory-items-list] .inv-items-list__thumb--ph {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--inv-surface-2);
    color: var(--inv-dim, #A79C8D);
  }

  [data-inventory-items-list] .inv-items-list__main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  [data-inventory-items-list] .inv-items-list__name {
    font-size: 14px;
    font-weight: 600;
    color: var(--inv-text, #2D2B28);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.3;
  }

  [data-inventory-items-list] .inv-items-list__meta {
    font-size: 12px;
    color: var(--inv-muted, #777067);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  [data-inventory-items-list] .inv-items-list__price {
    font-size: 13px;
    font-weight: 600;
    color: var(--inv-text, #2D2B28);
    white-space: nowrap;
    text-align: start;
  }

  [data-inventory-items-list] .inv-items-list__price--missing {
    font-size: 12px;
    font-weight: 600;
    color: var(--inv-warning-ink);
  }

  [data-inventory-items-list] .inv-items-list__bar {
    display: block;
    width: 100%;
    max-width: 220px;
  }

  [data-inventory-items-list] .inv-items-list__bar > div {
    height: 6px !important;
    border-radius: 999px !important;
  }

  [data-inventory-items-list] .inv-status-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 26px;
    padding: 0 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
    flex-shrink: 0;
  }

  [data-inventory-items-list] .inv-status-badge--ok {
    background: var(--inv-success-bg);
    color: var(--inv-success);
  }
  [data-inventory-items-list] .inv-status-badge--low {
    background: var(--inv-danger-bg);
    color: var(--inv-danger);
  }
  [data-inventory-items-list] .inv-status-badge--critical {
    background: var(--inv-danger-bg);
    color: var(--inv-danger);
  }

  [data-inventory-items-list] .inv-trend {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    flex-shrink: 0;
  }

  [data-inventory-items-list] .inv-trend--up { color: var(--inv-success); }
  [data-inventory-items-list] .inv-trend--down { color: var(--inv-danger); }

  [data-inventory-items-list] .inv-items-list__qty {
    font-family: var(--inv-mono, ui-monospace, monospace);
    font-variant-numeric: tabular-nums;
    font-size: 18px;
    font-weight: 600;
    flex-shrink: 0;
    text-align: end;
    min-width: 36px;
    line-height: 1;
    letter-spacing: -0.02em;
  }

  [data-inventory-items-list] .inv-items-list__row[data-tone="ok"] .inv-items-list__qty { color: var(--inv-success); }
  [data-inventory-items-list] .inv-items-list__row[data-tone="low"] .inv-items-list__qty,
  [data-inventory-items-list] .inv-items-list__row[data-tone="critical"] .inv-items-list__qty { color: var(--inv-danger); }

  [data-inventory-items-list] .inv-items-list__row--skeleton {
    display: block;
    min-height: 64px;
    background: linear-gradient(90deg, #F6ECDD 25%, #E9DDD0 50%, #F6ECDD 75%);
    background-size: 200% 100%;
    animation: inv-items-shimmer 1.4s ease infinite;
    border-bottom: 1px solid var(--inv-border-soft, #F6ECDD);
  }

  @keyframes inv-items-shimmer {
    0% { background-position: 100% 0; }
    100% { background-position: -100% 0; }
  }

  [data-inventory-items-list] .inv-items-list__empty {
    padding: 40px 20px 44px;
    text-align: center;
  }

  [data-inventory-items-list] .inv-items-list__empty-title {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--inv-text, #2D2B28);
  }

  [data-inventory-items-list] .inv-items-list__empty-hint {
    margin: 0 0 14px;
    font-size: 13px;
    color: var(--inv-muted, #777067);
  }

  [data-inventory-items-list] .inv-items-list__empty-btn {
    border: var(--inv-primary-border, 1px solid rgba(254, 248, 242, 0.22));
    border-radius: var(--inv-radius-button, 18px);
    background: var(--inv-primary);
    color: var(--inv-on-accent);
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    padding: 10px 18px;
    cursor: pointer;
    box-shadow: var(--inv-primary-shadow-soft, var(--inv-shadow-glow));
  }

  @media (max-width: 720px) {
    [data-inventory-items-list] .inv-items-list__row {
      grid-template-columns: 44px minmax(0, 1fr) auto;
      gap: 10px 12px;
    }

    [data-inventory-items-list] .inv-items-list__bar,
    [data-inventory-items-list] .inv-items-list__price,
    [data-inventory-items-list] .inv-items-list__badge-cell,
    [data-inventory-items-list] .inv-trend {
      display: none;
    }

    [data-inventory-items-list] .inv-items-list__thumb {
      width: 40px;
      height: 40px;
    }
  }
`;
