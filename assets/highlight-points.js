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
 * ## Two ways to read the scroll, and the layout picks
 *
 * That sweep is right when the points are around the product and all five are
 * on screen together: the customer is looking at the whole arrangement, so the
 * light moving through it is the section talking.
 *
 * It is wrong the moment they are not. Below 990px `assets/base.css` drops the
 * placement and the points become a column under the picture — taller than the
 * screen — and the sweep then lights the fourth point while the customer is
 * reading the first, because it is measuring the stage and they are reading a
 * point. What it should say there is "this one", about the one in front of
 * them.
 *
 * So there are two mappings and the geometry chooses, not a breakpoint. If the
 * points span more than a screen they cannot be taken in at once, and the lit
 * one is whichever sits nearest the middle of the viewport; if they fit, the
 * sweep runs as before. That is the same fact the media query is standing in
 * for, asked directly — so a narrow desktop window, a stage in a sidebar or a
 * merchant who stacked the points on purpose all get the right one without
 * this file knowing what 990px is.
 *
 * Where the points are is measured once and kept, because it only changes when
 * the layout does — a `ResizeObserver` on the stage is what says it has. So the
 * frame budget is still the one rect the sweep always read, and the stacked
 * mapping is arithmetic on top of it.
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

  /**
   * Where the points are, measured down from the stage's top: one centre each,
   * and how tall the whole run of them is from the first one's top edge to the
   * last one's bottom.
   *
   * Null until the first frame that needs it and after every resize, so the
   * measuring is one pass when the layout settles rather than five
   * `getBoundingClientRect()` calls a frame for the life of the page.
   *
   * @type {{ centres: number[], span: number }|null}
   */
  #geometry = null;

  /** @type {ResizeObserver|null} */
  #resizeObserver = null;

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

    // A resize is the only thing that moves a point relative to the stage, and
    // it moves every one of them: a breakpoint crossing, a font arriving, an
    // image finally laying out. Dropping the cache is the whole handler — the
    // next ticker frame re-measures, so nothing is measured on a frame that was
    // not going to run anyway.
    if (typeof ResizeObserver === 'function') {
      this.#resizeObserver = new ResizeObserver(() => {
        this.#geometry = null;
      });
      this.#resizeObserver.observe(this);
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

    const { centres, span: reach } = this.#geometry ?? this.#measure();

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
    // It is the sweep either way: it says where the *section* is, which is
    // still true when the points are stacked and something else is lighting
    // them.
    this.style.setProperty('--highlight-progress', progress.toFixed(4));

    // Top of the first point to the bottom of the last, against the screen. Not
    // the stage's own height — that includes the picture and whatever floor
    // **Stage height** puts under it, and a tall stage with the five points
    // around its middle is still five points a customer takes in at once.
    const stacked = reach > viewport;

    let index;

    if (stacked) {
      // Whichever point is nearest the middle of the screen. Pure arithmetic on
      // the cached centres and the one rect already read, so the stacked
      // mapping costs no more per frame than the sweep does.
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
      // `floor` over an open-ended range, then clamped: at exactly 1 the floor
      // is the count itself, which is one past the last point.
      index = clamp(Math.floor(progress * this.#points.length), 0, this.#points.length - 1);
    }

    this.#apply(index);
  }

  /**
   * Each point's centre as a distance down from the stage's top, and how much
   * screen the whole run of them asks for.
   *
   * ## Offsets, and not `getBoundingClientRect()`
   *
   * A rect includes the transform, and on the frame this runs the points may
   * still be carrying the entrance animation's — `<motion-effect>` moves them
   * on `transform`, staggered, so a rect taken then is each point's resting
   * place plus however much of its own slide is left. The result is cached
   * until a resize, and nothing about an animation finishing is a resize, so
   * one badly timed measurement would be wrong for the life of the page.
   *
   * An offset is layout, which the entrance never touches. The one thing it
   * leaves out is **Nudge up or down**, and that is by construction rather than
   * by luck: the nudge exists only above 990px, and above 990px the points fit
   * on a screen and the sweep is running, which does not read these centres at
   * all. What it can change is `span`, and only upward — an un-nudged run is
   * the taller one — so the question "do these fit on a screen" is asked of the
   * layout, which is the honest version of it.
   *
   * @returns {{ centres: number[], span: number }}
   * @private
   */
  #measure() {
    // `offsetTop` is measured against the nearest positioned ancestor. The stage
    // is a static grid, so that is normally some ancestor both it and the points
    // share and the subtraction is right — but a merchant's own CSS can position
    // the stage, and then the points are measured against the stage itself and
    // there is nothing to subtract.
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
