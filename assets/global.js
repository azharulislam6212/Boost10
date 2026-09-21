/**
 * The theme's single entry point, loaded as a module on every page.
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
 * @type {Array<{ specifier: string, tags: string[] }>}
 */
const LAZY_MODULES = [
  { specifier: '@theme/announcement-bar', tags: ['announcement-bar'] },

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

  { specifier: '@theme/product-bundle', tags: ['product-bundle'] },
  { specifier: '@theme/quick-add', tags: ['quick-add-summary'] },
  {
    specifier: '@theme/variant-picker',
    tags: ['variant-picker', 'variant-swatches', 'back-in-stock-form', 'inventory-status']
  },
  { specifier: '@theme/product-selling-plans', tags: ['selling-plan-selector'] },
  { specifier: '@theme/quantity-selector', tags: ['quantity-selector'] },
  {
    specifier: '@theme/price-per-item',
    tags: ['volume-pricing', 'price-per-item', 'variant-cart-qty']
  },
  {
    specifier: '@theme/product-recommendations',
    tags: ['product-recommendations', 'complementary-products']
  },
  { specifier: '@theme/gift-card-recipient-form', tags: ['gift-card-recipient-form'] },

  { specifier: '@theme/form-validation', tags: ['validated-form'] },
  { specifier: '@theme/variant-swatch', tags: ['variant-swatch'] },

  { specifier: '@theme/carousel', tags: ['carousel-slider'] },
  { specifier: '@theme/testimonial-product', tags: ['testimonial-product'] },

  { specifier: '@theme/testimonial-showcase', tags: ['testimonial-showcase'] },
  { specifier: '@theme/highlight-points', tags: ['highlight-points'] },

  { specifier: '@theme/comparison-table', tags: ['comparison-table'] },

  { specifier: '@theme/button-element', tags: ['button-swap'] },

  { specifier: '@theme/background-video', tags: ['background-video'] },

  { specifier: '@theme/collection-tabs', tags: ['collection-tabs'] },

  {
    specifier: '@theme/header',
    tags: ['nav-menu', 'nav-disclosure', 'mobile-nav', 'market-picker', 'account-anchor']
  },
  { specifier: '@theme/tabs', tags: ['tab-group'] },
  { specifier: '@theme/facet-dropdown', tags: ['facet-dropdown'] },

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

/** The site header. */
export class StickyHeader extends BaseComponent {
  /** @type {number} */
  #lastScroll = 0;

  /**
   * The last value written to `data-pinned`, so the attribute is only touched
   * when it changes. Re-writing it every frame would restart the drop-in
   * animation sixty times a second and the header would never finish arriving.
   *
   * @type {boolean|null}
   */
  #pinned = null;

  /** @type {ResizeObserver|null} */
  #observer = null;

  /** @type {(() => void)|null} */
  #unsubscribe = null;

  setup() {
    this.#measure();

    this.#observer = new ResizeObserver(rafThrottle(() => this.#measure()));
    this.#observer.observe(this);

    const announcement = document.querySelector('[data-announcement-bar]');
    if (announcement instanceof HTMLElement) this.#observer.observe(announcement);

    this.#unsubscribe = subscribeToTicker(rafThrottle((scrollY) => this.#onScroll(scrollY)));

    this.#prime();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.setAttribute('data-ready', ''));
    });

    this.on(window, 'pageshow', (event) => {
      if (event.persisted) this.#prime();
    });

    this.on(document, EVENTS.OVERLAY_OPEN, () => this.reveal());
  }

  /**
   * Adopt the page's current scroll position without reacting to it as movement.
   *
   * @private
   */
  #prime() {
    this.setAttribute('data-priming', '');

    this.#lastScroll = Math.max(0, window.scrollY);
    this.#onScroll(window.scrollY, true);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.removeAttribute('data-priming'));
    });
  }

  teardown() {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /* --------------------------------------------------------- public API -- ---- */

  /** Force the header back into view, for instance before scrolling to an anchor. */
  reveal() {
    this.removeAttribute('data-hidden');
  }

  /**
   * @returns {number} The header's current height in pixels.
   */
  get height() {
    return this.offsetHeight;
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /** @private */
  #measure() {
    setCssVar('--header-height', `${this.offsetHeight}px`);

    const announcement = document.querySelector('[data-announcement-bar]');
    if (announcement instanceof HTMLElement) {
      setCssVar('--announcement-height', `${announcement.offsetHeight}px`);
    }

    setCssVar('--header-sticky-offset', `${this.#stickyOffset()}px`);
    setCssVar('--header-offset-above', `${this.#offsetAbove()}px`);
  }

  /**
   * How far below the top of the viewport the header sits when nothing is
   * pinned yet — the combined height of everything above it in the header
   * group, which in a default theme is the announcement bar.
   *
   * @returns {number}
   * @private
   */
  #offsetAbove() {
    let offset = 0;

    for (const section of document.querySelectorAll('.shopify-section')) {
      if (section.contains(this)) break;
      if (!(section instanceof HTMLElement)) continue;
      if (getComputedStyle(section).position === 'fixed') continue;

      offset += section.offsetHeight;
    }

    return offset;
  }

  /**
   * How far down the header should pin.
   *
   * @returns {number}
   * @private
   */
  #stickyOffset() {
    let offset = 0;

    for (const section of document.querySelectorAll('.shopify-section')) {
      if (section.contains(this)) break;
      if (!(section instanceof HTMLElement)) continue;

      const position = getComputedStyle(section).position;
      if (position !== 'sticky' && position !== 'fixed') continue;

      offset += section.offsetHeight;
    }

    return offset;
  }

  /**
   * @param {number} scrollY
   * @private
   */
  #onScroll(scrollY, priming = false) {
    const threshold = Number(this.dataset.threshold) || 80;
    const position = Math.max(0, scrollY);
    const mode = this.dataset.stickyMode || 'always';
    const scrolled = position > threshold;

    this.toggleAttribute('data-scrolled', scrolled);

    if (this.classList.contains('site-header--transparent')) {
      this.toggleAttribute('data-transparent', !scrolled);
    }

    const scheme = this.dataset.stickyScheme;
    const shell = this.querySelector('.site-header__shell');

    if (scheme && shell) {
      shell.classList.toggle(scheme, scrolled);
    }

    if (mode === 'scroll-down') {
      const pinPoint = this.#offsetAbove() + this.offsetHeight;
      const pinned = position > pinPoint;

      if (pinned !== this.#pinned) {
        this.#pinned = pinned;
        this.toggleAttribute('data-pinned', pinned);

        this.toggleAttribute('data-instant', pinned && priming);
      }

      this.removeAttribute('data-hidden');
    } else if (mode !== 'scroll-up') {
      this.removeAttribute('data-hidden');
    }

    if (mode !== 'scroll-down' && this.#pinned !== null) {
      this.#pinned = null;
      this.removeAttribute('data-pinned');
      this.removeAttribute('data-instant');
    }

    const delta = position - this.#lastScroll;

    if (priming) return;

    if (Math.abs(delta) < 6) return;
    this.#lastScroll = position;

    if (mode === 'scroll-up') {
      this.toggleAttribute('data-hidden', delta > 0 && position > threshold * 2);
    }
  }
}

defineComponent('sticky-header', StickyHeader);

/* ==========================================================================
   <mega-menu>
   ========================================================================== */

/** A top-level navigation item with a panel. */
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

  /* --------------------------------------------------------- public API -- ---- */

  /** @returns {boolean} */
  get isOpen() {
    return this.hasAttribute('data-open');
  }

  open() {
    if (this.isOpen) return;

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

  /* ---------------------------------------------------------- internals -- ---- */

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

/** The nested menu inside the mobile navigation drawer. */
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

  /* --------------------------------------------------------- public API -- ---- */

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

  /** Return to the parent panel. */
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

  /* ---------------------------------------------------------- internals -- ---- */

  /** @private */
  #applyState() {
    const active = this.#stack[this.#stack.length - 1] || null;

    for (const panel of this.querySelectorAll('[data-menu-panel]')) {
      const isActive = active === null ? panel.hasAttribute('data-menu-root') : panel.dataset.menuPanel === active;

      panel.toggleAttribute('data-active', isActive);
      panel.toggleAttribute('inert', !isActive);
    }

    this.dataset.depth = String(this.#stack.length);

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

/** A wrapper around a plain `<img>` that fades the image in once it decodes. */
export class ResponsiveImage extends BaseComponent {
  /**
   * `data-loaded` is watched because this element writes it and something else
   * removes it.
   *
   * @type {string[]}
   */
  static observedAttributes = ['data-loaded'];

  setup() {
    const image = this.querySelector('img');
    if (!(image instanceof HTMLImageElement)) return;

    if (image.complete && image.naturalWidth > 0) {
      this.#markLoaded();
      return;
    }

    this.on(image, 'load', () => this.#markLoaded());
    this.on(image, 'error', () => {
      this.setAttribute('data-error', '');
      this.#markLoaded();
    });
  }

  /**
   * @param {string} name
   * @param {string|null} _oldValue
   * @param {string|null} newValue
   */
  attributeChanged(name, _oldValue, newValue) {
    if (name !== 'data-loaded' || newValue !== null) return;

    const image = this.querySelector('img');
    if (image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0) {
      this.#markLoaded();
    }
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

/** A consent notice for regions that require one. */
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
  for (const nav of overlay?.querySelectorAll('mobile-nav, mobile-navigation') || []) {
    /** @type {any} */ (nav).reset?.();
  }
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

  document.addEventListener('shopify:section:load', (event) => {
    loadModulesFor(event.target instanceof Element ? event.target : document);
  });

  document.addEventListener(EVENTS.SECTION_RENDERED, (event) => {
    loadModulesFor(event.target instanceof Element ? event.target : document);
  });

  document.addEventListener(EVENTS.OVERLAY_CLOSE, onOverlayClose);

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

  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export default { loadModulesFor, StickyHeader, MegaMenu, MobileNavigation, ResponsiveImage, CookieBanner };

