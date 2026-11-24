/**
 * `<testimonial-product>`: the product disc on a review card, and the panel it
 * shows.
 *
 * @module @theme/testimonial-product
 */

import { BaseComponent, defineComponent } from '@theme/component';

/**
 * Must match the media query in `base.css`: CSS reveals the panel on hover,
 * this element reveals it on touch.
 */
const TOUCH_QUERY = '(hover: none), (max-width: 749px)';

/** The disc and its product panel. */
export class TestimonialProduct extends BaseComponent {
  static requiredRefs = ['toggle', 'panel'];

  setup() {
    this.on(this.refs.toggle, 'click', () => this.toggle());
    if (this.refs.close) this.on(this.refs.close, 'click', () => this.close());

    this.on(this, 'keydown', (event) => {
      if (event.key !== 'Escape' || !this.open) return;
      this.close();
      this.refs.toggle.focus();
    });

    this.on(document, 'pointerdown', (event) => {
      const { panel, toggle } = this.refs;
      const target = /** @type {Node} */ (event.target);
      if (this.open && !panel.contains(target) && !toggle.contains(target)) this.close();
    });

    this.on(document, 'testimonial-product:open', (event) => {
      if (event.target !== this) this.close();
    });

    this.on(window.matchMedia(TOUCH_QUERY), 'change', (event) => {
      if (!event.matches) this.close();
    });

    this.#sync();
  }

  /** @returns {boolean} */
  get open() {
    return this.hasAttribute('data-open');
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    if (this.open) return;
    this.toggleAttribute('data-open', true);
    this.#sync();
    this.dispatch('testimonial-product:open', { bubbles: true });
  }

  close() {
    if (!this.open) return;
    this.toggleAttribute('data-open', false);
    this.#sync();
  }

  /** Mirrors the state onto the button. */
  #sync() {
    this.refs.toggle.setAttribute('aria-expanded', String(this.open));
  }
}

defineComponent('testimonial-product', TestimonialProduct);
