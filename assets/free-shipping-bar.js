/**
 * `<free-shipping-bar>` — progress toward the free shipping threshold, and the
 * free gift reward that shares the same mechanic.
 *
 * @module @theme/free-shipping-bar
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { cart } from '@theme/cart-drawer';
import { clamp, formatMoney, themeString, announce } from '@theme/utilities';

export class FreeShippingBar extends BaseComponent {
  static requiredRefs = ['message'];

  /** Whether the threshold had already been met at the last render. */
  #unlocked = false;

  setup() {
    this.#unlocked = false;

    this.on(document, EVENTS.CART_UPDATED, () => this.render());
    this.on(document, EVENTS.CART_ITEM_ADDED, () => this.render());

    this.render();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {number} Threshold in cents.
   */
  get threshold() {
    const explicit = Number(this.dataset.threshold);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;

    return Number(window.Theme?.settings?.freeShippingThreshold) || 0;
  }

  /**
   * @returns {number} Qualifying subtotal in cents.
   */
  get subtotal() {
    return cart.state?.items_subtotal_price ?? cart.state?.total_price ?? 0;
  }

  /**
   * @returns {number} 0 to 1.
   */
  get progress() {
    if (this.threshold <= 0) return 0;
    return clamp(this.subtotal / this.threshold, 0, 1);
  }

  /** Redraw from the current cart. */
  render() {
    const threshold = this.threshold;

    if (threshold <= 0) {
      this.hidden = true;
      return;
    }

    this.hidden = false;

    const remaining = Math.max(0, threshold - this.subtotal);
    const reached = remaining === 0;
    const percent = Math.round(this.progress * 100);

    this.refs.message.innerHTML = reached
      ? themeString('freeShippingUnlocked', '')
      : themeString('freeShippingRemaining', '', { amount: formatMoney(remaining) });

    this.toggleAttribute('data-unlocked', reached);
    this.style.setProperty('--progress', String(this.progress));

    if (this.refs.fill instanceof HTMLElement) {
      this.refs.fill.style.inlineSize = `${percent}%`;
    }

    if (this.refs.track instanceof HTMLElement) {
      this.refs.track.setAttribute('aria-valuenow', String(percent));
      this.refs.track.setAttribute('aria-valuetext', this.refs.message.textContent || '');
    }

    if (reached && !this.#unlocked) announce(themeString('freeShippingUnlocked', ''));

    this.#unlocked = reached;
  }
}

defineComponent('free-shipping-bar', FreeShippingBar);

export default FreeShippingBar;
