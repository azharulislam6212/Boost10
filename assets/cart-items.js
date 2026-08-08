/**
 * cart-items.js — Boost10
 *
 * The editable cart line list, plus the two things that sit alongside it:
 *
 *   <cart-items>       Quantity changes, removal, per-line loading and errors
 *   <cart-note>        The order note
 *   <gift-wrap-toggle> Adds or removes a gift wrap product
 *
 * Used by both the cart page and the cart drawer, from the same snippet, so the
 * two can never drift apart.
 *
 * Nothing here builds markup. A quantity change asks Shopify to re-render the
 * cart sections and `morph()` applies the result, which is why line prices,
 * discounts and totals are always internally consistent — they were all
 * computed by Liquid in the same request.
 *
 * @module @theme/cart-items
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { cart } from '@theme/cart-drawer';
import { debounce, themeString, announce, announceUrgent } from '@theme/utilities';

/* ==========================================================================
   <cart-items>
   ========================================================================== */

/**
 * Markup contract:
 *
 *   <cart-items data-section-id="cart-drawer">
 *     <div data-line-item data-key="{{ item.key }}" data-line="{{ forloop.index }}">
 *       <quantity-selector data-key="{{ item.key }}" data-line="{{ forloop.index }}">…</quantity-selector>
 *       <button data-remove-item>…</button>
 *       <p data-line-error role="alert"></p>
 *     </div>
 *   </cart-items>
 */
export class CartItems extends BaseComponent {
  setup() {
    if (this.dataset.sectionId) cart.registerSection(this.dataset.sectionId);

    // <quantity-selector> owns its own validation and debouncing, and reports
    // the settled value. This element only decides what a settled value means.
    this.on(this, EVENTS.QUANTITY_CHANGE, this.#onQuantityChange);
    this.on(this, 'click', this.#onClick);
  }

  teardown() {
    if (this.dataset.sectionId) cart.unregisterSection(this.dataset.sectionId);
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * Change a line's quantity.
   *
   * @param {string} key Line item key.
   * @param {number} quantity
   * @returns {Promise<void>}
   */
  async updateQuantity(key, quantity) {
    const line = this.#lineFor(key);
    this.#setLineBusy(line, true);
    this.#setLineError(line, '');

    try {
      await cart.changeItem({ key, quantity });
    } catch (error) {
      // Shopify reports the quantity it could actually honour, so the message
      // says "only 3 available" rather than a generic failure.
      const available = error?.body?.quantity;
      const message = Number.isFinite(available)
        ? themeString('cartQuantityError', '', { quantity: available })
        : error?.message || themeString('cartError', '');

      this.#setLineError(line, message);
      announceUrgent(message);
    } finally {
      this.#setLineBusy(line, false);
    }
  }

  /**
   * Remove a line.
   *
   * @param {string} key
   * @returns {Promise<void>}
   */
  async removeItem(key) {
    const line = this.#lineFor(key);
    const title = line?.dataset.title || '';

    this.#setLineBusy(line, true);

    try {
      await cart.removeItem({ key });
      announce(themeString('itemRemoved', '') || title);
    } catch (error) {
      this.#setLineError(line, error?.message || themeString('cartError', ''));
      this.#setLineBusy(line, false);
    }
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @param {CustomEvent} event
   * @private
   */
  #onQuantityChange = (event) => {
    const key = event.detail?.key;
    if (!key) return;

    event.stopPropagation();
    this.updateQuantity(key, event.detail.quantity);
  };

  /**
   * @param {MouseEvent} event
   * @private
   */
  #onClick = (event) => {
    const trigger = event.target instanceof Element ? event.target.closest('[data-remove-item]') : null;
    if (!trigger) return;

    event.preventDefault();

    const key = trigger.closest('[data-line-item]')?.dataset.key;
    if (key) this.removeItem(key);
  };

  /**
   * @param {string} key
   * @returns {HTMLElement|null}
   * @private
   */
  #lineFor(key) {
    return this.querySelector(`[data-line-item][data-key="${CSS.escape(key)}"]`);
  }

  /**
   * @param {HTMLElement|null} line
   * @param {boolean} busy
   * @private
   */
  #setLineBusy(line, busy) {
    if (!line) return;
    line.toggleAttribute('data-busy', busy);
    line.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  /**
   * @param {HTMLElement|null} line
   * @param {string} message
   * @private
   */
  #setLineError(line, message) {
    const target = line?.querySelector('[data-line-error]');
    if (!(target instanceof HTMLElement)) return;

    target.textContent = message;
    target.toggleAttribute('hidden', !message);
  }
}

defineComponent('cart-items', CartItems);

/* ==========================================================================
   <cart-note>
   ========================================================================== */

/**
 * The order note.
 *
 * Saved on a debounce as the customer types, and again on blur, because a note
 * typed and then abandoned by closing the drawer should still be there when the
 * drawer reopens. The save is silent — a toast for every pause in typing would
 * be noise — but the saved state is announced once, politely.
 *
 * Markup:
 *
 *   <cart-note>
 *     <textarea data-ref="input" name="note"></textarea>
 *     <p data-ref="status" role="status"></p>
 *   </cart-note>
 */
export class CartNote extends BaseComponent {
  static requiredRefs = ['input'];

  setup() {
    const save = debounce(() => this.save(), 700);

    this.on(this.refs.input, 'input', save);
    this.on(this.refs.input, 'blur', () => this.save());
  }

  /**
   * Persist the note.
   *
   * @returns {Promise<void>}
   */
  async save() {
    const value = this.refs.input.value;
    if (value === this.#lastSaved) return;

    try {
      await cart.updateNote(value);
      this.#lastSaved = value;
      this.#status(themeString('noteSaved', ''));
    } catch {
      this.#status(themeString('cartError', ''));
    }
  }

  /** @type {string|null} */
  #lastSaved = null;

  /**
   * @param {string} message
   * @private
   */
  #status(message) {
    const target = this.refs.status;
    if (target instanceof HTMLElement) target.textContent = message;
    if (message) announce(message);
  }
}

defineComponent('cart-note', CartNote);

/* ==========================================================================
   <gift-wrap-toggle>
   ========================================================================== */

/**
 * Adds or removes a gift wrap product.
 *
 * The merchant creates a real product for the wrapping fee and selects it in
 * theme settings, so the charge flows through Shopify's own pricing, tax and
 * reporting rather than being faked with a cart attribute.
 *
 * The checkbox is a real checkbox and reflects the cart, not the click: if the
 * add fails, it goes back to where it was rather than showing a state the cart
 * does not have.
 *
 * Markup:
 *
 *   <gift-wrap-toggle data-variant-id="123" data-key="{{ wrap_line.key }}">
 *     <input type="checkbox" data-ref="checkbox">
 *   </gift-wrap-toggle>
 */
export class GiftWrapToggle extends BaseComponent {
  static requiredRefs = ['checkbox'];

  setup() {
    this.on(this.refs.checkbox, 'change', this.#onChange);
  }

  /**
   * @param {Event} event
   * @private
   */
  #onChange = async (event) => {
    const checkbox = /** @type {HTMLInputElement} */ (event.target);
    const wanted = checkbox.checked;

    checkbox.disabled = true;
    this.setAttribute('aria-busy', 'true');

    try {
      if (wanted) {
        await cart.addItem(
          {
            id: Number(this.dataset.variantId),
            quantity: 1,
            properties: { _gift_wrap: 'true' }
          },
          { open: false }
        );
        announce(themeString('giftWrapAdded', ''));
      } else if (this.dataset.key) {
        await cart.removeItem({ key: this.dataset.key });
        announce(themeString('giftWrapRemoved', ''));
      }
    } catch (error) {
      checkbox.checked = !wanted;
      announceUrgent(error?.message || themeString('cartError', ''));
    } finally {
      checkbox.disabled = false;
      this.removeAttribute('aria-busy');
    }
  };
}

defineComponent('gift-wrap-toggle', GiftWrapToggle);

export default { CartItems, CartNote, GiftWrapToggle };
