/**
 * `<sticky-add-to-cart>` — the buy bar that appears once the real one has
 * scrolled away.
 *
 * @module @theme/sticky-add-to-cart
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { themeString, formatMoney } from '@theme/utilities';

/* ==========================================================================
   <sticky-add-to-cart>
   ========================================================================== */

/** The bar that appears once the real buy button has scrolled away. */
export class StickyAddToCart extends BaseComponent {
  static requiredRefs = ['submit'];

  /** @type {IntersectionObserver|null} */
  #observer = null;

  setup() {
    this.hidden = true;

    this.on(this.refs.submit, 'click', (event) => {
      event.preventDefault();
      this.form?.submit();
    });

    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => this.render(event.detail?.variant));
    this.on(this.root, EVENTS.VARIANT_UNAVAILABLE, () => this.render(null));

    this.on(this.root, EVENTS.VARIANT_READY, (event) => this.render(event.detail?.variant ?? null));

    if (this.refs.variantSelect) {
      this.on(this.refs.variantSelect, 'change', (event) => {
        this.root.querySelector('variant-picker')?.selectVariant?.(event.target.value);
        this.form?.setVariant?.(this.#variantById(event.target.value));
      });
    }

    if (this.refs.quantityInput) {
      this.on(this.refs.quantityInput, 'change', (event) => {
        const value = Math.max(1, Number(event.target.value) || 1);
        event.target.value = String(value);
        this.form?.setQuantity(value);
      });
    }

    this.#observeTrigger();

    const picker = this.root.querySelector?.('variant-picker');
    if (picker && picker.currentVariant !== undefined) this.render(picker.currentVariant);
  }

  teardown() {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {HTMLElement|Document}
   */
  get root() {
    return document.querySelector('[data-product-root]') || document;
  }

  /**
   * @returns {ProductForm|null}
   */
  get form() {
    const id = this.dataset.form;
    const byId = id ? document.getElementById(id) : null;
    return byId?.closest('product-form') || document.querySelector('product-form');
  }

  /**
   * @param {number|string} id
   * @returns {Object|null}
   * @private
   */
  #variantById(id) {
    const picker = this.root.querySelector('variant-picker');
    return picker?.variants?.find((item) => String(item.id) === String(id)) || null;
  }

  /**
   * @param {Object|null} variant
   */
  render(variant) {
    const button = this.refs.submit;

    if (this.refs.variantSelect instanceof HTMLSelectElement && variant) {
      this.refs.variantSelect.value = String(variant.id);
    }

    if (this.refs.price instanceof HTMLElement) {
      this.refs.price.textContent = variant ? formatMoney(variant.price) : '';
    }

    if (!(button instanceof HTMLButtonElement)) return;

    if (!variant) {
      button.disabled = true;
      button.textContent = themeString('unavailable', '');
      return;
    }

    button.disabled = !variant.available;
    button.textContent = variant.available ? themeString('addToCart', '') : themeString('soldOut', '');
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /** @private */
  #observeTrigger() {
    const id = this.dataset.watch;
    const trigger = id ? document.getElementById(id) : this.form?.refs?.submit;

    if (!(trigger instanceof HTMLElement) || !('IntersectionObserver' in window)) {
      this.hidden = false;
      return;
    }

    this.#observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const shouldShow = !entry.isIntersecting && entry.boundingClientRect.top < 0;
          this.hidden = !shouldShow;
          this.toggleAttribute('data-visible', shouldShow);
        }
      },
      { threshold: 0 }
    );

    this.#observer.observe(trigger);
  }
}

defineComponent('sticky-add-to-cart', StickyAddToCart);

export default StickyAddToCart;
