/**
 * cart-selling-plans.js — Boost10
 *
 * `<cart-selling-plan-selector>` and `<cart-variant-selector>` — change a subscription's delivery frequency,
 * or switch a line between one-time and subscription, from inside the cart.
 *
 * Selling plans come from a subscription app; the theme only presents them. The
 * available plans for a line are rendered by Liquid from
 * `item.variant.selling_plan_allocations`, so this module never has to know
 * which app is installed or how it prices its plans.
 *
 * Changing a plan means removing the line and adding it back with a different
 * `selling_plan`, because Shopify has no endpoint to change one in place. That
 * is a real mutation with a real failure mode, so the select reverts to the
 * cart's actual value when it fails rather than showing a frequency the customer
 * is not subscribed to.
 *
 * Markup:
 *
 *   <cart-selling-plan-selector
 *     data-key="{{ item.key }}"
 *     data-variant-id="{{ item.variant.id }}"
 *     data-quantity="{{ item.quantity }}">
 *     <select data-ref="select">
 *       <option value="">One-time purchase</option>
 *       <option value="12345" selected>Every 30 days</option>
 *     </select>
 *   </cart-selling-plan-selector>
 *
 * @module @theme/cart-selling-plans
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { cart } from '@theme/cart-drawer';
import { announce, announceUrgent, themeString } from '@theme/utilities';

export class CartSellingPlanSelector extends BaseComponent {
  static requiredRefs = ['select'];

  /** The value the cart actually holds, used to revert a failed change. */
  #committed = '';

  setup() {
    this.#committed = this.refs.select.value;
    this.on(this.refs.select, 'change', this.#onChange);
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {string} The selling plan id currently in the cart, or '' for one-time.
   */
  get sellingPlanId() {
    return this.#committed;
  }

  /**
   * Switch this line to a different plan.
   *
   * @param {string|number|null} planId Empty or null for a one-time purchase.
   * @returns {Promise<void>}
   */
  async change(planId) {
    const key = this.dataset.key;
    const variantId = Number(this.dataset.variantId);
    const quantity = Number(this.dataset.quantity) || 1;

    if (!key || !Number.isFinite(variantId)) return;

    this.#busy(true);

    try {
      await cart.changeVariant({
        key,
        id: variantId,
        quantity,
        selling_plan: planId ? Number(planId) : null
      });

      this.#committed = planId ? String(planId) : '';

      this.dispatch(EVENTS.SELLING_PLAN_CHANGE, {
        sellingPlanId: this.#committed || null,
        key,
        variantId
      });

      announce(themeString('planUpdated', ''));
    } catch (error) {
      this.refs.select.value = this.#committed;
      announceUrgent(error?.message || themeString('cartError', ''));
    } finally {
      this.#busy(false);
    }
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @param {Event} event
   * @private
   */
  #onChange = (event) => {
    const value = /** @type {HTMLSelectElement} */ (event.target).value;
    if (value === this.#committed) return;
    this.change(value);
  };

  /**
   * @param {boolean} busy
   * @private
   */
  #busy(busy) {
    this.setAttribute('aria-busy', busy ? 'true' : 'false');
    this.refs.select.disabled = busy;
  }
}

defineComponent('cart-selling-plan-selector', CartSellingPlanSelector);

export default { CartSellingPlanSelector, CartVariantSelector };

/* ==========================================================================
   <cart-variant-selector>
   ========================================================================== */

/**
 * Change a line's variant without leaving the cart.
 *
 * Shopify's change endpoint cannot move a line to a different variant, so this
 * is a remove followed by an add. `cart.changeVariant` performs both in order
 * and reverts on failure, which is the part that matters: a half-completed swap
 * would leave the customer with a cart that lost a line and gained nothing.
 *
 * The select reverts to its previous value if either half fails, so the control
 * never shows a variant the cart does not contain.
 *
 * Markup:
 *
 *   <cart-variant-selector data-key="…" data-quantity="2">
 *     <select data-ref="select">…</select>
 *   </cart-variant-selector>
 */
export class CartVariantSelector extends BaseComponent {
  static requiredRefs = ['select'];

  /** The value to fall back to when a swap fails. */
  #previous = '';

  setup() {
    this.#previous = this.refs.select.value;
    this.on(this.refs.select, 'change', this.#onChange);
  }

  /**
   * @returns {string}
   */
  get key() {
    return this.dataset.key || '';
  }

  /**
   * @returns {number}
   */
  get quantity() {
    return Number(this.dataset.quantity) || 1;
  }

  /**
   * @param {Event} event
   * @private
   */
  #onChange = async (event) => {
    const id = event.target.value;
    if (!id || !this.key) return;

    this.setLoading(true);
    this.refs.select.disabled = true;

    try {
      await cart.changeVariant(this.key, Number(id), this.quantity);
      this.#previous = id;
    } catch (error) {
      // Put the control back to what the cart actually holds. A select showing a
      // variant the cart does not contain is worse than no swap at all.
      this.refs.select.value = this.#previous;
      announceUrgent(error?.message || themeString('cartError', ''));
    } finally {
      this.setLoading(false);
      this.refs.select.disabled = false;
    }
  };
}

defineComponent('cart-variant-selector', CartVariantSelector);
