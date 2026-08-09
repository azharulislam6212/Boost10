/**
 * global.js — Boost10
 *
 * The theme's single entry point, loaded as a module on every page.
 *
 * Three jobs:
 *
 *   1. Register the elements that exist on every page: the header, navigation,
 *      responsive images and the cookie banner.
 *   2. Lazily load feature modules based on what is actually in the document.
 *      A collection page never downloads the cart line editor; a password page
 *      downloads almost nothing. The scan re-runs after every section render, so
 *      markup that arrives by AJAX gets its behaviour too.
 *   3. Publish layout measurements — header height, announcement height — as
 *      custom properties, so sticky offsets are computed once rather than
 *      guessed in a dozen stylesheets.
 *
 * What it is not: a bootstrapper that news up controllers, a registry of
 * components, or a place for page-specific logic. Elements register themselves
 * in their own modules; this file only decides which modules a page needs.
 *
 * @module @theme/global
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import {
  clamp,
  debounce,
  rafThrottle,
  setCssVar,
  storage,
  isRTL,
  prefersReducedMotion,
  getFocusableElements
} from '@theme/utilities';
import { subscribeToTicker } from '@theme/motion-engine';

// Side-effect imports: these register their own elements and are needed on
// every page, so they are static rather than lazy.
import '@theme/dialog';
import '@theme/modules';
import '@theme/motion-effect';
import '@theme/scrollbar';
import '@theme/page-transition';

/* ==========================================================================
   Lazy module map
   ========================================================================== */

/**
 * Which module owns which custom elements.
 *
 * The scan below uses `:not(:defined)`, so a module is only fetched while at
 * least one of its elements is still unregistered. Once it has loaded, the
 * elements become defined and stop matching, which makes repeated scans free.
 *
 * @type {Array<{ specifier: string, tags: string[] }>}
 */
const LAZY_MODULES = [
  { specifier: '@theme/search', tags: ['predictive-search', 'search-drawer', 'search-list'] },
  { specifier: '@theme/results-list', tags: ['results-list'] },
  { specifier: '@theme/localization', tags: ['localization-form'] },
  { specifier: '@theme/facets', tags: ['facet-filters', 'facet-drawer', 'price-range', 'sort-by'] },

  { specifier: '@theme/cart-drawer', tags: ['cart-drawer'] },
  { specifier: '@theme/cart-items', tags: ['cart-items', 'cart-note', 'gift-wrap-toggle'] },
  { specifier: '@theme/promo-code', tags: ['promo-code'] },
  { specifier: '@theme/cart-selling-plans', tags: ['cart-selling-plan-selector'] },
  { specifier: '@theme/cart-shipping', tags: ['shipping-calculator'] },
  { specifier: '@theme/free-shipping-bar', tags: ['free-shipping-bar'] },

  { specifier: '@theme/product-form', tags: ['product-form', 'sticky-add-to-cart', 'bundle-builder'] },
  {
    specifier: '@theme/variant-picker',
    tags: ['variant-picker', 'variant-swatches', 'back-in-stock-form', 'inventory-status']
  },
  { specifier: '@theme/product-selling-plans', tags: ['selling-plan-selector'] },
  { specifier: '@theme/quantity-selector', tags: ['quantity-selector'] },
  {
    specifier: '@theme/product-recommendations',
    tags: ['product-recommendations', 'complementary-products']
  },
  { specifier: '@theme/gift-card-recipient-form', tags: ['gift-card-recipient-form'] },

  { specifier: '@theme/carousel', tags: ['swiper-carousel'] },
  { specifier: '@theme/media-gallery', tags: ['media-gallery', 'media-thumbnails'] },
  { specifier: '@theme/media-coordinator', tags: ['media-coordinator'] },
  { specifier: '@theme/media-zoom', tags: ['media-zoom', 'media-zoom-modal'] },

  { specifier: '@theme/customer-addresses', tags: ['customer-address-form'] },
  { specifier: '@theme/customer-orders', tags: ['customer-order-history'] },

  { specifier: '@theme/compare', tags: ['product-compare', 'compare-trigger'] },
  {
    specifier: '@theme/recently-viewed',
    tags: ['recently-viewed']
  },
  { specifier: '@theme/promo-popup', tags: ['promo-popup'] },
  { specifier: '@theme/store-locator', tags: ['store-locator', 'store-map'] }
];

/** Modules already requested, so a re-scan never fetches twice. */
const requested = new Set();

/**
 * Load every module whose elements are present and still undefined.
 *
 * Failures are logged and swallowed per module: a missing store locator must
 * not stop the cart drawer from loading.
 *
 * @param {ParentNode} [root=document]
 * @returns {Promise<void>}
 */
export async function loadModulesFor(root = document) {
  const pending = [];

  for (const { specifier, tags } of LAZY_MODULES) {
    if (requested.has(specifier)) continue;

    const selector = tags.map((tag) => `${tag}:not(:defined)`).join(',');
    if (!root.querySelector(selector)) continue;

    requested.add(specifier);

    pending.push(
      import(specifier).catch((error) => {
        // Allow a retry on the next scan: the failure may have been transient.
        requested.delete(specifier);
        console.error(`[Boost10] Could not load ${specifier}.`, error);
      })
    );
  }

  await Promise.all(pending);
}

/* ==========================================================================
   <sticky-header>
   ========================================================================== */

/**
 * The site header.
 *
 * Publishes its own height as `--header-height` so that sticky offsets, scroll
 * targets and drawer positions all read one number instead of hardcoding one.
 * Optionally hides on scroll down and returns on scroll up.
 *
 * Attributes:
 *   data-sticky      "false" to keep the header in the flow
 *   data-hide-on-scroll  "true" to hide while scrolling down
 *   data-threshold   Pixels scrolled before the sticky state engages (default 80)
 */
export class StickyHeader extends BaseComponent {
  /** @type {number} */
  #lastScroll = 0;

  /** @type {ResizeObserver|null} */
  #observer = null;

  /** @type {(() => void)|null} */
  #unsubscribe = null;

  setup() {
    this.#measure();

    this.#observer = new ResizeObserver(rafThrottle(() => this.#measure()));
    this.#observer.observe(this);

    if (this.dataset.sticky !== 'false') {
      this.#unsubscribe = subscribeToTicker(rafThrottle((scrollY) => this.#onScroll(scrollY)));
    }

    // An open drawer must never be hidden by a header that scrolled away.
    this.on(document, EVENTS.OVERLAY_OPEN, () => this.reveal());
  }

  teardown() {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * Force the header back into view, for instance before scrolling to an anchor.
   */
  reveal() {
    this.removeAttribute('data-hidden');
  }

  /**
   * @returns {number} The header's current height in pixels.
   */
  get height() {
    return this.offsetHeight;
  }

  /* ---------------------------------------------------------- internals -- */

  /** @private */
  #measure() {
    setCssVar('--header-height', `${this.offsetHeight}px`);

    const announcement = document.querySelector('[data-announcement-bar]');
    if (announcement instanceof HTMLElement) {
      setCssVar('--announcement-height', `${announcement.offsetHeight}px`);
    }
  }

  /**
   * @param {number} scrollY
   * @private
   */
  #onScroll(scrollY) {
    const threshold = Number(this.dataset.threshold) || 80;
    const position = Math.max(0, scrollY);

    this.toggleAttribute('data-scrolled', position > threshold);

    if (this.dataset.hideOnScroll !== 'true') {
      this.#lastScroll = position;
      return;
    }

    const delta = position - this.#lastScroll;

    // A small deadzone stops the header flickering during momentum scrolling,
    // which is exactly the condition Lenis produces most of.
    if (Math.abs(delta) < 6) return;

    if (delta > 0 && position > threshold * 2) {
      this.setAttribute('data-hidden', '');
    } else {
      this.removeAttribute('data-hidden');
    }

    this.#lastScroll = position;
  }
}

defineComponent('sticky-header', StickyHeader);

/* ==========================================================================
   <mega-menu>
   ========================================================================== */

/**
 * A top-level navigation item with a panel.
 *
 * Opens on hover for pointer users and on focus for keyboard users, which are
 * different needs: hover needs a close delay so a diagonal mouse path does not
 * dismiss the panel, and focus needs none. Escape closes and returns focus to
 * the trigger.
 */
export class MegaMenu extends BaseComponent {
  static requiredRefs = ['trigger', 'panel'];

  /** @type {number|null} */
  #closeTimer = null;

  setup() {
    this.refs.trigger.setAttribute('aria-expanded', 'false');

    this.on(this.refs.trigger, 'click', (event) => {
      event.preventDefault();
      this.toggle();
    });

    this.on(this, 'pointerenter', () => {
      if (this.dataset.trigger === 'click') return;
      this.#cancelClose();
      this.open();
    });

    this.on(this, 'pointerleave', () => {
      if (this.dataset.trigger === 'click') return;
      this.#scheduleClose();
    });

    this.on(this, 'focusin', () => {
      this.#cancelClose();
      this.open();
    });

    this.on(this, 'focusout', (event) => {
      if (this.contains(event.relatedTarget)) return;
      this.close();
    });

    this.on(this, 'keydown', (event) => {
      if (event.key !== 'Escape' || !this.isOpen) return;
      event.stopPropagation();
      this.close();
      this.refs.trigger.focus();
    });
  }

  teardown() {
    this.#cancelClose();
  }

  /* --------------------------------------------------------- public API -- */

  /** @returns {boolean} */
  get isOpen() {
    return this.hasAttribute('data-open');
  }

  open() {
    if (this.isOpen) return;

    // Only one panel at a time: two open mega menus overlap and neither is usable.
    for (const other of document.querySelectorAll('mega-menu[data-open]')) {
      if (other !== this) other.close?.();
    }

    this.setAttribute('data-open', '');
    this.refs.trigger.setAttribute('aria-expanded', 'true');
  }

  close() {
    if (!this.isOpen) return;
    this.removeAttribute('data-open');
    this.refs.trigger.setAttribute('aria-expanded', 'false');
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /* ---------------------------------------------------------- internals -- */

  /** @private */
  #scheduleClose() {
    this.#cancelClose();
    this.#closeTimer = window.setTimeout(() => this.close(), 180);
  }

  /** @private */
  #cancelClose() {
    if (this.#closeTimer === null) return;
    window.clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
  }
}

defineComponent('mega-menu', MegaMenu);

/* ==========================================================================
   <mobile-navigation>
   ========================================================================== */

/**
 * The nested menu inside the mobile navigation drawer.
 *
 * Panels slide sideways rather than nesting accordions, because a three-level
 * accordion on a phone pushes the third level below the fold before it opens.
 * Only the active panel is reachable: inactive panels are `inert`, so Tab does
 * not wander into a menu the customer cannot see.
 */
export class MobileNavigation extends BaseComponent {
  /** @type {string[]} */
  #stack = [];

  setup() {
    this.#stack = [];
    this.#applyState();

    this.on(this, 'click', (event) => {
      const opener = event.target instanceof Element ? event.target.closest('[data-menu-open]') : null;
      if (opener instanceof HTMLElement) {
        event.preventDefault();
        this.push(opener.dataset.menuOpen);
        return;
      }

      const back = event.target instanceof Element ? event.target.closest('[data-menu-back]') : null;
      if (back) {
        event.preventDefault();
        this.pop();
      }
    });
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * Open a child panel.
   *
   * @param {string} id
   */
  push(id) {
    if (!id) return;
    this.#stack.push(id);
    this.#applyState();
  }

  /**
   * Return to the parent panel.
   */
  pop() {
    this.#stack.pop();
    this.#applyState();
  }

  /**
   * Return to the root panel. Called when the drawer closes, so it reopens at
   * the top rather than four levels deep.
   */
  reset() {
    this.#stack = [];
    this.#applyState();
  }

  /** @returns {number} */
  get depth() {
    return this.#stack.length;
  }

  /* ---------------------------------------------------------- internals -- */

  /** @private */
  #applyState() {
    const active = this.#stack[this.#stack.length - 1] || null;

    for (const panel of this.querySelectorAll('[data-menu-panel]')) {
      const isActive = active === null ? panel.hasAttribute('data-menu-root') : panel.dataset.menuPanel === active;

      panel.toggleAttribute('data-active', isActive);
      panel.toggleAttribute('inert', !isActive);
    }

    this.dataset.depth = String(this.#stack.length);

    // Move focus to the first control in the newly revealed panel, or the whole
    // drawer becomes unusable by keyboard once a submenu opens.
    const panel = this.querySelector('[data-menu-panel][data-active]');
    if (panel && this.#stack.length > 0) {
      const first = getFocusableElements(panel)[0];
      first?.focus({ preventScroll: true });
    }
  }
}

defineComponent('mobile-navigation', MobileNavigation);

/* ==========================================================================
   <responsive-image>
   ========================================================================== */

/**
 * A wrapper around a plain `<img>` that fades the image in once it decodes.
 *
 * Written as an autonomous element rather than a customized built-in
 * (`is="responsive-image"`), because Safari has never shipped customized
 * built-ins. As `is=`, this behaviour would silently do nothing for roughly a
 * fifth of storefront traffic.
 *
 * The `<img>` inside carries its own `width`, `height`, `srcset` and `sizes`
 * from Liquid. Nothing here changes what is loaded — the browser is better at
 * that than any script — it only handles the reveal.
 */
export class ResponsiveImage extends BaseComponent {
  setup() {
    const image = this.querySelector('img');
    if (!(image instanceof HTMLImageElement)) return;

    if (image.complete && image.naturalWidth > 0) {
      this.#markLoaded();
      return;
    }

    this.on(image, 'load', () => this.#markLoaded());
    this.on(image, 'error', () => {
      // A broken image should not leave an empty box faded to zero.
      this.setAttribute('data-error', '');
      this.#markLoaded();
    });
  }

  /** @private */
  #markLoaded() {
    this.setAttribute('data-loaded', '');
  }
}

defineComponent('responsive-image', ResponsiveImage);

/* ==========================================================================
   <cookie-banner>
   ========================================================================== */

/**
 * A consent notice for regions that require one.
 *
 * The choice is stored in `localStorage`, namespaced per shop, and the banner
 * only ever hides itself — it does not load, block or unblock anything. Actual
 * consent enforcement belongs to Shopify's customer privacy API and to the
 * merchant's apps, not to a theme.
 */
export class CookieBanner extends BaseComponent {
  static requiredRefs = ['accept'];

  /** Storage key, namespaced by `storage`. */
  static KEY = 'cookie-consent';

  setup() {
    const stored = storage.get(CookieBanner.KEY, null);

    if (stored !== null) {
      this.hidden = true;
      return;
    }

    // Delay the reveal so it does not compete with the largest contentful paint.
    window.setTimeout(() => {
      this.hidden = false;
      this.setAttribute('data-visible', '');
    }, Number(this.dataset.delay) || 1500);

    this.on(this.refs.accept, 'click', () => this.respond(true));
    if (this.refs.decline) this.on(this.refs.decline, 'click', () => this.respond(false));
  }

  /**
   * Record the customer's choice and dismiss.
   *
   * @param {boolean} accepted
   */
  respond(accepted) {
    storage.set(CookieBanner.KEY, accepted);
    this.removeAttribute('data-visible');

    window.setTimeout(() => {
      this.hidden = true;
    }, prefersReducedMotion() ? 0 : 300);
  }
}

defineComponent('cookie-banner', CookieBanner);

/* ==========================================================================
   Boot
   ========================================================================== */

/**
 * Publish viewport measurements that CSS cannot compute on its own.
 *
 * `--viewport-height` exists because `100vh` on mobile Safari is the height with
 * the address bar collapsed, which is taller than the visible area on load.
 * `100dvh` fixes it on modern browsers and this covers the rest.
 *
 * @private
 */
function publishViewport() {
  setCssVar('--viewport-height', `${window.innerHeight}px`);
  setCssVar('--scrollbar-width', `${window.innerWidth - document.documentElement.clientWidth}px`);
}

/**
 * Reset the mobile navigation when its drawer closes, so it reopens at the top.
 *
 * @param {CustomEvent} event
 * @private
 */
function onOverlayClose(event) {
  const overlay = event.target instanceof Element ? event.target : null;
  overlay?.querySelector('mobile-navigation')?.reset?.();
}

/**
 * Wire up everything that is not an element's own responsibility.
 *
 * @private
 */
function boot() {
  document.documentElement.setAttribute('data-direction', isRTL() ? 'rtl' : 'ltr');

  publishViewport();
  window.addEventListener('resize', debounce(publishViewport, 150), { passive: true });
  window.addEventListener('orientationchange', publishViewport, { passive: true });

  loadModulesFor();

  // Markup that arrives by AJAX needs the same treatment as markup that arrived
  // with the document: a section render, a filter update or a cart refresh can
  // all introduce elements no module has been loaded for yet.
  document.addEventListener('shopify:section:load', (event) => {
    loadModulesFor(event.target instanceof Element ? event.target : document);
  });

  document.addEventListener(EVENTS.SECTION_RENDERED, (event) => {
    loadModulesFor(event.target instanceof Element ? event.target : document);
  });

  document.addEventListener(EVENTS.OVERLAY_CLOSE, onOverlayClose);

  // Anchor links have to clear the sticky header, or the heading they point at
  // lands underneath it.
  document.addEventListener('click', onAnchorClick, { capture: true });
}

/**
 * @param {MouseEvent} event
 * @private
 */
function onAnchorClick(event) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
  if (!(link instanceof HTMLAnchorElement)) return;

  const id = link.getAttribute('href')?.slice(1);
  if (!id || id === 'MainContent') return;

  const target = document.getElementById(id);
  if (!target) return;

  event.preventDefault();

  const header = document.querySelector('sticky-header');
  header?.reveal?.();

  const offset = -(header?.height ?? 0) - 16;
  const scrollbar = document.querySelector('smooth-scrollbar');

  if (scrollbar?.scrollTo) {
    scrollbar.scrollTo(target, { offset });
  } else {
    const top = target.getBoundingClientRect().top + window.scrollY + offset;
    window.scrollTo({ top: clamp(top, 0, Number.MAX_SAFE_INTEGER), behavior: 'smooth' });
  }

  // Scrolling does not move the keyboard caret, so a keyboard user would be
  // left where they were. Focus the destination explicitly.
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export default { loadModulesFor, StickyHeader, MegaMenu, MobileNavigation, ResponsiveImage, CookieBanner };




