/**
 * product-selling-plans.js — Boost10
 *
 * `<selling-plan-selector>` — the subscribe-and-save control on the product page.
 *
 * Selling plans come from a subscription app; the theme only presents them. The
 * groups, intervals and prices are rendered by Liquid from
 * `product.selling_plan_groups`, so this module never needs to know which app is
 * installed or how it prices a plan.
 *
 * The detail that is easy to miss: **selling plan allocations are per variant.**
 * A 1kg tub and a 500g pouch can have different subscription prices, and a plan
 * that exists on one variant may not exist on another at all. A selector that
 * reads its prices once on page load shows the wrong price the moment the
 * customer switches flavour, and can leave a plan selected that the chosen
 * variant does not offer — which fails at add-to-cart with an unhelpful error.
 *
 * So this element listens for `variant:change` and re-reads the allocation map
 * that Liquid rendered, per variant, into `data-allocations`.
 *
 * It reports the chosen plan to `<product-form>` by direct method call. The form
 * owns what gets submitted; this owns which plan is chosen.
 *
 * The one-time option is a real radio, not the absence of a selection. A
 * customer switching from subscription back to one-time is making a choice, and
 * it has to be expressible.
 *
 * Markup:
 *
 *   <selling-plan-selector data-layout="radio">
 *     <script type="application/json" data-allocations>
 *       { "41234": [ { "id": 998, "name": "Every 30 days", "price": 2250,
 *                      "compare_at_price": 2500, "per_delivery_price": 2250 } ] }
 *     </script>
 *
 *     <input type="radio" name="purchase-option" value="" checked data-ref="oneTime">
 *     <input type="radio" name="purchase-option" value="subscription" data-ref="subscribe">
 *
 *     <select data-ref="interval" name="selling_plan">
 *       <option value="998" data-price="2250">Every 30 days</option>
 *     </select>
 *
 *     <p data-ref="summary" role="status"></p>
 *     <p data-ref="unavailable" hidden></p>
 *   </selling-plan-selector>
 *
 * @module @theme/product-selling-plans
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS, sellingPlanChangeDetail } from '@theme/events';
import { parseJSONScript, themeString, announce, formatMoney } from '@theme/utilities';

export class SellingPlanSelector extends BaseComponent {
  /**
   * Variant id to available plans, rendered by Liquid.
   * @type {Record<string, Array<Object>>}
   */
  #allocations = {};

  /** @type {string|null} */
  #variantId = null;

  setup() {
    this.#allocations = parseJSONScript(this.querySelector('[data-allocations]')) || {};

    this.on(this, 'change', this.#onChange);

    // Broadcast path: the customer switches variant after load.
    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => {
      this.applyVariant(event.detail?.variant);
    });

    this.on(this.root, EVENTS.VARIANT_UNAVAILABLE, () => this.applyVariant(null));

    // Direct path: the variant that was already selected when this connected,
    // including a page loaded on a `?variant=` URL.
    const picker = this.root.querySelector?.('variant-picker');
    if (picker?.currentVariant) {
      this.applyVariant(picker.currentVariant, { silent: true });
    } else {
      this.#commit(this.value, { silent: true });
    }
  }

  /* --------------------------------------------------------- public API -- */

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
      // With an interval dropdown, the radio picks one-time versus subscription
      // and the select picks the plan within it.
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

    // Nothing to subscribe to for this variant: fall back to one-time rather
    // than leaving a plan selected that add-to-cart would reject.
    if (plans.length === 0) {
      this.#setSubscriptionAvailable(false);
      this.select('');
      return;
    }

    this.#setSubscriptionAvailable(true);

    // Keep the customer's choice when the same plan exists on the new variant.
    // Switching from 1kg to 500g should not silently reset "every 30 days".
    const stillValid = plans.some((plan) => String(plan.id) === previous);
    const next = stillValid ? previous : '';

    if (this.refs.interval instanceof HTMLSelectElement && plans.length > 0) {
      this.refs.interval.value = stillValid ? previous : String(plans[0].id);
    }

    this.#commit(next === '' && this.refs.subscribe?.checked ? String(plans[0].id) : next, { silent });
  }

  /* ---------------------------------------------------------- internals -- */

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

    // The interval dropdown is meaningless for a one-time purchase, and leaving
    // it focusable invites a customer to set a frequency that will be ignored.
    if (this.refs.interval instanceof HTMLSelectElement) {
      this.refs.interval.hidden = !subscribing;
      this.refs.interval.disabled = !subscribing;
    }

    this.toggleAttribute('data-subscription', subscribing);

    // Direct call: the form owns what is submitted, this owns what is chosen.
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
   * Options are replaced rather than hidden, because a hidden `<option>` is
   * still selectable with a keyboard in several browsers.
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
