/**
 * scrollbar.js — Boost10
 *
 * Owns everything to do with page scrolling.
 *
 * Two elements live here because they share one piece of state — the current
 * scroll position and its progress — and the architecture rule is that shared
 * state has exactly one owner. `<smooth-scrollbar>` owns it; `<scroll-to-top>`
 * reads it and calls back into the owner by direct method call.
 *
 *   <smooth-scrollbar>  Lenis instance, rAF loop, scroll progress, scrollTo
 *   <scroll-to-top>     Visibility threshold, click handling, focus return
 *
 * Lenis is vendored at `assets/lenis.js` and loaded through the `@theme/lenis`
 * specifier. It is imported dynamically so that a failure to load degrades to
 * native scrolling instead of taking the page down: every public method here
 * has a native fallback path, and nothing else in the theme touches scrolling
 * directly.
 *
 * Required CSS (shipped inline in theme.liquid and repeated in base.css):
 *
 *   html.lenis, html.lenis body { height: auto; }
 *   .lenis.lenis-smooth { scroll-behavior: auto !important; }
 *   .lenis.lenis-smooth [data-lenis-prevent] { overscroll-behavior: contain; }
 *   .lenis.lenis-stopped { overflow: hidden; }
 *   .lenis.lenis-smooth iframe { pointer-events: none; }
 *
 * Mark any independently scrolling container — a tall drawer, a filter panel,
 * a modal body — with `data-lenis-prevent` so Lenis leaves it alone.
 *
 * Public API, called directly by other modules:
 *   stop()      pause smoothing  — `lockScroll()` calls this when an overlay opens
 *   start()     resume smoothing — `unlockScroll()` calls this when the last one closes
 *   scrollTo()  animated scroll to an element, selector or offset
 *   progress    scroll progress from 0 to 1
 *
 * @module @theme/scrollbar
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { clamp, prefersReducedMotion, rafThrottle, setCssVar, announce, themeString } from '@theme/utilities';

/* ==========================================================================
   <smooth-scrollbar>
   ========================================================================== */

export class SmoothScrollbar extends BaseComponent {
  /** @type {any|null} The Lenis instance, once it has loaded. */
  #lenis = null;

  /** @type {number|null} */
  #frame = null;

  /** Incremented on every setup, so a late dynamic import from a previous connection is discarded. */
  #token = 0;

  /** @type {(() => void)|null} */
  #unsubscribe = null;

  /* ------------------------------------------------------------ lifecycle */

  setup() {
    this.#token += 1;
    const token = this.#token;

    if (!this.#shouldSmooth()) {
      this.setAttribute('data-disabled', '');
      this.#trackProgressNatively();
      return;
    }

    this.removeAttribute('data-disabled');
    this.#initLenis(token);
  }

  teardown() {
    this.#token += 1;
    this.#stopLoop();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#lenis?.destroy();
    this.#lenis = null;
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * Pause smoothing and hand scrolling back to the browser.
   *
   * Called directly by `lockScroll()` in utilities.js when a drawer or modal
   * opens. No event is involved: the overlay owns the decision and calls the
   * method on the element that owns the behaviour.
   */
  stop() {
    this.#lenis?.stop();
  }

  /**
   * Resume smoothing from the page's current position.
   */
  start() {
    this.#lenis?.start();
  }

  /**
   * @returns {boolean} True while a Lenis instance is driving the page.
   */
  get running() {
    return Boolean(this.#lenis) && !this.#lenis.isStopped;
  }

  /**
   * @returns {number} Scroll progress from 0 to 1.
   */
  get progress() {
    if (this.#lenis && Number.isFinite(this.#lenis.progress)) return clamp(this.#lenis.progress, 0, 1);

    const limit = document.documentElement.scrollHeight - window.innerHeight;
    return limit > 0 ? clamp(window.scrollY / limit, 0, 1) : 0;
  }

  /**
   * Scroll to a position, element or selector.
   *
   * @param {number|string|Element} target Offset in pixels, a selector, or an element.
   * @param {Object} [options]
   * @param {number} [options.offset=0] Extra pixels, usually a negative header height.
   * @param {number} [options.duration=900] Milliseconds. Lenis takes seconds; converted here.
   * @param {boolean} [options.immediate=false] Jump without animating.
   */
  scrollTo(target, { offset = 0, duration = 900, immediate = false } = {}) {
    const jump = immediate || prefersReducedMotion();

    if (this.#lenis) {
      this.#lenis.scrollTo(target, {
        offset,
        immediate: jump,
        duration: duration / 1000,
        lock: false,
        force: true
      });
      return;
    }

    // Native fallback: Lenis is unavailable or smoothing is switched off.
    const top = this.#resolveOffset(target) + offset;
    if (Number.isNaN(top)) return;

    window.scrollTo({ top, behavior: jump ? 'auto' : 'smooth' });
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @returns {boolean}
   * @private
   */
  #shouldSmooth() {
    if (prefersReducedMotion()) return false;
    if (this.dataset.enabled === 'false') return false;
    return true;
  }

  /**
   * Load Lenis and start the frame loop.
   *
   * @param {number} token
   * @private
   */
  async #initLenis(token) {
    let Lenis;

    try {
      ({ default: Lenis } = await import('@theme/lenis'));
    } catch (error) {
      console.warn('[Boost10] Lenis could not be loaded; falling back to native scrolling.', error);
      this.setAttribute('data-disabled', '');
      this.#trackProgressNatively();
      return;
    }

    // The element was disconnected, or reconnected, while the import was in
    // flight. Anything this call would set up now belongs to a dead connection.
    if (token !== this.#token || !this.isConnected) return;

    this.#lenis = new Lenis({
      lerp: clamp(Number(this.dataset.lerp) || 0.1, 0.01, 1),
      wheelMultiplier: Number(this.dataset.wheelMultiplier) || 1,
      touchMultiplier: Number(this.dataset.touchMultiplier) || 1.5,
      smoothWheel: true,
      // Native momentum on touch beats anything scripted, and hijacking it
      // breaks pull-to-refresh on mobile Safari.
      syncTouch: false,
      autoRaf: false,
      anchors: false,
      infinite: false
    });

    this.#unsubscribe = this.#lenis.on?.('scroll', this.#onLenisScroll) ?? null;
    this.#startLoop();
  }

  /** @private */
  #startLoop() {
    if (this.#frame !== null) return;

    const tick = (time) => {
      this.#lenis?.raf(time);
      this.#frame = requestAnimationFrame(tick);
    };

    this.#frame = requestAnimationFrame(tick);
  }

  /** @private */
  #stopLoop() {
    if (this.#frame === null) return;
    cancelAnimationFrame(this.#frame);
    this.#frame = null;
  }

  /**
   * @param {{ scroll: number, progress: number }} state
   * @private
   */
  #onLenisScroll = (state) => {
    this.#publishProgress(state?.progress ?? this.progress, state?.scroll ?? window.scrollY);
  };

  /**
   * Keep progress reporting alive when Lenis is disabled, so the scroll-to-top
   * control and any progress indicators behave identically either way.
   *
   * @private
   */
  #trackProgressNatively() {
    const update = rafThrottle(() => this.#publishProgress(this.progress, window.scrollY));

    this.on(window, 'scroll', update, { passive: true });
    this.on(window, 'resize', update, { passive: true });

    update();
  }

  /**
   * @param {number} progress
   * @param {number} scrollY
   * @private
   */
  #publishProgress(progress, scrollY) {
    setCssVar('--scroll-progress', clamp(progress, 0, 1).toFixed(4));

    // Direct method call on the element that consumes this state. No event, no
    // registry, and nothing to unsubscribe.
    document.querySelector('scroll-to-top')?.updateFromScroll?.(scrollY, progress);
  }

  /**
   * @param {number|string|Element} target
   * @returns {number}
   * @private
   */
  #resolveOffset(target) {
    if (typeof target === 'number') return target;

    const element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!(element instanceof Element)) return Number.NaN;

    return element.getBoundingClientRect().top + window.scrollY;
  }
}

defineComponent('smooth-scrollbar', SmoothScrollbar);

/* ==========================================================================
   <scroll-to-top>
   ========================================================================== */

/**
 * A back-to-top control that appears once the customer has scrolled far enough.
 *
 * Accessibility decisions worth keeping:
 *
 *   - It is a real `<button>` rendered by Liquid with a translated label, so it
 *     works before this script runs and reads correctly to screen readers.
 *   - While hidden it is `inert`, which removes it from the tab order instead of
 *     leaving an invisible focus stop floating over the page.
 *   - After scrolling, focus moves to the skip-to-content link. Scrolling the
 *     viewport does not move the keyboard caret, so without this a keyboard user
 *     is returned to the top visually and left at the bottom of the tab order.
 *   - The progress ring is decorative and driven by `--scroll-progress`.
 *
 * Attributes:
 *   data-offset  Pixels scrolled before the button appears (default 600)
 */
export class ScrollToTop extends BaseComponent {
  static requiredRefs = ['button'];

  /** @type {boolean} */
  #visible = false;

  setup() {
    this.#visible = false;
    this.#applyVisibility(false);

    this.on(this.refs.button, 'click', this.#onClick);

    // Seed the initial state: the page may already be scrolled on load, or
    // restored mid-page by the browser on a back navigation.
    this.updateFromScroll(window.scrollY, 0);
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * Called directly by `<smooth-scrollbar>` on every scroll frame.
   *
   * @param {number} scrollY
   * @param {number} [progress]
   */
  updateFromScroll(scrollY, progress) {
    const threshold = Number(this.dataset.offset) || 400;
    const shouldShow = scrollY > threshold;

    if (Number.isFinite(progress)) {
      this.style.setProperty('--scroll-progress', String(clamp(progress, 0, 1)));
    }

    if (shouldShow === this.#visible) return;

    this.#visible = shouldShow;
    this.#applyVisibility(shouldShow);
  }

  /**
   * Scroll the page back to the top and return focus to the start of the
   * document.
   */
  scrollToTop() {
    const scrollbar = document.querySelector('smooth-scrollbar');

    if (scrollbar?.scrollTo) {
      scrollbar.scrollTo(0);
    } else {
      window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }

    const skipLink = document.querySelector('.skip-to-content-link');
    if (skipLink instanceof HTMLElement) skipLink.focus({ preventScroll: true });

    announce(themeString('backToTop', ''));
  }

  /* ---------------------------------------------------------- internals -- */

  /** @private */
  #onClick = (event) => {
    event.preventDefault();
    this.scrollToTop();
  };

  /**
   * @param {boolean} visible
   * @private
   */
  #applyVisibility(visible) {
    this.toggleAttribute('data-visible', visible);
    this.toggleAttribute('inert', !visible);
    this.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }
}

defineComponent('scroll-to-top', ScrollToTop);

export default SmoothScrollbar;
