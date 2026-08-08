/**
 * page-transition.js — Boost10
 *
 * `<page-transition>` animates the gap between page loads.
 *
 * Two implementations, chosen at runtime:
 *
 *   1. The View Transitions API, where supported. The browser handles the
 *      cross-fade natively across a real navigation, which is both smoother and
 *      cheaper than anything scripted.
 *   2. A WAAPI overlay fallback everywhere else: play an exit animation, then
 *      navigate, then play an entrance animation on the next page.
 *
 * This element never fetches or swaps content. Navigation stays a real browser
 * navigation, so the URL, history, scroll restoration, back button and
 * `content_for_header` all keep working exactly as Shopify expects. A theme that
 * turns navigation into `fetch()` inherits every routing bug in a router it did
 * not write, for a visual effect.
 *
 * Safety rails, all of which fall back to a plain navigation:
 *   - reduced motion, or the setting turned off
 *   - modified clicks (new tab, download, middle click)
 *   - cross-origin links, `target` attributes, `mailto:` and `tel:`
 *   - same-page hash links, which scroll instead
 *   - the Theme Editor, where an animated overlay would obstruct editing
 *   - anything marked `data-no-transition`
 *
 * @module @theme/page-transition
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { prefersReducedMotion, isDesignMode } from '@theme/utilities';
import { EASING } from '@theme/motion-engine';

/** How long to wait for the exit animation before navigating regardless. */
const EXIT_TIMEOUT = 700;

export class PageTransition extends BaseComponent {
  /** @type {'fade'|'curtain'|'wipe'} */
  #mode = 'fade';

  /** True once a navigation has been committed, to block a second one. */
  #navigating = false;

  /* ------------------------------------------------------------ lifecycle */

  setup() {
    this.#mode = /** @type {any} */ (this.dataset.mode) || 'fade';
    this.setAttribute('aria-hidden', 'true');
    this.#navigating = false;

    if (!this.#enabled()) {
      this.setAttribute('data-disabled', '');
      return;
    }

    this.removeAttribute('data-disabled');
    this.#playEntrance();

    this.on(document, 'click', this.#onDocumentClick, { capture: true });

    // Restoring from the back/forward cache skips the normal load path, which
    // would otherwise leave the overlay stuck covering the page.
    this.on(window, 'pageshow', (event) => {
      if (event.persisted) {
        this.#navigating = false;
        this.#playEntrance();
      }
    });
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * Navigate to a URL with the configured transition.
   *
   * @param {string} url
   * @returns {Promise<void>}
   */
  async navigateTo(url) {
    if (this.#navigating) return;
    this.#navigating = true;

    if (this.#supportsViewTransitions()) {
      window.location.assign(url);
      return;
    }

    await this.#playExit();
    window.location.assign(url);
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @returns {boolean}
   * @private
   */
  #enabled() {
    if (prefersReducedMotion()) return false;
    if (isDesignMode()) return false;
    if (this.dataset.enabled === 'false') return false;
    return typeof Element.prototype.animate === 'function';
  }

  /**
   * @returns {boolean}
   * @private
   */
  #supportsViewTransitions() {
    // Cross-document view transitions are opted into from CSS with
    // `@view-transition { navigation: auto; }` in base.css. When the browser
    // supports it there is nothing for this element to animate.
    return typeof document.startViewTransition === 'function' && CSS.supports('view-transition-name', 'none');
  }

  /**
   * @param {MouseEvent} event
   * @private
   */
  #onDocumentClick = (event) => {
    if (this.#supportsViewTransitions()) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const link = /** @type {HTMLAnchorElement|null} */ (
      event.target instanceof Element ? event.target.closest('a[href]') : null
    );

    if (!this.#isTransitionable(link)) return;

    event.preventDefault();
    this.navigateTo(link.href);
  };

  /**
   * @param {HTMLAnchorElement|null} link
   * @returns {boolean}
   * @private
   */
  #isTransitionable(link) {
    if (!link) return false;
    if (link.hasAttribute('download')) return false;
    if (link.target && link.target !== '_self') return false;
    if (link.closest('[data-no-transition]')) return false;
    if (link.getAttribute('rel')?.includes('external')) return false;

    const href = link.getAttribute('href') || '';
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;

    let url;
    try {
      url = new URL(link.href, window.location.href);
    } catch {
      return false;
    }

    if (url.origin !== window.location.origin) return false;

    // A link to the current page with only a hash difference should scroll,
    // not reload behind a full-screen overlay.
    const samePage = url.pathname === window.location.pathname && url.search === window.location.search;
    if (samePage && url.hash) return false;

    return true;
  }

  /* --------------------------------------------------------- animation --- */

  /**
   * @returns {Promise<void>}
   * @private
   */
  async #playExit() {
    this.setAttribute('data-state', 'exiting');

    const animation = this.animate(this.#exitKeyframes(), {
      duration: this.#duration(),
      easing: EASING.inOutQuart,
      fill: 'forwards'
    });

    // Never let a stalled animation strand the customer on a covered page.
    await Promise.race([animation.finished.catch(() => {}), timeout(EXIT_TIMEOUT)]);
  }

  /** @private */
  #playEntrance() {
    this.setAttribute('data-state', 'entering');

    const animation = this.animate(this.#entranceKeyframes(), {
      duration: this.#duration(),
      easing: EASING.outExpo,
      fill: 'forwards'
    });

    animation.finished
      .then(() => {
        this.setAttribute('data-state', 'idle');
      })
      .catch(() => {
        this.setAttribute('data-state', 'idle');
      });
  }

  /**
   * @returns {Keyframe[]}
   * @private
   */
  #exitKeyframes() {
    switch (this.#mode) {
      case 'curtain':
        return [
          { transform: 'translate3d(0, 100%, 0)' },
          { transform: 'translate3d(0, 0, 0)' }
        ];
      case 'wipe':
        return [
          { transform: 'scaleX(0)', transformOrigin: 'left center' },
          { transform: 'scaleX(1)', transformOrigin: 'left center' }
        ];
      default:
        return [{ opacity: 0 }, { opacity: 1 }];
    }
  }

  /**
   * @returns {Keyframe[]}
   * @private
   */
  #entranceKeyframes() {
    switch (this.#mode) {
      case 'curtain':
        return [
          { transform: 'translate3d(0, 0, 0)' },
          { transform: 'translate3d(0, -100%, 0)' }
        ];
      case 'wipe':
        return [
          { transform: 'scaleX(1)', transformOrigin: 'right center' },
          { transform: 'scaleX(0)', transformOrigin: 'right center' }
        ];
      default:
        return [{ opacity: 1 }, { opacity: 0 }];
    }
  }

  /**
   * @returns {number}
   * @private
   */
  #duration() {
    const value = Number(this.dataset.duration);
    return Number.isFinite(value) && value > 0 ? value : 420;
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 * @private
 */
function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

defineComponent('page-transition', PageTransition);

export default PageTransition;
