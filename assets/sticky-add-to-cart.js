/**
 * sticky-add-to-cart.js — Boost10
 *
 * `<sticky-add-to-cart>` — the buy bar that appears once the real one has
 * scrolled away.
 *
 * Its own module because it is optional: a merchant who turns the bar off should
 * not pay for the code, and a product page is the most performance-sensitive
 * template in the theme.
 *
 * The whole design is one idea. This is a **view** of `<product-form>`, not a
 * second form. Its variant select and quantity field write into the real one and
 * its button calls that form's `submit()`, so there is a single code path to the
 * cart. A second source of truth for the selected variant is precisely the bug
 * that makes sticky bars on other themes add a different variant than the one
 * displayed above them.
 *
 * It appears only once the real button leaves the viewport and hides again when
 * it returns — a sticky bar sitting over the button it duplicates is a bar
 * covering content.
 *
 * @module @theme/sticky-add-to-cart
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { themeString, formatMoney } from '@theme/utilities';

/* ==========================================================================
   <sticky-add-to-cart>
   ========================================================================== */

/**
 * The bar that appears once the real buy button has scrolled away.
 *
 * It is a view of the product form, not a second form. Pressing it calls
 * `submit()` on the real one, so there is a single code path to the cart and the
 * two can never disagree about quantity, variant or selling plan.
 *
 * It only appears once the real button is out of view, and hides again when it
 * returns — a sticky bar sitting over the button it duplicates is just a bar
 * covering content.
 *
 * Markup:
 *
 *   <sticky-add-to-cart data-form="ProductForm" data-watch="AddToCartButton">
 *     <span data-ref="title">…</span>
 *     <span data-ref="price"></span>
 *     <button data-ref="submit">…</button>
 *   </sticky-add-to-cart>
 */
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

    // The inline controls write into the real form rather than holding state.
    // A second source of truth for the selected variant is the bug that makes
    // sticky bars add the wrong one.
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
    if (picker) this.render(picker.currentVariant);
  }

  teardown() {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /* --------------------------------------------------------- public API -- */

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

    // Keep the inline select in step when the choice was made in the real
    // picker, which is the direction this bar usually follows.
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

  /* ---------------------------------------------------------- internals -- */

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
