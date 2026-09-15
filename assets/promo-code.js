/**
 * promo-code.js — Boost10
 *
 * `<promo-code>` — the discount code field in the cart and cart drawer.
 *
 * An honest note about what this can and cannot do, because getting it wrong is
 * one of the most common sources of support tickets on Shopify themes:
 *
 * There is still no storefront API that *validates* a code. What there is, and
 * what `cart.applyDiscount()` now uses, is `/discount/CODE` — a redirect that
 * puts the code on the session — followed by a re-read of the cart. Shopify
 * prices the cart; this component reads the result. So a code that Shopify is
 * actually applying arrives here as a real entry in `discount_applications`,
 * with a real amount, and is rendered as applied.
 *
 * A code that produces nothing is not called a failure, because "nothing on the
 * cart" and "will be honoured at checkout" look identical from the storefront —
 * a minimum spend not yet met is the common case. Those stay in the pending
 * list, shown as *entered*, with no saving attached and no claim made. The
 * distinction the two lists draw is unchanged; what changed is that the first
 * list now has things in it.
 *
 * @module @theme/promo-code
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { cart, cartHasDiscount } from '@theme/cart-drawer';
import { themeString, announce, announceUrgent } from '@theme/utilities';

/**
 * Markup:
 *
 *   <promo-code>
 *     <form data-ref="form">
 *       <input data-ref="input" name="discount" autocomplete="off">
 *       <button type="submit" data-ref="submit">Apply</button>
 *     </form>
 *     <ul data-ref="list">
 *       <li data-code="SAVE10">
 *         SAVE10 <button data-remove-discount>Remove</button>
 *       </li>
 *     </ul>
 *     <p data-ref="message" role="status"></p>
 *   </promo-code>
 */
export class PromoCode extends BaseComponent {
  static requiredRefs = ['form', 'input'];

  setup() {
    this.on(this.refs.form, 'submit', this.#onSubmit);
    this.on(this, 'click', this.#onClick);

    // The field belongs to the cart, so it follows the cart rather than keeping
    // its own copy of the truth.
    this.on(document, EVENTS.CART_UPDATED, () => this.render());

    this.render();
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * Store a code for checkout.
   *
   * @param {string} code
   * @returns {Promise<void>}
   */
  async apply(code) {
    const trimmed = String(code || '').trim();

    if (!trimmed) {
      this.#message(themeString('discountInvalid', ''), true);
      return;
    }

    this.#busy(true);

    try {
      const state = await cart.applyDiscount(trimmed);

      this.refs.input.value = '';

      // Two different things to say, and now they can be told apart. A code the
      // cart is visibly being discounted by is applied; one that changed nothing
      // is pending, because a minimum not yet met and a code that will never
      // work are indistinguishable from here.
      const applied = cartHasDiscount(state, trimmed);
      const message = themeString(applied ? 'discountApplied' : 'discountCheckoutNotice', '');

      this.#message(message);
      announce(message);
      this.render();
    } catch (error) {
      const message = error?.message || themeString('cartError', '');
      this.#message(message, true);
      announceUrgent(message);
    } finally {
      this.#busy(false);
    }
  }

  /**
   * Clear the stored code.
   *
   * @returns {Promise<void>}
   */
  async remove() {
    this.#busy(true);

    try {
      await cart.removeDiscount();
      this.#message('');
      this.render();
    } catch (error) {
      this.#message(error?.message || themeString('cartError', ''), true);
    } finally {
      this.#busy(false);
    }
  }

  /**
   * Reflect the cart's current discount state.
   *
   * Two distinct things are rendered, and they are labelled differently on
   * purpose: codes the customer typed, which are pending, and discounts Shopify
   * has already applied, which are real and carry an amount.
   */
  render() {
    const list = this.refs.list;
    if (!(list instanceof HTMLElement)) return;

    const entered = (cart.state?.attributes?.discount_code || '')
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean);

    // Both shapes, because which one Shopify uses depends on the kind of
    // discount: an order-level one is a `cart_level_discount_application`, and
    // reading only `discount_applications` is how a working order discount comes
    // to be listed as still pending. Keyed by title so the same discount
    // appearing in both is rendered once.
    const applied = new Map();

    for (const discount of [
      ...(cart.state?.cart_level_discount_applications || []),
      ...(cart.state?.discount_applications || [])
    ]) {
      const title = discount?.title;
      if (title && !applied.has(title)) applied.set(title, discount);
    }

    list.replaceChildren();

    for (const discount of applied.values()) {
      list.appendChild(this.#row(discount.title, discount.total_allocated_amount, false));
    }

    for (const code of entered) {
      if (cartHasDiscount(cart.state, code)) continue;
      list.appendChild(this.#row(code, null, true));
    }

    list.toggleAttribute('hidden', list.children.length === 0);
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @param {string} code
   * @param {number|null} amount
   * @param {boolean} pending
   * @returns {HTMLElement}
   * @private
   */
  #row(code, amount, pending) {
    const item = document.createElement('li');
    item.className = pending ? 'promo-code__item promo-code__item--pending' : 'promo-code__item';
    item.dataset.code = code;

    const label = document.createElement('span');
    label.className = 'promo-code__code';
    label.textContent = code;
    item.appendChild(label);

    if (pending) {
      const note = document.createElement('span');
      note.className = 'promo-code__pending';
      note.textContent = themeString('discountCheckoutNotice', '');
      item.appendChild(note);
    } else if (Number.isFinite(amount)) {
      const saving = document.createElement('span');
      saving.className = 'promo-code__saving';
      saving.textContent = themeString('discountSavingHtml', '', { amount: formatAmount(amount) });
      item.appendChild(saving);
    }

    // Only a code the customer entered can be removed. An automatic discount is
    // the merchant's rule, and offering a remove button that cannot work is
    // worse than offering none.
    if (pending) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'promo-code__remove';
      button.setAttribute('data-remove-discount', '');
      button.setAttribute('aria-label', themeString('discountRemove', '', { code }));
      button.textContent = '\u00d7';
      item.appendChild(button);
    }

    return item;
  }

  /**
   * @param {SubmitEvent} event
   * @private
   */
  #onSubmit = (event) => {
    event.preventDefault();
    this.apply(this.refs.input.value);
  };

  /**
   * @param {MouseEvent} event
   * @private
   */
  #onClick = (event) => {
    const trigger = event.target instanceof Element ? event.target.closest('[data-remove-discount]') : null;
    if (!trigger) return;

    event.preventDefault();
    this.remove();
  };

  /**
   * @param {boolean} busy
   * @private
   */
  #busy(busy) {
    this.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (this.refs.submit instanceof HTMLButtonElement) this.refs.submit.disabled = busy;
    this.refs.input.disabled = busy;
  }

  /**
   * @param {string} text
   * @param {boolean} [isError=false]
   * @private
   */
  #message(text, isError = false) {
    const target = this.refs.message;
    if (!(target instanceof HTMLElement)) return;

    target.textContent = text;
    target.toggleAttribute('hidden', !text);
    target.toggleAttribute('data-error', isError);
  }
}

/**
 * @param {number} cents
 * @returns {string}
 * @private
 */
function formatAmount(cents) {
  // Imported lazily to keep this module's static graph to the cart owner only.
  return window.Theme?.shop?.moneyFormat
    ? new Intl.NumberFormat(window.Theme.shop.locale || 'en', {
        style: 'currency',
        currency: window.Theme.shop.currency || 'USD'
      }).format(cents / 100)
    : String(cents / 100);
}

defineComponent('promo-code', PromoCode);

export default PromoCode;
