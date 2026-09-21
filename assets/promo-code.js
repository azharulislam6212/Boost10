/**
 * `<promo-code>` — the discount code field in the cart and cart drawer.
 *
 * @module @theme/promo-code
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { cart, cartHasDiscount } from '@theme/cart-drawer';
import { themeString, announce, announceUrgent } from '@theme/utilities';

export class PromoCode extends BaseComponent {
  static requiredRefs = ['form', 'input'];

  setup() {
    this.on(this.refs.form, 'submit', this.#onSubmit);
    this.on(this, 'click', this.#onClick);

    this.on(document, EVENTS.CART_UPDATED, () => this.render());

    this.render();
  }

  /* --------------------------------------------------------- public API -- ---- */

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

  /** Reflect the cart's current discount state. */
  render() {
    const list = this.refs.list;
    if (!(list instanceof HTMLElement)) return;

    const entered = (cart.state?.attributes?.discount_code || '')
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean);

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

  /* ---------------------------------------------------------- internals -- ---- */

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
  return window.Theme?.shop?.moneyFormat
    ? new Intl.NumberFormat(window.Theme.shop.locale || 'en', {
        style: 'currency',
        currency: window.Theme.shop.currency || 'USD'
      }).format(cents / 100)
    : String(cents / 100);
}

defineComponent('promo-code', PromoCode);

export default PromoCode;
