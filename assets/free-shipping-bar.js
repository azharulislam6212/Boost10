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

  /** @returns {number} Threshold in cents. */
  get threshold() {
    const explicit = Number(this.dataset.threshold);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;

    return Number(window.Theme?.settings?.freeShippingThreshold) || 0;
  }

  /** @returns {number} Qualifying subtotal in cents. */
  get subtotal() {
    return cart.state?.items_subtotal_price ?? cart.state?.total_price ?? 0;
  }

  /** @returns {number} 0 to 1. */
  get progress() {
    if (this.threshold <= 0) return 0;
    return clamp(this.subtotal / this.threshold, 0, 1);
  }

  /** Redraw from the current cart. */
  render() {
    const { threshold } = this;
    this.hidden = threshold <= 0;
    if (this.hidden) return;

    const { message, fill, track } = this.refs;
    const remaining = Math.max(0, threshold - this.subtotal);
    const reached = remaining === 0;
    const { progress } = this;
    const percent = Math.round(progress * 100);

    message.innerHTML = reached
      ? themeString('freeShippingUnlocked', '')
      : themeString('freeShippingRemaining', '', { amount: formatMoney(remaining) });

    this.toggleAttribute('data-unlocked', reached);
    this.style.setProperty('--progress', String(progress));

    if (fill instanceof HTMLElement) fill.style.inlineSize = `${percent}%`;

    if (track instanceof HTMLElement) {
      track.setAttribute('aria-valuenow', String(percent));
      track.setAttribute('aria-valuetext', message.textContent || '');
    }

    if (reached && !this.#unlocked) announce(themeString('freeShippingUnlocked', ''));
    this.#unlocked = reached;
  }
}

defineComponent('free-shipping-bar', FreeShippingBar);

export default FreeShippingBar;
