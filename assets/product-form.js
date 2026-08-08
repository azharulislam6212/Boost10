/**
 * product-form.js — Boost10
 *
 * `<product-form>` — the buy form.
 *
 * `<sticky-add-to-cart>` moved to its own module: it is optional, and a product
 * page is the most performance-sensitive template in the theme, so a merchant
 * who turns the bar off should not pay for the code.
 *
 * `<bundle-builder>` used to live here too. It moved to its own module once it
 * outgrew sharing a file with the buy button, and because it is only ever on one
 * template, so it can be loaded there rather than on every product page.
 *
 * The form is a real `<form action="/cart/add" method="post">`. Submission is
 * intercepted so the drawer can open instead of the page reloading, but if this
 * module never loads the form still works. That is not a nicety: it is the
 * difference between a bad deploy costing conversion and costing every sale.
 *
 * @module @theme/product-form
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { toast } from '@theme/toast';
import { cart } from '@theme/cart-drawer';
import { themeString, announceUrgent, getRoute } from '@theme/utilities';

/* ==========================================================================
   <product-form>
   ========================================================================== */

/**
 * Markup:
 *
 *   <product-form data-product-id="123">
 *     <form action="{{ routes.cart_add_url }}" method="post" data-ref="form">
 *       <input type="hidden" name="id" value="…" data-ref="idInput">
 *       <quantity-selector>…</quantity-selector>
 *       <button type="submit" data-ref="submit">…</button>
 *       <p data-ref="error" role="alert" hidden></p>
 *     </form>
 *   </product-form>
 */
export class ProductForm extends BaseComponent {
  static requiredRefs = ['form', 'submit'];

  setup() {
    this.on(this.refs.form, 'submit', this.#onSubmit);

    // The picker owns the variant; this form reflects it.
    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => this.setVariant(event.detail?.variant));
    this.on(this.root, EVENTS.VARIANT_UNAVAILABLE, () => this.setVariant(null));

    const picker = this.root.querySelector?.('variant-picker');
    if (picker) this.setVariant(picker.currentVariant);
  }

  /* --------------------------------------------------------- public API -- */

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

    if (!variant) {
      button.disabled = true;
      button.textContent = themeString('unavailable', '');
      return;
    }

    button.disabled = !variant.available;
    button.textContent = variant.available
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
    const id = this.variantId;
    if (!id) {
      this.#error(themeString('unavailable', ''));
      return null;
    }

    // A gift card with an incomplete recipient is bought and never delivered,
    // and Shopify accepts it silently. The form asks the field owner rather than
    // reaching into it.
    const giftCard = this.querySelector('gift-card-recipient-form');
    if (giftCard?.validate && giftCard.validate() === false) return null;

    this.setLoading(true);
    this.#error('');

    try {
      const data = new FormData(this.refs.form);
      const properties = {};

      // Line item properties are any `properties[…]` field the section rendered:
      // engraving text, a gift message, a recipient email. Collected generically
      // so a new one never needs a change here.
      for (const [key, value] of data.entries()) {
        const match = key.match(/^properties\[(.+)\]$/);
        if (match && String(value).trim() !== '') properties[match[1]] = value;
      }

      const line = { id: Number(id), quantity: this.quantity };
      if (Object.keys(properties).length > 0) line.properties = properties;

      const sellingPlan = data.get('selling_plan');
      if (sellingPlan) line.selling_plan = Number(sellingPlan);

      const result = await cart.addItem(line);

      // Clear the recipient so the next gift card does not inherit it.
      giftCard?.reset?.();

      // A toast as well as the live-region announcement `cart` already makes.
      // A sighted customer who added from a card halfway down a grid otherwise
      // gets no visible feedback at all. The cart link is a shortcut, never the
      // only route — the header icon is always there.
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

  /* ---------------------------------------------------------- internals -- */

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
