/**
 * Inventory primitives stylesheet — scoped to [data-inventory-module].
 *
 * Pixel structure follows docs/docsdesign/inventory_screens.html.txt; all colors
 * come from the --inv-* tokens (lib/design/tokens.ts → inventory-tokens.ts), never
 * the mockup's hardcoded values. Interaction-heavy primitives (Bottom Sheet, Modal)
 * live here because they need animations and media queries.
 */
export const inventoryPrimitivesCss = `
  /* ===== unified header (hub + page) ===== */
  [data-inventory-module] .inv-hd {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    max-width: var(--inv-content-max, 720px);
    margin: 0 auto;
    padding: 8px clamp(16px, 3.5vw, 28px) 6px;
    box-sizing: border-box;
  }
  [data-inventory-module] .inv-hd--page {
    position: sticky;
    top: 0;
    z-index: 40;
    background: rgba(251, 250, 246, 0.92);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border-bottom: 1px solid var(--inv-border);
    padding-top: 12px;
    padding-bottom: 10px;
  }
  [data-inventory-module] .inv-hd__grow { flex: 1; min-width: 0; }
  [data-inventory-module] .inv-hd__title-hub {
    font-size: clamp(22px, 5.5vw, 26px);
    font-weight: 600;
    letter-spacing: -0.4px;
    color: var(--inv-text);
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-inventory-module] .inv-hd__title-page {
    flex: 1;
    text-align: center;
    font-size: 17px;
    font-weight: 600;
    color: var(--inv-text);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-inventory-module] .inv-iconbtn {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    background: var(--inv-glass-bg);
    border: var(--inv-glass-border);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    cursor: pointer;
    color: var(--inv-glass-text);
    font-family: inherit;
    padding: 0;
    box-shadow: var(--inv-glass-shadow);
    backdrop-filter: blur(12px);
  }
  [data-inventory-module] .inv-iconbtn--acc {
    background: var(--inv-primary);
    border: var(--inv-primary-border);
    color: var(--inv-on-accent);
    box-shadow: var(--inv-primary-shadow-soft);
  }
  [data-inventory-module] .inv-iconbtn--ghost {
    background: transparent;
    border: 0;
    cursor: default;
    visibility: hidden;
  }
  [data-inventory-module] .inv-hd__sub {
    width: 100%;
    max-width: var(--inv-content-max, 720px);
    margin: -2px auto 0;
    padding: 0 clamp(16px, 3.5vw, 28px);
    color: var(--inv-text-muted);
    font-size: 14px;
    font-weight: 600;
    box-sizing: border-box;
  }
  [data-inventory-module] .inv-hd__sub b { color: var(--inv-danger); }

  /* ===== segmented control ===== */
  [data-inventory-module] .inv-seg { display: flex; gap: 6px; flex-wrap: wrap; }
  [data-inventory-module] .inv-segbtn {
    padding: 9px 14px;
    border-radius: 11px;
    border: 1px solid var(--inv-border);
    background: var(--inv-glass-bg);
    font-family: inherit;
    font-weight: 600;
    font-size: 14px;
    color: var(--inv-glass-text);
    cursor: pointer;
    box-shadow: var(--inv-glass-shadow);
  }
  [data-inventory-module] .inv-segbtn.is-on {
    background: var(--inv-primary);
    color: var(--inv-on-accent);
    border: var(--inv-primary-border);
    box-shadow: var(--inv-primary-shadow-soft);
  }

  /* ===== filter chips ===== */
  [data-inventory-module] .inv-chips {
    display: flex;
    gap: 8px;
    width: 100%;
    max-width: var(--inv-content-max, 720px);
    margin-inline: auto;
    padding: 14px clamp(16px, 3.5vw, 28px) 2px;
    overflow-x: auto;
    box-sizing: border-box;
  }
  [data-inventory-module] .inv-chips::-webkit-scrollbar { display: none; }
  [data-inventory-module] .inv-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 15px;
    height: 40px;
    border-radius: 22px;
    background: var(--inv-glass-bg);
    border: var(--inv-glass-border);
    font-family: inherit;
    font-weight: 600;
    font-size: 14.5px;
    color: var(--inv-glass-text);
    white-space: nowrap;
    flex-shrink: 0;
    cursor: pointer;
    box-shadow: var(--inv-glass-shadow);
  }
  [data-inventory-module] .inv-chip.is-on {
    background: var(--inv-primary);
    color: var(--inv-on-accent);
    border: var(--inv-primary-border);
    box-shadow: var(--inv-primary-shadow-soft);
  }
  [data-inventory-module] .inv-chip__dot { width: 8px; height: 8px; border-radius: 50%; }

  /* ===== steppers ===== */
  [data-inventory-module] .inv-stepper {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 20px;
    margin: 8px 0 4px;
  }
  [data-inventory-module] .inv-stepper__btn {
    width: 50px;
    height: 50px;
    border-radius: 15px;
    border: 1px solid var(--inv-border);
    background: var(--inv-surface, var(--dz-surface-muted));
    font-size: 26px;
    font-weight: 600;
    color: var(--inv-text);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-family: inherit;
  }
  [data-inventory-module] .inv-stepper__val {
    font-size: 38px;
    font-weight: 600;
    min-width: 80px;
    text-align: center;
    letter-spacing: -1px;
  }
  [data-inventory-module] .inv-ministep {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--inv-surface, var(--dz-surface-muted));
    border-radius: 12px;
    padding: 4px;
    flex-shrink: 0;
  }
  [data-inventory-module] .inv-ministep button {
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 9px;
    background: var(--inv-card-bg);
    font-size: 19px;
    font-weight: 600;
    color: var(--inv-text);
    cursor: pointer;
    font-family: inherit;
  }
  [data-inventory-module] .inv-ministep button:disabled { opacity: 0.4; cursor: not-allowed; }
  [data-inventory-module] .inv-ministep span {
    min-width: 34px;
    text-align: center;
    font-weight: 600;
    font-size: 17px;
  }

  /* ===== decision card / chips / confidence ===== */
  [data-inventory-module] .inv-dcard {
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-md);
    padding: 14px;
    margin-bottom: 12px;
    background: var(--inv-card-bg);
  }
  [data-inventory-module] .inv-dcard__top { display: flex; align-items: center; gap: 12px; }
  [data-inventory-module] .inv-dchips { display: flex; gap: 8px; margin-top: 13px; }
  [data-inventory-module] .inv-dchip {
    flex: 1;
    min-height: 42px;
    border-radius: 11px;
    border: 1px solid var(--inv-border);
    background: var(--inv-card-bg);
    font-family: inherit;
    font-weight: 600;
    font-size: 13.5px;
    color: var(--inv-text);
    cursor: pointer;
  }
  [data-inventory-module] .inv-dchip.is-pri {
    background: var(--inv-accent);
    color: var(--inv-on-accent);
    border-color: var(--inv-accent);
  }
  [data-inventory-module] .inv-dchip:disabled { opacity: 0.5; cursor: not-allowed; }
  [data-inventory-module] .inv-conf {
    font-size: 11.5px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 18px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  [data-inventory-module] .inv-conf--high { background: var(--inv-success-bg); color: var(--inv-success); }
  [data-inventory-module] .inv-conf--mid { background: var(--inv-warning-bg); color: var(--inv-warning-ink); }
  [data-inventory-module] .inv-conf--low { background: var(--inv-danger-bg); color: var(--inv-danger); }

  /* ===== bottom action bar / save bar ===== */
  [data-inventory-module] .inv-bottombar,
  [data-inventory-module] .inv-savebar {
    position: sticky;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 30;
    /* Fade content out beneath the CTA instead of a hard white slab. */
    background: linear-gradient(to top, var(--inv-page-bg) 62%, transparent);
    padding: 22px clamp(16px, 3.5vw, 28px) calc(20px + env(safe-area-inset-bottom, 0px));
    box-sizing: border-box;
  }
  [data-inventory-module] .inv-bottombar__inner,
  [data-inventory-module] .inv-savebar__inner {
    width: 100%;
    max-width: var(--inv-content-max, 720px);
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  [data-inventory-module] .inv-bottombar__tot { flex: 1; min-width: 0; }
  [data-inventory-module] .inv-bottombar__tl { font-size: 12px; color: var(--inv-text-muted); font-weight: 600; }
  [data-inventory-module] .inv-bottombar__tv { font-size: 21px; font-weight: 600; letter-spacing: -0.5px; color: var(--inv-text); }
  [data-inventory-module] .inv-bottombar__go {
    min-height: 52px;
    padding: 0 26px;
    border-radius: var(--inv-radius-button);
    border: var(--inv-primary-border);
    background: var(--inv-primary);
    color: var(--inv-on-accent);
    font-family: inherit;
    font-weight: 600;
    font-size: 16px;
    cursor: pointer;
    box-shadow: var(--inv-primary-shadow);
    flex-shrink: 0;
  }
  [data-inventory-module] .inv-bottombar__go:disabled { background: var(--inv-surface-2); box-shadow: none; cursor: not-allowed; }
  [data-inventory-module] .inv-savebar__btn {
    width: 100%;
    min-height: 54px;
    border: 0;
    border-radius: var(--inv-radius-button);
    border: var(--inv-primary-border);
    background: var(--inv-primary);
    color: var(--inv-on-accent);
    font-family: inherit;
    font-size: 17px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: var(--inv-primary-shadow);
  }
  [data-inventory-module] .inv-savebar__btn:disabled { background: var(--inv-surface-2); box-shadow: none; cursor: not-allowed; }

  /* ===== bottom sheet ===== */
  [data-inventory-module] .inv-scrim {
    position: fixed;
    inset: 0;
    background: var(--inv-backdrop);
    /* Above the global BottomBar (z-index 100) so the sheet + its confirm
       footer are not covered/intercepted by the bottom navigation. */
    z-index: 200;
    animation: invScrimIn 0.18s ease-out;
  }
  [data-inventory-module] .inv-sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 201;
    margin: 0 auto;
    max-width: var(--inv-content-max, 720px);
    background: var(--inv-card-bg);
    border-radius: 24px 24px 0 0;
    padding: 8px clamp(16px, 3.5vw, 28px) calc(30px + env(safe-area-inset-bottom, 0px));
    box-shadow: var(--inv-shadow-overlay);
    max-height: 92vh;
    overflow-y: auto;
    animation: invSheetIn 0.24s cubic-bezier(0.22, 1, 0.36, 1);
    box-sizing: border-box;
  }
  [data-inventory-module] .inv-sheet__grab {
    width: 42px;
    height: 5px;
    border-radius: 3px;
    background: var(--inv-border);
    margin: 6px auto 14px;
  }
  [data-inventory-module] .inv-sheet h3 { font-size: 20px; font-weight: 600; color: var(--inv-text); margin: 0; }
  [data-inventory-module] .inv-sheet__who { font-size: 13.5px; color: var(--inv-text-muted); font-weight: 600; margin: 2px 0 16px; }
  [data-inventory-module] .inv-sheet__actions { display: flex; gap: 11px; margin-top: 6px; }
  [data-inventory-module] .inv-sheet__ghost {
    flex: 1;
    min-height: 52px;
    border-radius: var(--inv-radius-button);
    border: var(--inv-glass-border);
    background: var(--inv-glass-bg);
    font-family: inherit;
    font-weight: 600;
    font-size: 16px;
    color: var(--inv-glass-text);
    cursor: pointer;
    box-shadow: var(--inv-glass-shadow);
    backdrop-filter: blur(12px);
  }
  [data-inventory-module] .inv-sheet__fill {
    flex: 1.5;
    min-height: 52px;
    border-radius: var(--inv-radius-button);
    border: var(--inv-primary-border);
    background: var(--inv-primary);
    color: var(--inv-on-accent);
    font-family: inherit;
    font-weight: 600;
    font-size: 16px;
    cursor: pointer;
    box-shadow: var(--inv-primary-shadow);
  }
  [data-inventory-module] .inv-sheet__fill:disabled { background: var(--inv-surface-2); box-shadow: none; cursor: not-allowed; }

  @keyframes invScrimIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes invSheetIn { from { transform: translateY(100%); } to { transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) {
    [data-inventory-module] .inv-sheet,
    [data-inventory-module] .inv-scrim { animation: none; }
  }

  /* ===== confirm modal ===== */
  [data-inventory-module] .inv-modal-scrim {
    position: fixed;
    inset: 0;
    /* Above the global BottomBar (z-index 100) so the modal + its actions are
       not covered or click-intercepted by the bottom navigation. */
    z-index: 210;
    background: var(--inv-backdrop);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 18px;
    animation: invScrimIn 0.18s ease-out;
  }
  [data-inventory-module] .inv-modal {
    width: 100%;
    max-width: 360px;
    border-radius: var(--inv-radius-lg);
    background: var(--inv-card-bg);
    box-shadow: var(--inv-shadow-overlay);
    padding: 22px 20px;
    text-align: center;
  }
  [data-inventory-module] .inv-modal h3 { font-size: 19px; font-weight: 600; color: var(--inv-text); margin: 0 0 8px; }
  [data-inventory-module] .inv-modal p { font-size: 14px; font-weight: 600; color: var(--inv-text-muted); line-height: 1.55; margin: 0 0 18px; }
  [data-inventory-module] .inv-modal__actions { display: flex; gap: 11px; }
  [data-inventory-module] .inv-modal__ghost {
    flex: 1;
    min-height: 50px;
    border-radius: var(--inv-radius-button);
    border: var(--inv-glass-border);
    background: var(--inv-glass-bg);
    font-family: inherit;
    font-weight: 600;
    font-size: 15px;
    color: var(--inv-glass-text);
    cursor: pointer;
    box-shadow: var(--inv-glass-shadow);
  }
  [data-inventory-module] .inv-modal__confirm {
    flex: 1.4;
    min-height: 50px;
    border-radius: var(--inv-radius-button);
    border: var(--inv-primary-border);
    background: var(--inv-primary);
    color: var(--inv-on-accent);
    font-family: inherit;
    font-weight: 600;
    font-size: 15px;
    cursor: pointer;
    box-shadow: var(--inv-primary-shadow);
  }
  [data-inventory-module] .inv-modal__confirm--danger {
    background: var(--inv-danger);
    box-shadow: 0 6px 18px rgba(155, 70, 52, 0.28);
  }

  /* ===== order/cart/receiving line (mockup .oline) ===== */
  [data-inventory-module] .inv-olines {
    width: 100%;
    max-width: var(--inv-content-max, 720px);
    margin: 0 auto;
    padding: 14px clamp(16px, 3.5vw, 28px) 0;
    box-sizing: border-box;
  }
  [data-inventory-module] .inv-oline {
    display: flex;
    align-items: center;
    gap: 12px;
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-md);
    padding: 12px;
    margin-bottom: 11px;
    background: var(--inv-card-bg);
    box-sizing: border-box;
    flex-wrap: wrap;
  }
  [data-inventory-module] .inv-oline__mid { flex: 1; min-width: 0; }
  [data-inventory-module] .inv-oline__nm {
    font-size: 16px;
    font-weight: 600;
    color: var(--inv-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  [data-inventory-module] .inv-oline__sub {
    font-size: 12.5px;
    color: var(--inv-text-muted);
    font-weight: 600;
    margin-top: 2px;
  }
  [data-inventory-module] .inv-oline__price {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.5px;
    color: var(--inv-text);
    white-space: nowrap;
  }
  [data-inventory-module] .inv-oline__remove {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    border: 1px solid var(--inv-danger-border);
    background: var(--inv-danger-bg);
    color: var(--inv-danger);
    font-size: 18px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
    line-height: 1;
  }

  /* ===== movement preview (mockup .preview) ===== */
  [data-inventory-module] .inv-preview {
    text-align: center;
    color: var(--inv-text-muted);
    font-weight: 600;
    font-size: 14.5px;
    margin: 6px 0 16px;
  }
  [data-inventory-module] .inv-preview b { color: var(--inv-text); font-size: 16px; }

  /* select styled as the mockup reason row */
  [data-inventory-module] select.inv-input {
    -webkit-appearance: none;
    appearance: none;
    cursor: pointer;
  }

  /* ===== wizard steps ===== */
  [data-inventory-module] .inv-steps {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 12px 18px 2px;
    font-size: 13px;
    font-weight: 600;
    flex-wrap: wrap;
  }
  [data-inventory-module] .inv-steps__s {
    padding: 6px 13px;
    border-radius: 18px;
    background: var(--inv-surface, var(--dz-surface-muted));
    color: var(--inv-text-muted);
  }
  [data-inventory-module] .inv-steps__s.is-on { background: var(--inv-accent); color: var(--inv-on-accent); }
  [data-inventory-module] .inv-steps__arr { color: var(--inv-text-tertiary); }

  /* ===== form fields (mockup .f-wrap / .field) ===== */
  [data-inventory-module] .inv-fwrap {
    width: 100%;
    max-width: var(--inv-content-max, 720px);
    margin: 0 auto;
    padding: 6px clamp(16px, 3.5vw, 28px) 0;
    box-sizing: border-box;
  }
  [data-inventory-module] .inv-field { margin-top: 16px; }
  [data-inventory-module] .inv-field__lab { font-size: 14px; font-weight: 600; margin-bottom: 7px; color: var(--inv-text); }
  [data-inventory-module] .inv-field__lab span { color: var(--inv-danger); }
  [data-inventory-module] .inv-input {
    width: 100%;
    min-height: 50px;
    border: 1px solid var(--inv-border);
    border-radius: 12px;
    background: var(--inv-surface, var(--dz-surface-muted));
    padding: 0 14px;
    font-family: inherit;
    font-size: 15.5px;
    color: var(--inv-text);
    outline: none;
    box-sizing: border-box;
  }
  [data-inventory-module] .inv-input:focus {
    border-color: var(--inv-accent);
    background: var(--inv-card-bg);
    box-shadow: 0 0 0 3px var(--inv-focus, rgba(36, 105, 102, 0.22));
  }
  [data-inventory-module] .inv-field__help { font-size: 12px; color: var(--inv-text-muted); font-weight: 500; margin-top: 6px; }
  [data-inventory-module] .inv-field__err { font-size: 12.5px; color: var(--inv-danger, var(--dz-danger-accent)); font-weight: 600; margin-top: 6px; line-height: 1.45; }
  [data-inventory-module] .inv-input--err { border-color: var(--inv-danger) !important; box-shadow: 0 0 0 3px var(--inv-danger-bg) !important; }
  [data-inventory-module] .inv-two { display: flex; gap: 11px; }
  [data-inventory-module] .inv-two > .inv-field { flex: 1; }

  /* ===== product detail body (hero / status block / kv / movement) ===== */
  [data-inventory-module] .inv-hero {
    margin: 8px auto 0;
    max-width: var(--inv-content-max, 720px);
    height: 150px;
    border-radius: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 64px;
    overflow: hidden;
  }
  [data-inventory-module] .inv-hero img { width: 100%; height: 100%; object-fit: cover; }
  [data-inventory-module] .inv-dname {
    padding: 16px clamp(16px, 3.5vw, 28px) 2px;
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.4px;
    color: var(--inv-text);
    max-width: var(--inv-content-max, 720px);
    margin: 0 auto;
  }
  [data-inventory-module] .inv-dtags {
    display: flex;
    gap: 8px;
    padding: 0 clamp(16px, 3.5vw, 28px);
    flex-wrap: wrap;
    max-width: var(--inv-content-max, 720px);
    margin: 0 auto;
  }
  [data-inventory-module] .inv-tag {
    background: var(--inv-surface, var(--dz-surface-muted));
    color: var(--inv-text-muted);
    font-size: 12.5px;
    font-weight: 600;
    padding: 5px 11px;
    border-radius: 18px;
  }
  [data-inventory-module] .inv-statusblock {
    margin: 16px auto 0;
    max-width: var(--inv-content-max, 720px);
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-md);
    padding: 15px;
    box-sizing: border-box;
  }
  [data-inventory-module] .inv-statusblock__top { display: flex; align-items: center; justify-content: space-between; }
  [data-inventory-module] .inv-bigqty { font-size: 34px; font-weight: 600; letter-spacing: -1px; color: var(--inv-text); }
  [data-inventory-module] .inv-bigqty small { font-size: 14px; font-weight: 600; color: var(--inv-text-muted); }
  [data-inventory-module] .inv-track { height: 6px; background: var(--inv-surface-2, var(--dz-surface-muted)); border-radius: 4px; overflow: hidden; }
  [data-inventory-module] .inv-track__fill { height: 100%; border-radius: 4px; }
  [data-inventory-module] .inv-barcap { font-size: 11.5px; color: var(--inv-text-muted); font-weight: 600; margin-top: 5px; }
  [data-inventory-module] .inv-seclabel {
    padding: 22px clamp(16px, 3.5vw, 28px) 8px;
    font-size: 18px;
    font-weight: 600;
    color: var(--inv-text);
    max-width: var(--inv-content-max, 720px);
    margin: 0 auto;
  }
  [data-inventory-module] .inv-kv {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--inv-border);
    margin: 0 auto;
    max-width: var(--inv-content-max, 720px);
    border-radius: var(--inv-radius-md);
    overflow: hidden;
    border: 1px solid var(--inv-border);
    box-sizing: border-box;
  }
  [data-inventory-module] .inv-kv > div { background: var(--inv-card-bg); padding: 12px 14px; }
  [data-inventory-module] .inv-kv .inv-kv__k { font-size: 12px; color: var(--inv-text-muted); font-weight: 600; }
  [data-inventory-module] .inv-kv .inv-kv__v { font-size: 15.5px; font-weight: 600; margin-top: 2px; color: var(--inv-text); }
  [data-inventory-module] .inv-mv {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px clamp(16px, 3.5vw, 28px);
    border-bottom: 1px solid var(--inv-border);
    max-width: var(--inv-content-max, 720px);
    margin: 0 auto;
    box-sizing: border-box;
  }
  [data-inventory-module] .inv-mv:last-child { border-bottom: 0; }
  [data-inventory-module] .inv-mv__ic {
    width: 38px;
    height: 38px;
    border-radius: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 17px;
  }
  [data-inventory-module] .inv-mv__mid { flex: 1; min-width: 0; }
  [data-inventory-module] .inv-mv__r { font-size: 15px; font-weight: 600; color: var(--inv-text); }
  [data-inventory-module] .inv-mv__s { font-size: 12px; color: var(--inv-text-muted); font-weight: 500; margin-top: 1px; }
  [data-inventory-module] .inv-delta { font-size: 16px; font-weight: 600; white-space: nowrap; }
  [data-inventory-module] .inv-delta--up { color: var(--inv-success); }
  [data-inventory-module] .inv-delta--down { color: var(--inv-danger); }
  [data-inventory-module] .inv-detail-actions {
    display: flex;
    gap: 9px;
    padding: 14px clamp(16px, 3.5vw, 28px) 0;
    max-width: var(--inv-content-max, 720px);
    margin: 0 auto;
  }
  [data-inventory-module] .inv-act {
    flex: 1;
    min-height: 50px;
    border-radius: 13px;
    border: var(--inv-glass-border);
    background: var(--inv-glass-bg);
    font-family: inherit;
    font-weight: 600;
    font-size: 14.5px;
    color: var(--inv-glass-text);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    cursor: pointer;
    box-shadow: var(--inv-glass-shadow);
    backdrop-filter: blur(12px);
  }
  [data-inventory-module] .inv-act--primary {
    border: var(--inv-primary-border);
    background: var(--inv-primary);
    color: var(--inv-on-accent);
    flex: 1.4;
    box-shadow: var(--inv-primary-shadow);
  }

  /* ===== search bar (mockup .search) ===== */
  [data-inventory-module] .inv-search {
    margin: 14px auto 0;
    width: 100%;
    max-width: var(--inv-content-max, 720px);
    background: var(--inv-card-bg);
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-md);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    min-height: 50px;
    box-sizing: border-box;
  }
  [data-inventory-module] .inv-search:focus-within {
    border-color: var(--inv-accent);
    box-shadow: 0 0 0 3px var(--inv-focus, rgba(36, 105, 102, 0.22));
  }
  [data-inventory-module] .inv-search input {
    border: 0;
    background: transparent;
    flex: 1;
    min-width: 0;
    font-family: inherit;
    font-size: 15.5px;
    color: var(--inv-text);
    outline: none;
  }
  [data-inventory-module] .inv-search input::placeholder { color: var(--inv-text-muted); }
  [data-inventory-module] .inv-search svg { flex-shrink: 0; color: var(--inv-text-muted); }
  [data-inventory-module] .inv-search .inv-search__scan { color: var(--inv-accent); }

  /* ===== product/list row (mockup .row) ===== */
  [data-inventory-module] .inv-rows {
    width: 100%;
    max-width: var(--inv-content-max, 720px);
    margin: 0 auto;
    padding: 12px clamp(16px, 3.5vw, 28px) 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
  [data-inventory-module] .inv-row {
    display: flex;
    align-items: center;
    gap: 12px;
    border: 1px solid var(--inv-border);
    border-radius: var(--inv-radius-md);
    padding: 12px;
    margin-bottom: 11px;
    background: var(--inv-card-bg);
    width: 100%;
    text-align: right;
    font-family: inherit;
    cursor: pointer;
    box-sizing: border-box;
    color: inherit;
    text-decoration: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  [data-inventory-module] .inv-row:hover {
    border-color: var(--inv-border-hover);
    box-shadow: var(--inv-shadow-card-hover);
  }
  [data-inventory-module] .inv-row:active { background: var(--inv-surface-2); }
  [data-inventory-module] .inv-row:focus-visible {
    outline: 2px solid var(--inv-focus, rgba(36, 105, 102, 0.22));
    outline-offset: 2px;
  }
  [data-inventory-module] .inv-row__thumb {
    width: 54px;
    height: 54px;
    border-radius: 12px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 26px;
    overflow: hidden;
  }
  [data-inventory-module] .inv-row__thumb img { width: 100%; height: 100%; object-fit: cover; }
  [data-inventory-module] .inv-row__mid { flex: 1; min-width: 0; }
  [data-inventory-module] .inv-row__nm {
    font-size: 16px;
    font-weight: 600;
    color: var(--inv-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  [data-inventory-module] .inv-row__meta {
    font-size: 12.5px;
    color: var(--inv-text-muted);
    font-weight: 500;
    margin-top: 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  [data-inventory-module] .inv-row__barcap {
    font-size: 11.5px;
    color: var(--inv-text-muted);
    font-weight: 600;
    margin-top: 5px;
  }
  [data-inventory-module] .inv-row .inv-track { margin-top: 9px; }
  [data-inventory-module] .inv-row__trail {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 7px;
    flex-shrink: 0;
  }
  [data-inventory-module] .inv-row__pill {
    font-size: 11.5px;
    font-weight: 600;
    padding: 4px 9px;
    border-radius: 20px;
    white-space: nowrap;
  }
  [data-inventory-module] .inv-row__qty {
    font-size: 22px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: -0.5px;
    color: var(--inv-text);
  }
  [data-inventory-module] .inv-row__qty small { font-size: 11.5px; font-weight: 600; color: var(--inv-text-muted); }
  [data-inventory-module] .inv-row__action {
    color: var(--inv-accent);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    background: transparent;
    border: 0;
    padding: 0;
    font-family: inherit;
    white-space: nowrap;
  }

  /* On narrow screens drop the stock bar (handled by hasBar prop / this hides leftover) */
  @media (max-width: 480px) {
    [data-inventory-module] .inv-row--compact .inv-track,
    [data-inventory-module] .inv-row--compact .inv-row__barcap { display: none; }
  }

  /* ===== desktop centering for page content ===== */
  [data-inventory-module] .inv-page-content {
    width: 100%;
    max-width: var(--inv-content-max, 720px);
    margin: 0 auto;
    box-sizing: border-box;
  }
`;
