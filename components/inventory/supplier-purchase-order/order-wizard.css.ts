export const orderWizardCss = `
[data-order-wizard] {
  direction: rtl;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: #0f172a;
}

[data-inventory-subpage]:has([data-order-wizard]) .inv-subpage-main {
  max-width: 680px;
}

.owz-progress {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  padding: 12px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.04);
}

.owz-progress__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.owz-progress__step {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: #94a3b8;
}

.owz-progress__node {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #f1f5f9;
  color: #64748b;
  font-size: 0.78rem;
  font-weight: 900;
}

.owz-progress__label {
  font-size: 0.72rem;
  font-weight: 850;
  line-height: 1.25;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.owz-progress__step.is-current .owz-progress__node {
  background: #0f766e;
  color: #ffffff;
}

.owz-progress__step.is-current .owz-progress__label {
  color: #0f766e;
}

.owz-progress__step.is-done .owz-progress__node {
  background: #dcfce7;
  color: #166534;
}

.owz-step,
.owz-order-doc,
.owz-state-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 20px;
  padding: 18px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.04);
}

.owz-step__head {
  margin-bottom: 16px;
}

.owz-step__eyebrow {
  display: inline-flex;
  width: fit-content;
  margin-bottom: 8px;
  border-radius: 999px;
  background: #ecfdf5;
  color: #0f766e;
  padding: 5px 10px;
  font-size: 0.72rem;
  font-weight: 900;
}

.owz-step__title,
.owz-order-doc__title {
  margin: 0;
  color: #0f172a;
  font-size: 1.3rem;
  line-height: 1.25;
  font-weight: 900;
}

.owz-step__sub,
.owz-order-doc__meta,
.owz-order-doc__footnote {
  margin: 8px 0 0;
  color: #64748b;
  font-size: 0.9rem;
  line-height: 1.55;
}

.owz-step__content,
.owz-order-doc__items {
  display: grid;
  gap: 12px;
}

.owz-filters-bar {
  display: grid;
  gap: 10px;
}

.owz-filters-bar__input,
.owz-order-doc__supplier,
.owz-cart-detail-row__cost-input {
  width: 100%;
  min-height: 46px;
  border: 1px solid #dbe3ef;
  border-radius: 14px;
  background: #ffffff;
  color: #0f172a;
  padding: 10px 12px;
  box-sizing: border-box;
  font: inherit;
}

.owz-products-list,
.owz-cart-detail-list,
.owz-order-doc__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.owz-product-detail-row,
.owz-cart-detail-row,
.owz-order-doc__row {
  border: 1px solid #e5e7eb;
  border-radius: 17px;
  background: #ffffff;
  padding: 12px;
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
}

.owz-product-detail-row.is-in-cart,
.owz-cart-detail-row.is-suggested {
  border-color: #bbf7d0;
  background: #f0fdf4;
}

.owz-product-detail-row__thumb,
.owz-cart-detail-row__thumb,
.owz-order-doc__row-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.owz-product-detail-row__info,
.owz-cart-detail-row__info {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.owz-product-detail-row__name,
.owz-cart-detail-row__name,
.owz-order-doc__row-name {
  color: #0f172a;
  font-weight: 900;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.owz-product-detail-row__meta,
.owz-cart-detail-row__meta,
.owz-cart-detail-row__tag,
.owz-product-detail-row__incart {
  color: #64748b;
  font-size: 0.78rem;
  line-height: 1.35;
}

.owz-product-detail-row__add,
.owz-cart-detail-row__remove,
.owz-step__next,
.owz-step__back,
.owz-step__empty-cta,
.owz-order-doc__submit,
.owz-order-doc__secondary {
  min-height: 44px;
  border-radius: 14px;
  border: 1px solid #dbe3ef;
  background: #ffffff;
  color: #0f172a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 14px;
  font: inherit;
  font-weight: 900;
  text-decoration: none;
  cursor: pointer;
}

.owz-product-detail-row__add,
.owz-step__next,
.owz-order-doc__submit {
  border: 0;
  background: #0f766e;
  color: #ffffff;
}

.owz-product-detail-row__add {
  width: 42px;
  height: 42px;
  padding: 0;
  font-size: 1.3rem;
}

.owz-step__next:disabled,
.owz-order-doc__submit:disabled {
  background: #cbd5e1;
  cursor: not-allowed;
}

.owz-step__actions,
.owz-order-doc__actions {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}

.owz-step__empty,
.owz-order-doc__empty {
  border: 1px dashed #cbd5e1;
  border-radius: 17px;
  background: #f8fafc;
  padding: 20px;
  color: #64748b;
  text-align: center;
  line-height: 1.55;
}

.owz-step__empty-title {
  color: #0f172a;
  font-weight: 900;
  margin-bottom: 6px;
}

.owz-cart-detail-row {
  grid-template-columns: 52px minmax(0, 1fr);
}

.owz-cart-detail-row__qty,
.owz-cart-detail-row__cost {
  grid-column: 1 / -1;
}

.owz-cart-detail-row__qty {
  display: grid;
  grid-template-columns: 44px 1fr 44px;
  border: 1px solid #dbe3ef;
  border-radius: 14px;
  overflow: hidden;
}

.owz-cart-detail-row__qty-btn {
  border: 0;
  background: #f8fafc;
  color: #0f172a;
  font: inherit;
  font-weight: 900;
}

.owz-cart-detail-row__qty-val {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 900;
}

.owz-cart-detail-row__cost {
  display: grid;
  gap: 6px;
}

.owz-cart-detail-row__cost-label {
  color: #64748b;
  font-size: 0.78rem;
  font-weight: 800;
}

.owz-cart-detail-row__remove {
  grid-column: 1 / -1;
  border-color: #fecaca;
  color: #991b1b;
  background: #fef2f2;
}

.owz-cart-summary {
  border: 1px solid #bbf7d0;
  border-radius: 17px;
  background: #f0fdf4;
  padding: 14px;
  display: grid;
  gap: 8px;
  color: #166534;
}

.owz-cart-summary__label {
  font-weight: 900;
}

.owz-cart-summary__clear {
  min-height: 40px;
  border-radius: 12px;
  border: 1px solid #bbf7d0;
  background: #ffffff;
  color: #166534;
  font: inherit;
  font-weight: 900;
}

.owz-order-doc__header {
  margin-bottom: 16px;
}

.owz-order-doc__supplier-line {
  margin-top: 14px;
  display: grid;
  gap: 6px;
  color: #475569;
  font-size: 0.82rem;
  font-weight: 850;
}

.owz-order-doc__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.owz-order-doc__row {
  grid-template-columns: 42px minmax(0, 1fr);
}

.owz-order-doc__row-qty,
.owz-order-doc__row-unit,
.owz-order-doc__row-cost {
  color: #64748b;
  font-size: 0.82rem;
  font-weight: 800;
}

@media (min-width: 720px) {
  [data-inventory-subpage]:has([data-order-wizard]) .inv-subpage-main {
    max-width: 760px;
  }

  .owz-filters-bar {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .owz-step__actions,
  .owz-order-doc__actions {
    grid-template-columns: 1fr 1fr;
  }

  .owz-cart-detail-row {
    grid-template-columns: 52px minmax(0, 1fr) 130px 120px 44px;
  }

  .owz-cart-detail-row__qty,
  .owz-cart-detail-row__cost,
  .owz-cart-detail-row__remove {
    grid-column: auto;
  }

  .owz-order-doc__row {
    grid-template-columns: 42px minmax(0, 1fr) 60px 70px 90px;
  }
}

@media (max-width: 390px) {
  .owz-progress__list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
`;
