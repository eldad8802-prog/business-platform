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
    color: var(--inv-muted, #64748b);
  }

  [data-inventory-items-list] .inv-items-list__add-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 40px;
    padding: 0 16px;
    border: var(--inv-primary-border, 1px solid rgba(255, 255, 255, 0.22));
    border-radius: var(--inv-radius-button, 18px);
    background: var(--inv-primary);
    color: #fff;
    font-size: 14px;
    font-weight: 800;
    font-family: inherit;
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: var(--inv-primary-shadow-soft, 0 10px 22px rgba(19, 41, 68, 0.18));
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
    border: 1px solid var(--inv-border, #e5e7eb);
    border-radius: 12px;
    background: var(--inv-surface, #fff);
    font-size: 14px;
    font-family: inherit;
    color: var(--inv-text, #0f172a);
  }

  [data-inventory-items-list] .inv-items-list__search:focus {
    outline: 2px solid #0a0a0f;
    outline-offset: 1px;
  }

  [data-inventory-items-list] .inv-items-list__search-icon {
    position: absolute;
    top: 50%;
    inset-inline-start: 12px;
    transform: translateY(-50%);
    color: var(--inv-dim, #9ca3af);
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
    font-weight: 700;
    color: var(--inv-muted, #64748b);
    flex-shrink: 0;
    min-width: 52px;
  }

  [data-inventory-items-list] .inv-items-list__chip {
    border: 1px solid var(--inv-border, #e5e7eb);
    border-radius: 999px;
    background: #fff;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 700;
    font-family: inherit;
    color: var(--inv-text, #334155);
    cursor: pointer;
    transition: background 0.1s ease, border-color 0.1s ease;
  }

  [data-inventory-items-list] .inv-items-list__chip:hover {
    background: #f9fafb;
  }

  [data-inventory-items-list] .inv-items-list__chip[data-active="true"] {
    border-color: #059669;
    background: #ecfdf5;
    color: #047857;
  }

  [data-inventory-items-list] .inv-items-list__chip--critical[data-active="true"] {
    border-color: #dc2626;
    background: #fef2f2;
    color: #991b1b;
  }

  [data-inventory-items-list] .inv-items-list__chip--low[data-active="true"] {
    border-color: #f97316;
    background: #fff7ed;
    color: #c2410c;
  }

  [data-inventory-items-list] .inv-items-list__results {
    font-size: 12px;
    font-weight: 600;
    color: var(--inv-muted, #64748b);
    margin: 0;
  }

  [data-inventory-items-list] .inv-items-list__panel {
    background: var(--inv-surface, #fff);
    border: 1px solid var(--inv-border, #e5e7eb);
    border-radius: var(--inv-radius-lg, 16px);
    box-shadow: var(--inv-shadow-sm, 0 1px 3px rgba(15, 23, 42, 0.06));
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
    border-bottom: 1px solid var(--inv-border-soft, #f3f4f6);
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
    background: #f9fafb;
  }

  [data-inventory-items-list] .inv-items-list__row:focus-visible {
    outline: 2px solid #0a0a0f;
    outline-offset: -2px;
    border-radius: 4px;
  }

  [data-inventory-items-list] .inv-items-list__thumb {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    object-fit: cover;
    border: 1px solid var(--inv-border, #e5e7eb);
    background: #ffffff;
  }

  [data-inventory-items-list] .inv-items-list__thumb--ph {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f9fafb;
    color: var(--inv-dim, #9ca3af);
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
    color: var(--inv-text, #0f172a);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.3;
  }

  [data-inventory-items-list] .inv-items-list__meta {
    font-size: 12px;
    color: var(--inv-muted, #64748b);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  [data-inventory-items-list] .inv-items-list__price {
    font-size: 13px;
    font-weight: 700;
    color: var(--inv-text, #0f172a);
    white-space: nowrap;
    text-align: start;
  }

  [data-inventory-items-list] .inv-items-list__price--missing {
    font-size: 12px;
    font-weight: 600;
    color: #c2410c;
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
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
    flex-shrink: 0;
  }

  [data-inventory-items-list] .inv-status-badge--ok {
    background: #d1fae5;
    color: #047857;
  }
  [data-inventory-items-list] .inv-status-badge--low {
    background: #fee2e2;
    color: #b91c1c;
  }
  [data-inventory-items-list] .inv-status-badge--critical {
    background: #fecaca;
    color: #991b1b;
  }

  [data-inventory-items-list] .inv-trend {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    flex-shrink: 0;
  }

  [data-inventory-items-list] .inv-trend--up { color: #10b981; }
  [data-inventory-items-list] .inv-trend--down { color: #ef4444; }

  [data-inventory-items-list] .inv-items-list__qty {
    font-family: var(--inv-mono, ui-monospace, monospace);
    font-variant-numeric: tabular-nums;
    font-size: 18px;
    font-weight: 800;
    flex-shrink: 0;
    text-align: end;
    min-width: 36px;
    line-height: 1;
    letter-spacing: -0.02em;
  }

  [data-inventory-items-list] .inv-items-list__row[data-tone="ok"] .inv-items-list__qty { color: #059669; }
  [data-inventory-items-list] .inv-items-list__row[data-tone="low"] .inv-items-list__qty,
  [data-inventory-items-list] .inv-items-list__row[data-tone="critical"] .inv-items-list__qty { color: #dc2626; }

  [data-inventory-items-list] .inv-items-list__row--skeleton {
    display: block;
    min-height: 64px;
    background: linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 50%, #f3f4f6 75%);
    background-size: 200% 100%;
    animation: inv-items-shimmer 1.4s ease infinite;
    border-bottom: 1px solid var(--inv-border-soft, #f3f4f6);
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
    color: var(--inv-text, #0f172a);
  }

  [data-inventory-items-list] .inv-items-list__empty-hint {
    margin: 0 0 14px;
    font-size: 13px;
    color: var(--inv-muted, #64748b);
  }

  [data-inventory-items-list] .inv-items-list__empty-btn {
    border: var(--inv-primary-border, 1px solid rgba(255, 255, 255, 0.22));
    border-radius: var(--inv-radius-button, 18px);
    background: var(--inv-primary);
    color: #fff;
    font-size: 13px;
    font-weight: 800;
    font-family: inherit;
    padding: 10px 18px;
    cursor: pointer;
    box-shadow: var(--inv-primary-shadow-soft, 0 10px 22px rgba(19, 41, 68, 0.18));
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
