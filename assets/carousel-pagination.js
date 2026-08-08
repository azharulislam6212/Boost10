/**
 * carousel-pagination.js — Boost10
 *
 * The slide counter and the progress bar for `<swiper-carousel>`.
 *
 * ## Why this is not part of the carousel
 *
 * Pagination defaults to None, and most carousels in a theme never turn it on.
 * Folding this into `SwiperCarousel` would make every carousel on the store pay
 * for a feature almost none of them use, and would grow the one component that
 * the product gallery, the announcement bar and every content section all
 * depend on.
 *
 * As a sibling it loads only where the markup exists.
 *
 * ## How it reads the carousel
 *
 * `SwiperCarousel` publishes its position by writing `data-index` on itself
 * (see `#sync`). This component watches that attribute rather than listening
 * for an event, because an attribute is also the state the carousel restores
 * after a Section Rendering API morph — an event fires once and is gone, while
 * the attribute is still correct on the new node.
 *
 * The page count comes from the track's scroll width against its client width,
 * not from counting slides. Three slides at four-per-view is one page, not
 * three, and a counter reading "1 / 3" that can never reach 3 is worse than no
 * counter.
 *
 * @element carousel-pagination
 * @attr {'numbers'|'progress'} data-style
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { rafThrottle, clamp } from '@theme/utilities';

export class CarouselPagination extends BaseComponent {
  /** @type {MutationObserver|null} */
  #observer = null;

  /** @type {ResizeObserver|null} */
  #resize = null;

  setup() {
    const carousel = this.#carousel;
    if (!carousel) return;

    this.#observer = new MutationObserver(() => this.#render());
    this.#observer.observe(carousel, {
      attributes: true,
      attributeFilter: ['data-index']
    });

    // The page count changes with the viewport, so the total has to be
    // recomputed on resize even when the index has not moved.
    this.#resize = new ResizeObserver(rafThrottle(() => this.#render()));
    if (this.#track) this.#resize.observe(this.#track);

    this.on(this.#track, 'scroll', rafThrottle(() => this.#render()), { passive: true });

    this.#render();
  }

  teardown() {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#resize?.disconnect();
    this.#resize = null;
  }

  /* ---------------------------------------------------------- internals -- */

  /** @returns {HTMLElement|null} @private */
  get #carousel() {
    return this.closest('swiper-carousel');
  }

  /** @returns {HTMLElement|null} @private */
  get #track() {
    return this.#carousel?.querySelector('[data-ref="track"]') ?? null;
  }

  /**
   * Pages, not slides. A track showing four of six products scrolls through
   * two pages; the counter should say so.
   * @private
   */
  get #pages() {
    const track = this.#track;
    if (!track || track.clientWidth === 0) return 1;

    // Rounding rather than ceiling: sub-pixel layout routinely leaves a track
    // 1px wider than its content, and ceiling turns that into a phantom page
    // the customer can never scroll to.
    return Math.max(1, Math.round(track.scrollWidth / track.clientWidth));
  }

  /** @private */
  get #page() {
    const track = this.#track;
    if (!track || track.clientWidth === 0) return 0;

    const position = Math.abs(track.scrollLeft);
    return clamp(Math.round(position / track.clientWidth), 0, this.#pages - 1);
  }

  /** @private */
  #render() {
    const pages = this.#pages;
    const page = this.#page;

    // A single page means there is nothing to paginate. Hiding rather than
    // showing "1 / 1" keeps the section from claiming a carousel that isn't.
    this.toggleAttribute('hidden', pages <= 1);
    if (pages <= 1) return;

    if (this.dataset.style === 'numbers') {
      if (this.refs.current) this.refs.current.textContent = String(page + 1);
      if (this.refs.total) this.refs.total.textContent = String(pages);
      return;
    }

    if (this.dataset.style === 'progress' && this.refs.bar instanceof HTMLElement) {
      const fraction = (page + 1) / pages;
      // scaleX on a full-width bar, so the animation runs on the compositor
      // instead of relayouting the section on every scroll frame.
      this.refs.bar.style.setProperty('--progress', String(fraction));
    }
  }
}

defineComponent('carousel-pagination', CarouselPagination);

export default { CarouselPagination };
