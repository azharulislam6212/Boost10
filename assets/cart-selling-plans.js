/**
 * `<cart-selling-plan-selector>` and `<cart-variant-selector>` — change a subscription's delivery frequency,
 * or switch a line between one-time and subscription, from inside the cart.
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

  /* --------------------------------------------------------- public API -- ---- */

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

  /* ---------------------------------------------------------- internals -- ---- */

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

/** Change a line's variant without leaving the cart. */
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
      this.refs.select.value = this.#previous;
      announceUrgent(error?.message || themeString('cartError', ''));
    } finally {
      this.setLoading(false);
      this.refs.select.disabled = false;
    }
  };
}

defineComponent('cart-variant-selector', CartVariantSelector);
