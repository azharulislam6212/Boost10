/**
 * `<highlight-points>`: a set of labelled points around a product, one of which
 * is lit, advancing as the customer scrolls the section past.
 *
 * @module @theme/highlight-points
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { subscribeToTicker } from '@theme/motion-engine';
import { clamp, isDesignMode } from '@theme/utilities';

/** How long the editor's own selection holds the run off. */
const SELECTION_HOLD = 2500;

/** The points around the product, and which one is lit. */
export class HighlightPoints extends BaseComponent {
  /** @type {HTMLElement[]} */
  #points = [];

  /** @type {(() => void)|null} */
  #unsubscribe = null;

  /** @type {number} */
  #index = -1;

  /** @type {number|null} */
  #holdUntil = null;

  /**
   * Where the points are, measured down from the stage's top: one centre each,
   * and how tall the whole run of them is from the first one's top edge to the
   * last one's bottom.
   *
   * @type {{ centres: number[], span: number }|null}
   */
  #geometry = null;

  /** @type {ResizeObserver|null} */
  #resizeObserver = null;

  setup() {
    this.#points = /** @type {HTMLElement[]} */ ([...this.querySelectorAll('[data-highlight-point]')]);

    if (this.#points.length === 0) return;

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
      this.#index = this.#markedIndex();
      return;
    }

    if (typeof ResizeObserver === 'function') {
      this.#resizeObserver = new ResizeObserver(() => {
        this.#geometry = null;
      });
      this.#resizeObserver.observe(this);
    }

    this.#unsubscribe = subscribeToTicker(() => this.#update());

    this.#update();
  }

  teardown() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#geometry = null;
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
   * @private
   */
  #update() {
    if (this.#holdUntil !== null) {
      if (Date.now() < this.#holdUntil) return;
      this.#holdUntil = null;
    }

    const rect = this.getBoundingClientRect();

    if (rect.height === 0) return;

    const viewport = window.innerHeight || document.documentElement.clientHeight;

    const { centres, span: reach } = this.#geometry ?? this.#measure();

    const travelled = (viewport - rect.top) / (viewport + rect.height);

    const span = this.#window;
    const lead = (1 - span) / 2;
    const progress = clamp((travelled - lead) / span, 0, 1);

    this.style.setProperty('--highlight-progress', progress.toFixed(4));

    const stacked = reach > viewport;

    let index;

    if (stacked) {
      const focus = viewport / 2;
      let best = 0;
      let nearest = Infinity;

      for (let i = 0; i < centres.length; i++) {
        const distance = Math.abs(rect.top + (centres[i] ?? 0) - focus);
        if (distance < nearest) {
          nearest = distance;
          best = i;
        }
      }

      index = best;
    } else {
      index = clamp(Math.floor(progress * this.#points.length), 0, this.#points.length - 1);
    }

    this.#apply(index);
  }

  /**
   * Each point's centre as a distance down from the stage's top, and how much
   * screen the whole run of them asks for.
   *
   * @returns {{ centres: number[], span: number }}
   * @private
   */
  #measure() {
    const points = this.#points;
    const origin = points[0]?.offsetParent === this ? 0 : this.offsetTop;

    const centres = [];
    let top = Infinity;
    let bottom = -Infinity;

    for (const point of points) {
      const start = point.offsetTop - origin;
      const end = start + point.offsetHeight;

      centres.push((start + end) / 2);
      top = Math.min(top, start);
      bottom = Math.max(bottom, end);
    }

    const geometry = { centres, span: bottom - top };
    this.#geometry = geometry;
    return geometry;
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
