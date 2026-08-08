/**
 * promo-code.js — Boost10
 *
 * `<promo-code>` — the discount code field in the cart and cart drawer.
 *
 * An honest note about what this can and cannot do, because getting it wrong is
 * one of the most common sources of support tickets on Shopify themes:
 *
 * There is no storefront API that validates a discount code against a cart.
 * `/discount/CODE` is a redirect that sets a cookie; fetching it from JavaScript
 * neither validates the code nor reliably attaches it, and it returns a 200 for
 * codes that will be rejected at checkout. Any theme that shows "Discount
 * applied — you saved £10" before checkout is guessing.
 *
 * So this component stores the code as a cart attribute, appends it to the
 * checkout URL, and tells the customer it will be applied at checkout. It shows
 * the code as *entered*, never as *validated*, and never renders a saving.
 * Automatic discounts and script discounts that Shopify has already applied to
 * the cart are shown separately, from `cart.discount_applications`, because
 * those are real.
 *
 * @module @theme/promo-code
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { cart } from '@theme/cart-drawer';
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
      await cart.applyDiscount(trimmed);

      this.refs.input.value = '';
      this.#message(themeString('discountCheckoutNotice', ''));
      announce(themeString('discountApplied', ''));
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

    const entered = cart.state?.attributes?.discount_code || '';
    const applied = cart.state?.discount_applications || [];

    list.replaceChildren();

    for (const discount of applied) {
      list.appendChild(this.#row(discount.title, discount.total_allocated_amount, false));
    }

    if (entered && !applied.some((d) => d.title?.toUpperCase() === entered.toUpperCase())) {
      list.appendChild(this.#row(entered, null, true));
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
