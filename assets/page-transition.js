/**
 * `<page-transition>`: a full-screen curtain between page loads.
 *
 * layout/theme.liquid renders it covering the page from the first paint
 * (`data-state="covered"`); its styles live in snippets/critical-style.liquid.
 *
 *   covered → out     : once the page is ready, the curtain animates away.
 *   out     → ready   : parked off-screen, without animating.
 *   ready   → covered : on a same-site link click it animates back in, then navigates.
 *
 * On a reload or back/forward that restores the scroll position
 * (snippets/scroll-restore.liquid) it waits for `theme:scroll-restored`, so
 * the page is already in place under it and never moves while it shows.
 *
 * @module @theme/page-transition
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { prefersReducedMotion, isDesignMode } from '@theme/utilities';

/** Fallback when `--page-transition-duration` can't be read. */
const DEFAULT_DURATION = 600;

export class PageTransition extends BaseComponent {
  /** True once a navigation has been committed, to block a second one. */
  #navigating = false;

  setup() {
    this.setAttribute('aria-hidden', 'true');
    this.setAttribute('data-armed', '');
    this.#navigating = false;

    if (prefersReducedMotion() || isDesignMode()) {
      this.#setState('ready');
      this.setAttribute('data-disabled', '');
      return;
    }

    if (document.documentElement.hasAttribute('data-scroll-restoring')) {
      this.on(document, EVENTS.SCROLL_RESTORED, () => this.#leaveAfterPaint(), { once: true });
    } else {
      this.#leaveAfterPaint();
    }

    this.on(document, 'click', this.#onDocumentClick);

    // A back/forward cache restore brings the page back as it was left: covered.
    this.on(window, 'pageshow', (event) => {
      if (!event.persisted) return;
      this.#navigating = false;
      this.#leave();
    });
  }

  /**
   * Navigate to a URL behind the curtain.
   *
   * @param {string} url
   */
  navigateTo(url) {
    if (this.#navigating) return;
    this.#navigating = true;

    this.#setState('ready');
    // Commit the parked position before animating in.
    void this.offsetWidth;
    this.#setState('covered');
    this.#afterTransition(() => window.location.assign(url));
  }

  /* ---------------------------------------------------------- internals -- */

  /** @param {'covered'|'out'|'ready'} state */
  #setState(state) {
    this.dataset.state = state;
  }

  /** Let the covered frame paint first, then animate away. */
  #leaveAfterPaint() {
    requestAnimationFrame(() => requestAnimationFrame(() => this.#leave()));
  }

  #leave() {
    this.#setState('out');
    this.#afterTransition(() => {
      if (this.dataset.state === 'out') this.#setState('ready');
    });
  }

  /** @param {() => void} callback */
  #afterTransition(callback) {
    const ms = parseFloat(getComputedStyle(this).getPropertyValue('--page-transition-duration')) || DEFAULT_DURATION;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      this.removeEventListener('transitionend', onEnd);
      callback();
    };

    /** @param {TransitionEvent} event */
    const onEnd = (event) => {
      if (event.target === this) finish();
    };

    this.addEventListener('transitionend', onEnd);
    setTimeout(finish, ms + 100);
  }

  /** @param {MouseEvent} event */
  #onDocumentClick = (event) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || !this.#isTransitionable(link)) return;

    event.preventDefault();
    this.navigateTo(link.href);
  };

  /** @param {HTMLAnchorElement} link */
  #isTransitionable(link) {
    if (link.hasAttribute('download')) return false;
    if (link.target && link.target !== '_self') return false;
    if (link.closest('[data-no-transition]')) return false;
    if (link.getAttribute('rel')?.includes('external')) return false;

    let url;
    try {
      url = new URL(link.href, window.location.href);
    } catch {
      return false;
    }

    if (url.origin !== window.location.origin) return false;
    if (!/^https?:$/.test(url.protocol)) return false;

    // Same page, only a hash: let it scroll.
    const samePage = url.pathname === window.location.pathname && url.search === window.location.search;
    if (samePage && url.hash) return false;

    return true;
  }
}

defineComponent('page-transition', PageTransition);

export default PageTransition;
