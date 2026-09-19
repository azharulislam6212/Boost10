/**
 * highlight-points.js — Boost10
 *
 * `<highlight-points>`: a set of labelled points around a product, one of which
 * is lit, advancing as the customer scrolls the section past.
 *
 * @module @theme/highlight-points
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { subscribeToTicker } from '@theme/motion-engine';
import { clamp, isDesignMode } from '@theme/utilities';

/**
 * How long the editor's own selection holds the run off.
 *
 * Selecting a point in the sidebar lights it. Without a pause the very next
 * ticker frame would take the light straight back to whatever the scroll
 * position says, and the merchant would see their click undone — the editor
 * scrolls the selected block into view, so a frame always follows.
 */
const SELECTION_HOLD = 2500;

/**
 * The points around the product, and which one is lit.
 *
 * ## Nothing here owns a scroll listener
 *
 * `subscribeToTicker()` in `assets/motion-engine.js` is one rAF loop for the
 * whole page, reading `window.scrollY` once per frame and handing it to every
 * subscriber. The parallax backgrounds are on it already. A second listener
 * here would measure the same scroll on a different frame, which is the
 * difference between the points and the background moving together and moving
 * nearly together.
 *
 * It also means this follows Lenis — the theme's smooth scrolling — without
 * knowing Lenis exists, because Lenis scrolls the real document.
 *
 * ## The run is a fraction of the travel, not a pixel count
 *
 * A pixel offset is wrong on the next screen size up. What is measured instead
 * is how far the stage has travelled across the viewport: 0 when its top is at
 * the bottom edge, 1 when its bottom has left the top. **Scroll window** then
 * says how much of the middle of that travel the run uses, so the first point
 * holds while the section arrives and the last one holds while it leaves,
 * rather than the run being over before the customer has looked at it.
 *
 * ## Reduced motion keeps the points, and drops the fade
 *
 * A point lighting up is a change of state, not a movement — switching it off
 * for reduced motion would take away the content, not the animation. So the
 * index still follows the scroll and `assets/base.css` collapses the transition
 * instead.
 *
 * ## Without this module
 *
 * Every point renders, and the one the merchant marked is lit. The section is
 * complete and legible; only the advancing is missing. That is why the active
 * state is an attribute Liquid can write and this element rewrites, rather than
 * something built here from nothing.
 */
export class HighlightPoints extends BaseComponent {
  /** @type {HTMLElement[]} */
  #points = [];

  /** @type {(() => void)|null} */
  #unsubscribe = null;

  /** @type {number} */
  #index = -1;

  /** @type {number|null} */
  #holdUntil = null;

  setup() {
    this.#points = /** @type {HTMLElement[]} */ ([...this.querySelectorAll('[data-highlight-point]')]);

    if (this.#points.length === 0) return;

    // The editor selects blocks the customer cannot see the state of. Lighting
    // the selected point is the same courtesy `assets/tabs.js` pays when a tab
    // panel is selected in the sidebar.
    if (isDesignMode()) {
      this.on(document, 'shopify:block:select', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (!(target instanceof HTMLElement)) return;

        const index = this.#points.findIndex((point) => point === target || point.contains(target));
        if (index === -1) return;

        this.#holdUntil = Date.now() + SELECTION_HOLD;
        this.#apply(index);
      });
    }

    if (this.dataset.activate !== 'scroll') {
      // Liquid already lit one. Read it rather than overwrite it, so the
      // merchant's choice survives a module that had nothing else to do.
      this.#index = this.#markedIndex();
      return;
    }

    this.#unsubscribe = subscribeToTicker(() => this.#update());

    // The first frame, before a scroll has happened: a section already on
    // screen at load should be showing the point its position calls for, not
    // the one the markup shipped with.
    this.#update();
  }

  teardown() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#index = -1;
    this.#holdUntil = null;
  }

  /** @returns {number} The point Liquid marked, or the first. */
  #markedIndex() {
    const marked = this.#points.findIndex((point) => point.hasAttribute('data-highlight-active'));
    return marked === -1 ? 0 : marked;
  }

  /**
   * How much of the stage's travel across the viewport the run uses, as a
   * fraction. Clamped away from 0 so the arithmetic below can always divide.
   *
   * @returns {number}
   */
  get #window() {
    const percent = Number.parseFloat(this.dataset.window ?? '') || 60;
    return clamp(percent, 10, 100) / 100;
  }

  /**
   * Measure, map, and light one point.
   *
   * Runs inside the shared ticker, so it is one `getBoundingClientRect()` per
   * frame per section — a read, and then at most one attribute write. No layout
   * is invalidated in between, which is what keeps this off the main thread's
   * critical path.
   *
   * @private
   */
  #update() {
    if (this.#holdUntil !== null) {
      if (Date.now() < this.#holdUntil) return;
      this.#holdUntil = null;
    }

    const rect = this.getBoundingClientRect();

    // A zero box is a section inside something that has not been painted — a
    // closed panel, a tab that is not open. Every position would resolve to the
    // same one, so nothing is written until there is something to measure.
    if (rect.height === 0) return;

    const viewport = window.innerHeight || document.documentElement.clientHeight;

    // 0 when the top edge is at the bottom of the viewport; 1 when the bottom
    // edge has passed the top of it. The denominator is the whole distance the
    // stage travels, so it is right for a stage taller than the screen and for
    // one much shorter.
    const travelled = (viewport - rect.top) / (viewport + rect.height);

    // The middle slice. Half the slack sits before the run and half after, so
    // the first point holds while the section arrives and the last one holds
    // while it leaves.
    const span = this.#window;
    const lead = (1 - span) / 2;
    const progress = clamp((travelled - lead) / span, 0, 1);

    // Published for anything that wants to draw the run — a rail, a bar, a
    // fading connector. Nothing reads it yet; it costs one property and saves
    // the next feature from adding a second measurement of the same scroll.
    this.style.setProperty('--highlight-progress', progress.toFixed(4));

    // `floor` over an open-ended range, then clamped: at exactly 1 the floor is
    // the count itself, which is one past the last point.
    const index = clamp(Math.floor(progress * this.#points.length), 0, this.#points.length - 1);

    this.#apply(index);
  }

  /**
   * @param {number} index
   * @private
   */
  #apply(index) {
    if (index === this.#index) return;
    this.#index = index;

    this.#points.forEach((point, i) => {
      const active = i === index;
      point.toggleAttribute('data-highlight-active', active);

      // `aria-current` and not `aria-selected`: nothing here is a tab or an
      // option in a listbox, and the points are not a control the customer
      // operates. It is a list, and one item of it is the one being talked
      // about — which is exactly what `aria-current="true"` says.
      if (active) point.setAttribute('aria-current', 'true');
      else point.removeAttribute('aria-current');
    });
  }

  /** @returns {number} The lit point's index. */
  get activeIndex() {
    return this.#index;
  }
}

defineComponent('highlight-points', HighlightPoints);
