/**
 * `<quick-add-summary>` — the one piece of the quick add modal that cannot be
 * written in Liquid.
 *
 * @module @theme/quick-add
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { formatMoney, parseJSONScript, themeString, labelTarget } from '@theme/utilities';

/** What joins the label, the price and the chosen option on the add button. */
const SEPARATOR = ' · ';

export class QuickAddSummary extends BaseComponent {
  /** @type {Object|null} */
  #product = null;

  /** @type {Record<string, Array<{id:number,name:string,price:number}>>} */
  #allocations = {};

  /** @type {number|null} */
  #variantId = null;

  /** @type {number|null} */
  #planId = null;

  /** @type {number} */
  #quantity = 1;

  setup() {
    this.#product = parseJSONScript(this.root.querySelector?.('[data-quick-add-product]')) || null;
    this.#allocations = parseJSONScript(this.root.querySelector?.('[data-allocations]')) || {};

    const picker = this.root.querySelector?.('variant-picker');
    this.#variantId = Number(picker?.currentVariant?.id) || this.#firstVariantId();

    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => {
      this.#variantId = Number(event.detail?.variant?.id) || null;
      this.schedule();
    });

    this.on(this.root, EVENTS.VARIANT_UNAVAILABLE, () => {
      this.#variantId = null;
      this.schedule();
    });

    this.on(this.root, EVENTS.VARIANT_READY, (event) => {
      this.#variantId = Number(event.detail?.variant?.id) || null;
      this.schedule();
    });

    this.on(this.root, EVENTS.SELLING_PLAN_CHANGE, (event) => {
      const value = event.detail?.sellingPlan ?? event.detail?.selling_plan ?? null;
      this.#planId = value ? Number(value) : null;
      this.schedule();
    });

    this.on(this.root, EVENTS.QUANTITY_CHANGE, (event) => {
      const value = Number(event.detail?.quantity);
      if (Number.isFinite(value) && value > 0) this.#quantity = value;
      this.schedule();
    });

    this.schedule();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * The modal, not the document.
   *
   * @returns {HTMLElement|Document}
   */
  get root() {
    return this.closest('[data-quick-add-content]') || this.closest('[data-product-root]') || document;
  }

  /**
   * Run `render()` once the current event has finished being delivered.
   *
   * @returns {void}
   */
  schedule() {
    if (this.#pending) return;
    this.#pending = true;

    queueMicrotask(() => {
      this.#pending = false;
      this.render();
    });
  }

  /**
   * @returns {void}
   */
  render() {
    this.#renderPlanPrices();
    this.#renderButton();
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /** @type {boolean} */
  #pending = false;

  /**
   * @returns {number|null}
   * @private
   */
  #firstVariantId() {
    const first = this.#product?.variants?.find((variant) => variant.available) || this.#product?.variants?.[0];
    return first ? Number(first.id) : null;
  }

  /**
   * @returns {Object|null}
   * @private
   */
  get #variant() {
    if (!this.#variantId) return null;
    return this.#product?.variants?.find((variant) => Number(variant.id) === this.#variantId) || null;
  }

  /**
   * What one unit costs right now: the selling plan's price when one is chosen,
   * the variant's price otherwise.
   *
   * @returns {number|null} Cents.
   * @private
   */
  get #unitPrice() {
    const variant = this.#variant;
    if (!variant) return null;

    if (this.#planId) {
      const plans = this.#allocations?.[String(variant.id)] || [];
      const plan = plans.find((entry) => Number(entry.id) === this.#planId);
      if (plan && Number.isFinite(Number(plan.price))) return Number(plan.price);
    }

    return Number.isFinite(Number(variant.price)) ? Number(variant.price) : null;
  }

  /**
   * Keep each purchase-option card's price in step with the chosen variant.
   *
   * @private
   */
  #renderPlanPrices() {
    const variant = this.#variant;
    if (!variant) return;

    const oneTime = this.root.querySelector('[data-one-time-price] [data-price-current]');
    if (oneTime instanceof HTMLElement) oneTime.textContent = formatMoney(Number(variant.price));

    const oneTimeCompare = this.root.querySelector('[data-one-time-price] [data-price-compare]');
    if (oneTimeCompare instanceof HTMLElement) {
      const compare = Number(variant.compare_at_price);
      const show = Number.isFinite(compare) && compare > Number(variant.price);

      oneTimeCompare.textContent = show ? formatMoney(compare) : '';
      oneTimeCompare.toggleAttribute('hidden', !show);
    }

    this.#renderSaving('[data-one-time-price]', Number(variant.compare_at_price), Number(variant.price));

    const plans = this.#allocations?.[String(variant.id)] || [];
    const chosen = plans.find((entry) => Number(entry.id) === this.#planId) || plans[0];

    const planPrice = this.root.querySelector('[data-plan-price] [data-price-current]');
    if (planPrice instanceof HTMLElement && chosen) planPrice.textContent = formatMoney(Number(chosen.price));

    const planCompare = this.root.querySelector('[data-plan-price] [data-price-compare]');
    if (planCompare instanceof HTMLElement && chosen) {
      const compare = Number(chosen.compare_at_price);
      const show = Number.isFinite(compare) && compare > Number(chosen.price);

      planCompare.textContent = show ? formatMoney(compare) : '';
      planCompare.toggleAttribute('hidden', !show);
    }

    if (chosen) {
      this.#renderSaving('[data-plan-price]', Number(chosen.compare_at_price), Number(chosen.price));
    }
  }

  /**
   * Keep one card's saving badge in step with the price above it.
   *
   * @param {string} scope Selector for the card's price container.
   * @param {number} compare
   * @param {number} price
   * @private
   */
  #renderSaving(scope, compare, price) {
    const badge = this.root.querySelector(`${scope} [data-price-saving]`);
    if (!(badge instanceof HTMLElement)) return;

    const saving = Number.isFinite(compare) && Number.isFinite(price) && compare > price;
    badge.toggleAttribute('hidden', !saving);
    if (!saving) return;

    const percent = Math.round(((compare - price) / compare) * 100);
    badge.textContent = themeString('salePercent', '', { percent }) || `-${percent}%`;
  }

  /**
   * Append the total and the chosen option to whatever `product-form.js` last
   * wrote on the button.
   *
   * @private
   */
  #renderButton() {
    const button = this.root.querySelector('product-form [data-ref="submit"]');
    if (!(button instanceof HTMLButtonElement)) return;

    if (button.disabled) return;

    const bundleMode = this.closest('[data-bundle-mode]') !== null;

    const label = labelTarget(button);

    const base = bundleMode
      ? themeString('bundleAdd', this.dataset.addLabel || '')
      : label.textContent.split(SEPARATOR)[0].trim() || this.dataset.addLabel || '';

    const parts = [base];

    const unit = this.#unitPrice;
    if (Number.isFinite(unit)) parts.push(formatMoney(unit * this.#quantity));

    const variant = this.#variant;
    if (variant && this.#product?.has_only_default_variant === false && variant.title) {
      parts.push(variant.title);
    }

    label.textContent = parts.join(SEPARATOR);
  }
}

defineComponent('quick-add-summary', QuickAddSummary);

export default { QuickAddSummary };
