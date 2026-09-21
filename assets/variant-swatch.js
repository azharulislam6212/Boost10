/**
 * `<variant-swatch>` — swatches on a product card.
 *
 * @module @theme/variant-swatch
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS, variantChangeDetail } from '@theme/events';
import { formatMoney, themeString, announce, isTouchDevice } from '@theme/utilities';

export class VariantSwatch extends BaseComponent {
  /** @type {Object[]} */
  #variants = [];

  /** The variant the card is actually showing, as opposed to previewing. */
  #committed = null;

  /** Image URLs already requested, so intent never fetches the same one twice. */
  #preloaded = new Set();

  setup() {
    const script = this.querySelector('[data-variants]');

    try {
      this.#variants = script ? JSON.parse(script.textContent) : [];
    } catch {
      console.warn('[Boost10] Card swatch data could not be parsed.');
      this.#variants = [];
      return;
    }

    this.#committed = this.#variants.find((variant) => variant.available) || this.#variants[0] || null;

    this.on(this, 'click', this.#onClick);
    this.on(this, 'keydown', this.#onKeydown);

    if (!isTouchDevice()) {
      this.on(this, 'pointerover', this.#onIntent);
      this.on(this, 'pointerleave', () => this.#restore());
    }

    this.on(this, 'focusin', this.#onIntent);
    this.on(this, 'focusout', (event) => {
      if (this.contains(event.relatedTarget)) return;
      this.#restore();
    });

    this.#syncPressed();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {HTMLElement[]}
   */
  get options() {
    return Array.from(this.querySelectorAll('[data-swatch-option]'));
  }

  /**
   * @returns {HTMLElement|null} The card this belongs to.
   */
  get card() {
    return this.closest('[data-product-card]') || this.parentElement;
  }

  /**
   * @returns {Object|null}
   */
  get variant() {
    return this.#committed;
  }

  /**
   * Show a value without committing to it.
   *
   * @param {string} value
   */
  preview(value) {
    const variant = this.#find(value);
    if (!variant) return;

    this.#paint(variant, { committed: false });
  }

  /**
   * Make a value the card's variant.
   *
   * @param {string} value
   * @returns {boolean}
   */
  select(value) {
    const variant = this.#find(value);
    if (!variant) return false;

    this.#committed = variant;
    this.#paint(variant, { committed: true });
    this.#syncPressed();
    this.#syncLinks(variant);

    announce(themeString('swatchSelected', '', { value }));

    this.dispatch(EVENTS.VARIANT_CHANGE, variantChangeDetail(variant, { source: 'card' }));

    return true;
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * @param {string} value
   * @returns {Object|null}
   * @private
   */
  #find(value) {
    return this.#variants.find((variant) => variant.options.includes(value)) || null;
  }

  /**
   * @param {MouseEvent} event
   * @private
   */
  #onClick = (event) => {
    const option = event.target instanceof Element ? event.target.closest('[data-swatch-option]') : null;
    if (!(option instanceof HTMLElement)) return;

    event.preventDefault();
    this.select(option.dataset.value);
  };

  /**
   * Arrow keys move between swatches, because a row of buttons that only
   * responds to Tab makes a keyboard user press it once per colour.
   *
   * @param {KeyboardEvent} event
   * @private
   */
  #onKeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;

    const options = this.options;
    const current = options.indexOf(document.activeElement);
    if (current === -1) return;

    event.preventDefault();

    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % options.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else next = options.length - 1;

    options[next]?.focus();
  };

  /**
   * @param {Event} event
   * @private
   */
  #onIntent = (event) => {
    const option = event.target instanceof Element ? event.target.closest('[data-swatch-option]') : null;
    if (!(option instanceof HTMLElement)) return;

    const variant = this.#find(option.dataset.value);
    if (!variant) return;

    this.#preload(variant);
    this.preview(option.dataset.value);
  };

  /**
   * Fetch an image once, on first intent.
   *
   * @param {Object} variant
   * @private
   */
  #preload(variant) {
    const src = variant.featured_image?.src;
    if (!src || this.#preloaded.has(src)) return;

    this.#preloaded.add(src);

    const image = new Image();
    image.decoding = 'async';
    image.src = src;
  }

  /**
   * @param {Object} variant
   * @param {{ committed: boolean }} options
   * @private
   */
  #paint(variant, { committed }) {
    const card = this.card;
    if (!card) return;

    const image = card.querySelector('[data-card-image] img');
    const src = variant.featured_image?.src;

    if (image instanceof HTMLImageElement && src) {
      if (!image.dataset.originalSrc) image.dataset.originalSrc = image.currentSrc || image.src;

      image.src = src;
      image.removeAttribute('srcset');
    }

    const price = card.querySelector('[data-card-price]');
    if (price instanceof HTMLElement) {
      if (!price.dataset.originalPrice) price.dataset.originalPrice = price.textContent ?? '';
      price.textContent = formatMoney(variant.price);
    }

    card.toggleAttribute('data-variant-previewing', !committed);
  }

  /**
   * Put the card back to its committed variant.
   *
   * @private
   */
  #restore() {
    const card = this.card;
    if (!card) return;

    card.removeAttribute('data-variant-previewing');

    if (this.#committed) {
      this.#paint(this.#committed, { committed: true });
      return;
    }

    const image = card.querySelector('[data-card-image] img');
    if (image instanceof HTMLImageElement && image.dataset.originalSrc) {
      image.src = image.dataset.originalSrc;
    }

    const price = card.querySelector('[data-card-price]');
    if (price instanceof HTMLElement && price.dataset.originalPrice) {
      price.textContent = price.dataset.originalPrice;
    }
  }

  /** @private */
  #syncPressed() {
    for (const option of this.options) {
      const active = Boolean(this.#committed?.options.includes(option.dataset.value));
      option.setAttribute('aria-pressed', String(active));
      option.toggleAttribute('data-active', active);
    }
  }

  /**
   * Point the card's links at the chosen variant, so opening it lands on the
   * colour the customer was looking at rather than the default.
   *
   * @param {Object} variant
   * @private
   */
  #syncLinks(variant) {
    const card = this.card;
    const base = this.dataset.productUrl;
    if (!card || !base) return;

    for (const link of card.querySelectorAll('a[href]')) {
      if (!link.getAttribute('href').startsWith(base)) continue;
      link.setAttribute('href', `${base}?variant=${variant.id}`);
    }
  }
}

defineComponent('variant-swatch', VariantSwatch);

export default VariantSwatch;
