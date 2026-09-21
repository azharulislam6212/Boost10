/**
 * `<selling-plan-selector>` — the subscribe-and-save control on the product page.
 *
 * @module @theme/product-selling-plans
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS, sellingPlanChangeDetail } from '@theme/events';
import { parseJSONScript, themeString, announce, formatMoney } from '@theme/utilities';

export class SellingPlanSelector extends BaseComponent {
  /**
   * Variant id to available plans, rendered by Liquid.
   *
   * @type {Record<string, Array<Object>>}
   */
  #allocations = {};

  /** @type {string|null} */
  #variantId = null;

  setup() {
    this.#allocations = parseJSONScript(this.querySelector('[data-allocations]')) || {};

    this.on(this, 'change', this.#onChange);

    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => {
      this.applyVariant(event.detail?.variant);
    });

    this.on(this.root, EVENTS.VARIANT_UNAVAILABLE, () => this.applyVariant(null));

    this.on(this.root, EVENTS.VARIANT_READY, (event) => {
      this.applyVariant(event.detail?.variant ?? null, { silent: true });
    });

    const picker = this.root.querySelector?.('variant-picker');
    if (picker?.currentVariant) {
      this.applyVariant(picker.currentVariant, { silent: true });
    } else {
      this.#commit(this.value, { silent: true });
    }
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {HTMLElement|Document}
   */
  get root() {
    return this.closest('[data-product-root]') || document;
  }

  /**
   * @returns {string} The selected plan id, or '' for a one-time purchase.
   */
  get value() {
    const checked = this.querySelector('input[name="purchase-option"]:checked');

    if (checked instanceof HTMLInputElement) {
      if (checked.value === 'subscription') {
        return this.refs.interval instanceof HTMLSelectElement ? this.refs.interval.value : '';
      }
      return checked.value;
    }

    const select = this.querySelector('select[name="selling_plan"]');
    return select instanceof HTMLSelectElement ? select.value : '';
  }

  /**
   * @returns {boolean}
   */
  get isSubscription() {
    return this.value !== '';
  }

  /**
   * @returns {Object|null} The full allocation for the selected plan.
   */
  get currentPlan() {
    const id = this.value;
    if (!id) return null;

    return this.plansForVariant(this.#variantId).find((plan) => String(plan.id) === String(id)) || null;
  }

  /**
   * @param {string|number|null} variantId
   * @returns {Array<Object>} Plans available for a variant.
   */
  plansForVariant(variantId) {
    if (!variantId) return [];
    return this.#allocations[String(variantId)] || [];
  }

  /**
   * Choose a plan.
   *
   * @param {string|number|null} planId Empty or null for a one-time purchase.
   */
  select(planId) {
    const value = planId ? String(planId) : '';

    if (value === '') {
      if (this.refs.oneTime instanceof HTMLInputElement) this.refs.oneTime.checked = true;
    } else {
      if (this.refs.subscribe instanceof HTMLInputElement) this.refs.subscribe.checked = true;
      if (this.refs.interval instanceof HTMLSelectElement) this.refs.interval.value = value;
    }

    this.#commit(value);
  }

  /**
   * Rebuild the plan list for a variant.
   *
   * @param {Object|null} variant
   * @param {{ silent?: boolean }} [options]
   */
  applyVariant(variant, { silent = false } = {}) {
    this.#variantId = variant ? String(variant.id) : null;

    const plans = this.plansForVariant(this.#variantId);
    const previous = this.value;

    this.#renderIntervals(plans);

    if (plans.length === 0) {
      this.#setSubscriptionAvailable(false);
      this.select('');
      return;
    }

    this.#setSubscriptionAvailable(true);

    const stillValid = plans.some((plan) => String(plan.id) === previous);
    const next = stillValid ? previous : '';

    if (this.refs.interval instanceof HTMLSelectElement && plans.length > 0) {
      this.refs.interval.value = stillValid ? previous : String(plans[0].id);
    }

    this.#commit(next === '' && this.refs.subscribe?.checked ? String(plans[0].id) : next, { silent });
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /** @private */
  #onChange = () => {
    this.#commit(this.value);
  };

  /**
   * @param {string} value
   * @param {{ silent?: boolean }} [options]
   * @private
   */
  #commit(value, { silent = false } = {}) {
    const subscribing = value !== '';

    if (this.refs.interval instanceof HTMLSelectElement) {
      this.refs.interval.hidden = !subscribing;
      this.refs.interval.disabled = !subscribing;
    }

    this.toggleAttribute('data-subscription', subscribing);

    this.root.querySelector?.('product-form')?.setSellingPlan?.(value || null);

    this.#renderSummary(value);

    if (silent) return;

    this.dispatch(
      EVENTS.SELLING_PLAN_CHANGE,
      sellingPlanChangeDetail(value || null, {
        group: this.dataset.groupId || null,
        price: this.currentPlan?.price ?? null,
        variantId: this.#variantId
      })
    );
  }

  /**
   * Rebuild the interval options for the current variant.
   *
   * @param {Array<Object>} plans
   * @private
   */
  #renderIntervals(plans) {
    const select = this.refs.interval;
    if (!(select instanceof HTMLSelectElement)) return;

    select.replaceChildren(
      ...plans.map((plan) => {
        const option = document.createElement('option');
        option.value = String(plan.id);
        option.textContent = plan.name;
        option.dataset.price = String(plan.price ?? '');
        if (plan.compare_at_price) option.dataset.compareAtPrice = String(plan.compare_at_price);
        return option;
      })
    );
  }

  /**
   * @param {boolean} available
   * @private
   */
  #setSubscriptionAvailable(available) {
    if (this.refs.subscribe instanceof HTMLInputElement) {
      this.refs.subscribe.disabled = !available;
      this.refs.subscribe.closest('[data-purchase-option]')?.toggleAttribute('data-unavailable', !available);
    }

    if (this.refs.unavailable instanceof HTMLElement) {
      this.refs.unavailable.hidden = available;
      if (!available) this.refs.unavailable.textContent = themeString('subscriptionUnavailable', '');
    }

    this.toggleAttribute('data-no-plans', !available);
  }

  /**
   * @param {string} value
   * @private
   */
  #renderSummary(value) {
    const target = this.refs.summary;
    if (!(target instanceof HTMLElement)) return;

    if (value === '') {
      target.textContent = themeString('oneTimePurchase', '');
      return;
    }

    const plan = this.currentPlan;
    if (!plan) {
      target.textContent = '';
      return;
    }

    const parts = [plan.name];

    if (Number.isFinite(plan.price)) parts.push(formatMoney(plan.price));

    if (Number.isFinite(plan.compare_at_price) && plan.compare_at_price > plan.price) {
      const percent = Math.round(((plan.compare_at_price - plan.price) / plan.compare_at_price) * 100);
      parts.push(themeString('subscriptionSave', '', { percent }));
    }

    target.textContent = parts.filter(Boolean).join(' \u2014 ');
    announce(target.textContent);
  }
}

defineComponent('selling-plan-selector', SellingPlanSelector);

export default SellingPlanSelector;
