/**
 * `<product-form>` — the buy form.
 *
 * @module @theme/product-form
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { toast } from '@theme/toast';
import { cart } from '@theme/cart-drawer';
import { themeString, announceUrgent, getRoute, labelTarget } from '@theme/utilities';

/* ==========================================================================
   <product-form>
   ========================================================================== */

export class ProductForm extends BaseComponent {
  static requiredRefs = ['form', 'submit'];

  setup() {
    this.on(this.refs.form, 'submit', this.#onSubmit);

    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => this.setVariant(event.detail?.variant));
    this.on(this.root, EVENTS.VARIANT_UNAVAILABLE, () => this.setVariant(null));

    this.on(this.root, EVENTS.VARIANT_READY, (event) => this.setVariant(event.detail?.variant ?? null));

    const picker = this.root.querySelector?.('variant-picker');
    if (!picker) return;

    if (picker.currentVariant !== undefined) this.setVariant(picker.currentVariant);
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {HTMLElement|Document}
   */
  get root() {
    return this.closest('[data-product-root]') || document;
  }

  /**
   * @returns {number}
   */
  get quantity() {
    const selector = this.querySelector('quantity-selector');
    if (selector?.value) return selector.value;

    const input = this.refs.form.querySelector('[name="quantity"]');
    return Number(input?.value) || 1;
  }

  /**
   * @returns {number|null}
   */
  get variantId() {
    const value = Number(this.refs.form.querySelector('[name="id"]')?.value);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * Reflect a variant in the form.
   *
   * @param {Object|null} variant
   */
  setVariant(variant) {
    const input = this.refs.form.querySelector('[name="id"]');
    if (input instanceof HTMLInputElement) input.value = variant ? String(variant.id) : '';

    const button = this.refs.submit;
    if (!(button instanceof HTMLButtonElement)) return;

    const label = labelTarget(button);

    if (!variant) {
      button.disabled = true;
      label.textContent = themeString('unavailable', '');
      return;
    }

    button.disabled = !variant.available;
    label.textContent = variant.available
      ? themeString(this.#isPreorder(variant) ? 'preorder' : 'addToCart', '')
      : themeString('soldOut', '');

    this.#error('');
  }

  /**
   * @param {number} quantity
   */
  setQuantity(quantity) {
    const selector = this.querySelector('quantity-selector');
    if (selector?.setValue) {
      selector.setValue(quantity);
      return;
    }

    const input = this.refs.form.querySelector('[name="quantity"]');
    if (input instanceof HTMLInputElement) input.value = String(quantity);
  }

  /**
   * @param {number|null} sellingPlanId
   */
  setSellingPlan(sellingPlanId) {
    let input = this.refs.form.querySelector('[name="selling_plan"]');

    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'selling_plan';
      this.refs.form.appendChild(input);
    }

    input.value = sellingPlanId ? String(sellingPlanId) : '';
  }

  /**
   * Add the current selection to the cart.
   *
   * @returns {Promise<Object|null>}
   */
  async submit() {
    if (this.hasAttribute('data-loading')) return null;

    const id = this.variantId;
    if (!id) {
      this.#error(themeString('unavailable', ''));
      return null;
    }

    const giftCard = this.querySelector('gift-card-recipient-form');
    if (giftCard?.validate && giftCard.validate() === false) return null;

    this.setLoading(true);
    this.#error('');

    try {
      const data = new FormData(this.refs.form);
      const properties = {};

      for (const [key, value] of data.entries()) {
        const match = key.match(/^properties\[(.+)\]$/);
        if (match && String(value).trim() !== '') properties[match[1]] = value;
      }

      const line = { id: Number(id), quantity: this.quantity };
      if (Object.keys(properties).length > 0) line.properties = properties;

      const sellingPlan = data.get('selling_plan');
      if (sellingPlan) line.selling_plan = Number(sellingPlan);

      const result = await cart.addItem(line);

      giftCard?.reset?.();

      if (!this.hasAttribute('data-silent')) {
        toast(themeString('addedToCart', ''), {
          type: 'success',
          action: { label: themeString('viewCart', ''), href: getRoute('cartUrl') }
        });
      }

      this.dispatch(EVENTS.PRODUCT_FORM_SUBMIT, { variantId: id, quantity: line.quantity });
      return result;
    } catch (error) {
      const message = error?.message || themeString('cartError', '');
      this.#error(message);
      this.dispatch(EVENTS.PRODUCT_FORM_ERROR, { message });
      return null;
    } finally {
      this.setLoading(false);
    }
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * @param {SubmitEvent} event
   * @private
   */
  #onSubmit = (event) => {
    event.preventDefault();
    this.submit();
  };

  /**
   * @param {Object} variant
   * @returns {boolean}
   * @private
   */
  #isPreorder(variant) {
    if (window.Theme?.settings?.preorderEnabled !== true) return false;
    return variant.inventory_policy === 'continue' && Number(variant.inventory_quantity) <= 0;
  }

  /**
   * @param {string} message
   * @private
   */
  #error(message) {
    const target = this.refs.error;
    if (target instanceof HTMLElement) {
      target.textContent = message;
      target.toggleAttribute('hidden', !message);
    }

    if (message) announceUrgent(message);
  }
}

defineComponent('product-form', ProductForm);

export default { ProductForm };
