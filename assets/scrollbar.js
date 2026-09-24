/**
 * Owns everything to do with page scrolling.
 *
 * @module @theme/scrollbar
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { clamp, isDesignMode, prefersReducedMotion, rafThrottle, announce, themeString } from '@theme/utilities';

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

  /** @type {(() => void)|null} */
  #unsubscribeWake = null;

  /** Consecutive frames Lenis has sat still; the loop sleeps once this runs out. */
  #idleFrames = 0;

  /**
   * The back-to-top control, looked up once.
   *
   * @type {Element|null|undefined} undefined until looked up, null if absent.
   */
  #backToTop;

  /* ------------------------------------------------------------ lifecycle ---- */

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
    this.#backToTop = undefined;
    this.#stopLoop();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#unsubscribeWake?.();
    this.#unsubscribeWake = null;
    this.#lenis?.destroy();
    this.#lenis = null;
  }

  /* --------------------------------------------------------- public API -- ---- */

  /** Pause smoothing and hand scrolling back to the browser. */
  stop() {
    this.#lenis?.stop();
  }

  /** Resume smoothing from the page's current position. */
  start() {
    this.#lenis?.start();
    this.#startLoop();
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
   * @param {number} [options.duration=600] Milliseconds. Lenis takes seconds; converted here.
   * @param {boolean} [options.immediate=false] Jump without animating.
   */
  scrollTo(target, { offset = 0, duration = 600, immediate = false } = {}) {
    const jump = immediate || prefersReducedMotion();

    if (this.#lenis) {
      this.#lenis.scrollTo(target, {
        offset,
        immediate: jump,
        duration: duration / 1000,
        lock: false,
        force: true
      });
      this.#startLoop();
      return;
    }

    const top = this.#resolveOffset(target) + offset;
    if (Number.isNaN(top)) return;

    window.scrollTo({ top, behavior: jump ? 'auto' : 'smooth' });
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * @returns {boolean}
   * @private
   */
  #shouldSmooth() {
    if (prefersReducedMotion()) return false;
    // The editor scrolls to the selected section itself; Lenis would fight it.
    if (isDesignMode()) return false;
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

    if (token !== this.#token || !this.isConnected) return;

    this.#lenis = new Lenis({
      lerp: clamp(Number(this.dataset.lerp) || 0.1, 0.01, 1),
      wheelMultiplier: Number(this.dataset.wheelMultiplier) || 1,
      touchMultiplier: Number(this.dataset.touchMultiplier) || 1.5,
      smoothWheel: true,
      syncTouch: false,
      autoRaf: false,
      anchors: false,
      infinite: false
    });

    this.#unsubscribe = this.#lenis.on?.('scroll', this.#onLenisScroll) ?? null;
    // Wheel and touch input arrive here before Lenis starts animating, so a
    // sleeping loop wakes in time to draw the first frame of the scroll.
    this.#unsubscribeWake = this.#lenis.on?.('virtual-scroll', () => this.#startLoop()) ?? null;
    this.#adoptRestoredScroll();
    this.#startLoop();
  }

  /**
   * Take on whatever scroll position the browser restored.
   *
   * @private
   */
  #adoptRestoredScroll() {
    const adopt = () => {
      const lenis = this.#lenis;
      if (!lenis) return;

      lenis.dimensions.resize();

      const actual = window.scrollY;
      if (Math.abs(actual - (lenis.animatedScroll ?? 0)) <= 1) return;

      lenis.scrollTo(actual, { immediate: true, force: true });
    };

    adopt();
    requestAnimationFrame(adopt);

    if (document.readyState === 'complete') {
      setTimeout(adopt, 0);
    } else {
      this.on(window, 'load', adopt, { once: true });
    }
  }

  /**
   * Drive Lenis only while it is animating. A loop that never sleeps keeps the
   * main thread busy on a page nobody is scrolling.
   *
   * @private
   */
  #startLoop() {
    this.#idleFrames = 0;
    if (this.#frame !== null || !this.#lenis) return;

    // Lenis times each step from its previous timestamp; after a sleep that gap
    // is seconds long and the first frame would jump straight to the target.
    this.#lenis.time = performance.now() - 1000 / 60;

    const tick = (time) => {
      const lenis = this.#lenis;
      if (!lenis) {
        this.#frame = null;
        return;
      }

      lenis.raf(time);

      if (lenis.animate?.isRunning) {
        this.#idleFrames = 0;
      } else if (++this.#idleFrames > 10) {
        this.#frame = null;
        return;
      }

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
    // Written on the back-to-top control only: a custom property on <html> is
    // inherited by every element, so writing it there each frame restyled the
    // whole document for the length of every scroll.
    if (this.#backToTop === undefined) this.#backToTop = document.querySelector('scroll-to-top');
    this.#backToTop?.updateFromScroll?.(scrollY, progress);
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

/** A back-to-top control that appears once the customer has scrolled far enough. */
export class ScrollToTop extends BaseComponent {
  static requiredRefs = ['button'];

  /** @type {boolean} */
  #visible = false;

  setup() {
    this.#visible = false;
    this.#applyVisibility(false);

    this.on(this.refs.button, 'click', this.#onClick);

    this.updateFromScroll(window.scrollY, 0);
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * Called directly by `<smooth-scrollbar>` on every scroll frame.
   *
   * @param {number} scrollY
   * @param {number} [progress]
   */
  updateFromScroll(scrollY, progress) {
    const threshold = Number(this.dataset.offset) || 400;
    const shouldShow = scrollY > threshold;

    // The ring is only drawn while the control is on screen.
    if (shouldShow && Number.isFinite(progress)) {
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

  /* ---------------------------------------------------------- internals -- ---- */

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
