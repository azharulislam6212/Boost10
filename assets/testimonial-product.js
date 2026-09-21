/**
 * `<testimonial-product>`: the product disc on a review card, and the panel it
 * shows.
 *
 * @module @theme/testimonial-product
 */

import { BaseComponent, defineComponent } from '@theme/component';

/**
 * The breakpoint the card's own stylesheet uses to decide that hover is not
 * available. Kept identical to the media query in `base.css` — the panel is
 * revealed by CSS on a pointer and by this element on a touch screen, and if
 * the two disagree there is a width where both fire or neither does.
 */
const TOUCH_QUERY = '(hover: none), (max-width: 749px)';

/** The disc and its product panel. */
export class TestimonialProduct extends BaseComponent {
  static requiredRefs = ['toggle', 'panel'];

  /** @type {MediaQueryList|null} */
  #touch = null;

  setup() {
    this.#touch = window.matchMedia(TOUCH_QUERY);

    this.on(this.refs.toggle, 'click', () => this.toggle());

    if (this.refs.close) {
      this.on(this.refs.close, 'click', () => this.close());
    }

    this.on(this, 'keydown', (event) => {
      if (event.key === 'Escape' && this.open) {
        this.close();
        this.refs.toggle.focus();
      }
    });

    this.on(document, 'pointerdown', (event) => {
      if (!this.open) return;

      const target = /** @type {Node} */ (event.target);
      if (this.refs.panel.contains(target)) return;
      if (this.refs.toggle.contains(target)) return;

      this.close();
    });

    this.on(document, 'testimonial-product:open', (event) => {
      if (event.target !== this) this.close();
    });

    this.on(this.#touch, 'change', (event) => {
      if (!event.matches) this.close();
    });

    this.#sync();
  }

  /** @returns {boolean} */
  get open() {
    return this.hasAttribute('data-open');
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    if (this.open) return;
    this.setAttribute('data-open', '');
    this.#sync();
    this.dispatch('testimonial-product:open', { bubbles: true });
  }

  close() {
    if (!this.open) return;
    this.removeAttribute('data-open');
    this.#sync();
  }

  /** Mirrors the state onto the button. */
  #sync() {
    this.refs.toggle.setAttribute('aria-expanded', this.open ? 'true' : 'false');
  }
}

defineComponent('testimonial-product', TestimonialProduct);
