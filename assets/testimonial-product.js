/**
 * testimonial-product.js — Boost10
 *
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
 *
 * `max-width: 749px` **or** `(hover: none)`, not either alone. `(hover: none)`
 * is the honest test for a phone, but the theme editor's mobile preview is a
 * narrow viewport in a desktop browser with a mouse attached — it reports
 * `hover: hover`, and on that test alone a merchant laying out the mobile view
 * would get a panel that only opened on hover, which is not what the phone does.
 */
const TOUCH_QUERY = '(hover: none), (max-width: 749px)';

/**
 * The disc and its product panel.
 *
 * ## Why this exists at all
 *
 * On a pointer the panel is a hover state and needs no script: `base.css` shows
 * it on `:hover` and `:focus-within`. A touch screen has neither, and the panel
 * carries the product's title, rating and price — content, not decoration.
 *
 * It used to be permanently open on touch for exactly that reason. That works
 * until two cards sit side by side on a phone, where two permanently open
 * panels are most of the row. So on touch it opens on a tap instead, and
 * carries a close button that only exists at that breakpoint.
 *
 * ## The disc is a button, not a link
 *
 * A disc that navigates cannot also reveal, and the tap-to-reveal-then-tap-to-
 * follow pattern means the first tap on a product silently does nothing a
 * customer asked for. So the disc is a `<button>` that owns `aria-expanded`,
 * and the product's link is the panel's title — a picture that opens a preview,
 * a name that goes to the product.
 *
 * That holds at both breakpoints. A keyboard user on a desktop gets the same
 * explicit control the phone does rather than having to know that focus alone
 * reveals something.
 *
 * ## One open at a time
 *
 * Opening one panel closes the others. Two panels open in a row of cards is
 * two products claiming to be the one being looked at, and on a phone the
 * second one pushes the first off the screen.
 *
 * The close is dispatched as a plain event on `document` rather than through a
 * registry, so a card that arrives later — Swiper cloning slides for a loop,
 * the editor re-rendering a section — takes part without being told about.
 */
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

    // Escape closes whatever is open, which is the one shortcut a customer
    // tries without being told it exists.
    this.on(this, 'keydown', (event) => {
      if (event.key === 'Escape' && this.open) {
        this.close();
        this.refs.toggle.focus();
      }
    });

    // A tap outside closes it. `pointerdown` rather than `click` so the panel
    // is gone before the tapped thing reacts, and scoped to the document
    // because the thing tapped is by definition not inside this element.
    this.on(document, 'pointerdown', (event) => {
      if (!this.open) return;
      if (this.contains(/** @type {Node} */ (event.target))) return;
      this.close();
    });

    this.on(document, 'testimonial-product:open', (event) => {
      if (event.target !== this) this.close();
    });

    // Leaving the touch breakpoint hands the panel back to `:hover`, and an
    // element left in its open state would be stuck open on a resized desktop.
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

  /**
   * Mirrors the state onto the button.
   *
   * `aria-expanded` only, and no `hidden` on the panel: the panel is revealed by
   * `:hover` on a pointer without this element being involved at all, and an
   * attribute written here would fight the stylesheet at every width.
   */
  #sync() {
    this.refs.toggle.setAttribute('aria-expanded', this.open ? 'true' : 'false');
  }
}

defineComponent('testimonial-product', TestimonialProduct);
