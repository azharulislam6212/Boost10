/**
 * free-shipping-bar.js — Boost10
 *
 * `<free-shipping-bar>` — progress toward the free shipping threshold, and the
 * free gift reward that shares the same mechanic.
 *
 * The number it counts is the cart's item subtotal after discounts, not the
 * total. Shipping and tax are not known until checkout, and counting them would
 * tell a customer they had qualified when they had not.
 *
 * The threshold is a *display* setting. The theme cannot create a shipping rate;
 * the merchant sets the real one in Settings › Shipping, and this bar reflects
 * it. That is why the schema copy says so explicitly — a bar that promises free
 * shipping the store does not offer is a chargeback waiting to happen.
 *
 * Markup:
 *
 *   <free-shipping-bar data-threshold="10000">
 *     <p data-ref="message"></p>
 *     <div data-ref="track" role="progressbar"
 *          aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
 *       <span data-ref="fill"></span>
 *     </div>
 *   </free-shipping-bar>
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

  /* --------------------------------------------------------- public API -- */

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
    // `items_subtotal_price` is after line discounts and excludes shipping and
    // tax, which is exactly what a threshold should be measured against.
    return cart.state?.items_subtotal_price ?? cart.state?.total_price ?? 0;
  }

  /**
   * @returns {number} 0 to 1.
   */
  get progress() {
    if (this.threshold <= 0) return 0;
    return clamp(this.subtotal / this.threshold, 0, 1);
  }

  /**
   * Redraw from the current cart.
   */
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

    // Announce the moment it is earned, once. Announcing every progress change
    // would talk over the customer as they shop.
    if (reached && !this.#unlocked) announce(themeString('freeShippingUnlocked', ''));

    this.#unlocked = reached;
  }
}

defineComponent('free-shipping-bar', FreeShippingBar);

export default FreeShippingBar;
