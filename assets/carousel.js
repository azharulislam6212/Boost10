/**
 * carousel.js — Boost10
 *
 * `<swiper-carousel>` — a horizontal carousel built on CSS scroll snapping.
 *
 * The tag name is a holdover from the original brief, which specified a Swiper
 * wrapper. Swiper was dropped: the theme's first rule is zero framework
 * dependencies, and everything needed here — snap points, momentum, drag,
 * indicators — is native. This implementation is around three kilobytes against
 * Swiper's hundred and forty, and the tag name is kept so section schemas and
 * saved settings do not have to change.
 *
 * The track is a real scrolling element with `scroll-snap-type`. That means the
 * carousel works before this script runs, works if it fails, scrolls with a
 * trackpad, a touch swipe and the keyboard, and respects the customer's own
 * scrolling preferences. The script adds arrows, indicators, autoplay and the
 * announcements.
 *
 * Accessibility decisions worth keeping:
 *   - Arrows are real buttons with translated labels, disabled at the ends.
 *   - The track is focusable and labelled, so a keyboard user can scroll it.
 *   - Autoplay pauses on hover, on focus, when the tab is hidden, and stops for
 *     good the first time the customer interacts. It never runs under reduced
 *     motion, and there is always a pause control.
 *   - Slides outside the viewport are not hidden from assistive technology: the
 *     track is a scroll region, not a set of tabs, so everything in it should be
 *     reachable in reading order.
 *
 * Markup:
 *
 *   <swiper-carousel data-autoplay="false" data-loop="false">
 *     <div data-ref="track" tabindex="0" role="group" aria-label="…">
 *       <div data-slide>…</div>
 *     </div>
 *     <button data-ref="previous" aria-label="…">…</button>
 *     <button data-ref="next" aria-label="…">…</button>
 *     <div data-ref="indicators">
 *       <button data-indicator aria-label="…"></button>
 *     </div>
 *     <button data-ref="pause" hidden>…</button>
 *     <p data-ref="status" class="visually-hidden" role="status"></p>
 *   </swiper-carousel>
 *
 * @module @theme/carousel
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { clamp, rafThrottle, debounce, themeString, isRTL, prefersReducedMotion } from '@theme/utilities';

export class SwiperCarousel extends BaseComponent {
  static requiredRefs = ['track'];

  /** @type {number} */
  #index = 0;

  /** @type {number|null} */
  #timer = null;

  /** Set once the customer scrolls, drags or presses an arrow. */
  #interacted = false;

  /** @type {ResizeObserver|null} */
  #observer = null;

  setup() {
    this.#index = 0;
    this.#interacted = false;

    const onScroll = rafThrottle(() => this.#syncFromScroll());
    this.on(this.refs.track, 'scroll', onScroll, { passive: true });

    if (this.refs.previous) this.on(this.refs.previous, 'click', () => this.previous());
    if (this.refs.next) this.on(this.refs.next, 'click', () => this.next());
    if (this.refs.pause) this.on(this.refs.pause, 'click', () => this.toggleAutoplay());

    this.on(this, 'click', (event) => {
      const indicator = event.target instanceof Element ? event.target.closest('[data-indicator]') : null;
      if (!indicator) return;
      this.goTo(Array.from(this.indicators).indexOf(indicator));
    });

    this.on(this.refs.track, 'keydown', this.#onKeydown);

    // Any deliberate interaction ends autoplay permanently. A carousel that
    // starts moving again after the customer took control is hostile.
    this.on(this.refs.track, 'pointerdown', () => this.#stopForGood(), { passive: true });
    this.on(this.refs.track, 'wheel', () => this.#stopForGood(), { passive: true });

    this.on(this, 'pointerenter', () => this.#pause());
    this.on(this, 'pointerleave', () => this.#resume());
    this.on(this, 'focusin', () => this.#pause());
    this.on(this, 'focusout', (event) => {
      if (this.contains(event.relatedTarget)) return;
      this.#resume();
    });

    // A carousel advancing in a background tab wastes battery and is never seen.
    this.on(document, 'visibilitychange', () => {
      if (document.hidden) {
        this.#pause();
      } else {
        this.#resume();
      }
    });

    this.#observer = new ResizeObserver(debounce(() => this.#update(), 150));
    this.#observer.observe(this.refs.track);

    this.#update();
    this.#startAutoplay();
  }

  teardown() {
    this.#pause();
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {HTMLElement[]}
   */
  get slides() {
    return Array.from(this.refs.track.querySelectorAll('[data-slide]'));
  }

  /**
   * @returns {HTMLElement[]}
   */
  get indicators() {
    return Array.from(this.querySelectorAll('[data-indicator]'));
  }

  /**
   * @returns {number}
   */
  get index() {
    return this.#index;
  }

  /**
   * @returns {number}
   */
  get count() {
    return this.slides.length;
  }

  /**
   * @returns {boolean} True when more than one screenful of slides exists.
   */
  get scrollable() {
    return this.refs.track.scrollWidth - this.refs.track.clientWidth > 2;
  }

  /**
   * Scroll to a slide.
   *
   * @param {number} index
   * @param {{ animate?: boolean }} [options]
   */
  goTo(index, { animate = true } = {}) {
    const slides = this.slides;
    const target = slides[clamp(index, 0, slides.length - 1)];
    if (!target) return;

    this.#interacted = true;

    this.refs.track.scrollTo({
      left: target.offsetLeft - this.refs.track.offsetLeft,
      behavior: animate && !prefersReducedMotion() ? 'smooth' : 'auto'
    });
  }

  /**
   * Advance one slide, wrapping when `data-loop` is set.
   */
  next() {
    this.#stopForGood();

    const last = this.count - 1;
    const target = this.#index >= last ? (this.loop ? 0 : last) : this.#index + 1;
    this.goTo(target);
  }

  /**
   * Go back one slide, wrapping when `data-loop` is set.
   */
  previous() {
    this.#stopForGood();

    const target = this.#index <= 0 ? (this.loop ? this.count - 1 : 0) : this.#index - 1;
    this.goTo(target);
  }

  /**
   * @returns {boolean}
   */
  get loop() {
    return this.dataset.loop === 'true';
  }

  /**
   * @returns {number} Autoplay interval in milliseconds, or 0 when disabled.
   */
  get autoplayInterval() {
    if (this.dataset.autoplay !== 'true') return 0;
    if (prefersReducedMotion()) return 0;
    return Number(this.dataset.autoplaySpeed) || 5000;
  }

  /**
   * Start or stop autoplay from a control.
   */
  toggleAutoplay() {
    if (this.#timer === null) {
      this.#interacted = false;
      this.#startAutoplay();
    } else {
      this.#stopForGood();
    }

    this.refs.pause?.setAttribute('aria-pressed', this.#timer === null ? 'true' : 'false');
  }

  /* ---------------------------------------------------------- internals -- */

  /** @private */
  #startAutoplay() {
    if (this.autoplayInterval === 0 || this.#interacted) return;

    this.refs.pause?.removeAttribute('hidden');
    this.#pause();
    this.#timer = window.setInterval(() => {
      const last = this.count - 1;
      this.goTo(this.#index >= last ? 0 : this.#index + 1, { animate: true });
    }, this.autoplayInterval);
  }

  /** @private */
  #pause() {
    if (this.#timer === null) return;
    window.clearInterval(this.#timer);
    this.#timer = null;
  }

  /** @private */
  #resume() {
    if (this.#interacted || document.hidden) return;
    this.#startAutoplay();
  }

  /** @private */
  #stopForGood() {
    this.#interacted = true;
    this.#pause();
  }

  /**
   * Work out which slide is showing from the track's scroll position.
   *
   * Reading the scroll position rather than tracking an index means the state is
   * correct however the customer moved: arrows, drag, trackpad, keyboard, or a
   * browser restoring a scroll offset on Back.
   *
   * @private
   */
  #syncFromScroll() {
    const track = this.refs.track;
    const slides = this.slides;
    if (slides.length === 0) return;

    const position = isRTL() ? Math.abs(track.scrollLeft) : track.scrollLeft;

    let closest = 0;
    let smallest = Infinity;

    for (const [index, slide] of slides.entries()) {
      const distance = Math.abs(slide.offsetLeft - track.offsetLeft - position);
      if (distance < smallest) {
        smallest = distance;
        closest = index;
      }
    }

    if (closest === this.#index) {
      this.#syncControls();
      return;
    }

    this.#index = closest;
    this.#syncControls();
    this.#announce();

    this.dispatch(EVENTS.MEDIA_SELECT, {
      index: closest,
      slide: slides[closest],
      mediaId: slides[closest]?.dataset.mediaId || null
    });
  }

  /** @private */
  #update() {
    this.toggleAttribute('data-scrollable', this.scrollable);

    // With everything visible there is nothing to page through, and dead arrows
    // are worse than no arrows.
    for (const ref of ['previous', 'next']) {
      this.refs[ref]?.toggleAttribute('hidden', !this.scrollable);
    }

    this.refs.indicators?.toggleAttribute('hidden', !this.scrollable);
    this.#syncControls();
  }

  /** @private */
  #syncControls() {
    const atStart = this.#index <= 0;
    const atEnd = this.#index >= this.count - 1;

    if (this.refs.previous instanceof HTMLButtonElement && !this.loop) {
      this.refs.previous.disabled = atStart;
    }

    if (this.refs.next instanceof HTMLButtonElement && !this.loop) {
      this.refs.next.disabled = atEnd;
    }

    for (const [index, indicator] of this.indicators.entries()) {
      const current = index === this.#index;
      indicator.toggleAttribute('data-active', current);
      indicator.setAttribute('aria-current', current ? 'true' : 'false');
    }

    this.dataset.index = String(this.#index);
  }

  /** @private */
  #announce() {
    const message = themeString('carouselPosition', '', {
      index: this.#index + 1,
      count: this.count
    });

    if (this.refs.status instanceof HTMLElement) this.refs.status.textContent = message;
  }

  /**
   * @param {KeyboardEvent} event
   * @private
   */
  #onKeydown = (event) => {
    const forward = isRTL() ? 'ArrowLeft' : 'ArrowRight';
    const backward = isRTL() ? 'ArrowRight' : 'ArrowLeft';

    switch (event.key) {
      case forward:
        event.preventDefault();
        this.next();
        break;
      case backward:
        event.preventDefault();
        this.previous();
        break;
      case 'Home':
        event.preventDefault();
        this.goTo(0);
        break;
      case 'End':
        event.preventDefault();
        this.goTo(this.count - 1);
        break;
      default:
        break;
    }
  };
}

defineComponent('swiper-carousel', SwiperCarousel);

/**
 * `<carousel-component>` — the same class under the name the architecture
 * document uses for the unified engine.
 *
 * An alias rather than a rename. Five sections already ship `<swiper-carousel>`
 * in their markup, and a merchant who customised one of them would find it inert
 * after a theme update. Registering the same class twice costs nothing at
 * runtime and means both names work forever.
 *
 * New markup should use `<carousel-component>`; the older name stays supported.
 */
defineComponent('carousel-component', class CarouselComponent extends SwiperCarousel {});

export default SwiperCarousel;
