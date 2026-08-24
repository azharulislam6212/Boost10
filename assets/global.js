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
  // The announcement bar is the one module where a missing entry is not a
  // degraded feature but a blank section: `announcement-bar[data-dismissible]`
  // is `display: none` until the component writes `data-ready`, so a bar with
  // "show close" enabled never painted at all while this line was absent.
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

  // Same class of bug as the announcement bar, found while auditing the rest of
  // the tag registry. `<validated-form>` wraps the contact, login, register,
  // reset-password, activate-account, comment, newsletter and back-in-stock
  // forms, and `<variant-swatch>` is the colour swatch on every product card.
  // Neither module was reachable, so both features were inert theme-wide.
  { specifier: '@theme/form-validation', tags: ['validated-form'] },
  { specifier: '@theme/variant-swatch', tags: ['variant-swatch'] },

  { specifier: '@theme/carousel', tags: ['swiper-carousel'] },

  // `<button-swap>` is only emitted for buttons whose hover effect actually
  // needs a duplicated track, so a page of ordinary buttons never fetches this.
  { specifier: '@theme/button-element', tags: ['button-swap'] },

  // Background video. Lazy like everything else here: a page with no background
  // video never fetches the module, and a page with one below the fold fetches
  // it only when the element is registered.
  { specifier: '@theme/background-video', tags: ['background-video'] },

  // `<collection-tabs>` hides all but the first panel, and a carousel inside a
  // hidden panel measures zero. Without this the mega menu's product carousels
  // were both unswitchable and unmeasurable.
  { specifier: '@theme/collection-tabs', tags: ['collection-tabs'] },

  // The header's own behaviour. `<sticky-header>` is registered in this file
  // because every page has one; the navigation is lazy because a password
  // page, a checkout-adjacent page and a bare landing page have no menu.
  { specifier: '@theme/header', tags: ['nav-menu', 'nav-disclosure', 'mobile-nav', 'market-picker'] },
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
 * ## Four sticky modes, one attribute
 *
 * `sticky` and `hide-on-scroll` as two independent booleans produced a state
 * nobody wanted — "not pinned, but hides on scroll" — and both this file and
 * the stylesheet had to defend against it. `data-sticky-mode` has four values
 * and no impossible combinations:
 *
 *   never        left in the flow; this component only measures
 *   always       pinned from the first pixel
 *   scroll-up    pinned, hides going down, returns going up
 *   scroll-down  hidden until the page has scrolled past a fold, then pinned
 *
 * ## Transparency and the sticky scheme
 *
 * `[data-transparent]` is removed as soon as the page scrolls past the
 * threshold, and the merchant's sticky colour scheme class is added at the same
 * moment. Both are attribute writes on one element, so the whole header —
 * icons, cart bubble, dropdown panels — recolours from the scheme tokens
 * without a second rule anywhere.
 *
 * Attributes:
 *   data-sticky-mode    never | always | scroll-up | scroll-down
 *   data-sticky-scheme  A `color-scheme-n` class applied once scrolled
 *   data-threshold      Pixels scrolled before the sticky state engages (default 80)
 */
export class StickyHeader extends BaseComponent {
  /** @type {number} */
  #lastScroll = 0;

  /**
   * The last value written to `data-pinned`, so the attribute is only touched
   * when it changes. Re-writing it every frame would restart the drop-in
   * animation sixty times a second and the header would never finish arriving.
   *
   * `null` until the first call, so priming always writes once.
   *
   * @type {boolean|null}
   */
  #pinned = null;

  /** @type {ResizeObserver|null} */
  #observer = null;

  /** @type {(() => void)|null} */
  #unsubscribe = null;

  setup() {
    // Nothing here hides the header, and nothing here positions it.
    //
    // `data-booting` used to be written on this line, and `header.css` used it
    // to hold `.site-header__shell` at `visibility: hidden` until two frames
    // after this method ran. On a fast connection that is imperceptible; on a
    // slow one the storefront renders an announcement bar sitting straight on
    // top of the hero, with the header arriving whenever the module does.
    //
    // The state this was protecting is already correct before the upgrade: the
    // section publishes the header's height from the merchant's settings, and
    // `.header-section:has([data-sticky-mode])` pins it in CSS. What this
    // element adds is refinement — the measured height, the scrolled and
    // transparent states — none of which is a reason to withhold the header.
    // The transition between those states is suppressed by `[data-priming]`
    // instead, which costs nothing visually.
    this.#measure();

    this.#observer = new ResizeObserver(rafThrottle(() => this.#measure()));
    this.#observer.observe(this);

    // The announcement bar is measured as well as the header. Its height is
    // half of where the header hides to, and it changes on its own: it reflows
    // at mobile widths, and a dismissible bar removes itself entirely. Observed
    // rather than measured once, so neither leaves a stale number behind.
    const announcement = document.querySelector('[data-announcement-bar]');
    if (announcement instanceof HTMLElement) this.#observer.observe(announcement);

    // Every mode except `never` reacts to scroll — and `never` still needs the
    // transparent state cleared once the page moves past the banner, so the
    // subscription is unconditional and the mode is read inside the callback.
    this.#unsubscribe = subscribeToTicker(rafThrottle((scrollY) => this.#onScroll(scrollY)));

    // The ticker only reports on movement. Without this first call a header
    // in `scroll-down` mode is visible until the customer scrolls, which is
    // the one moment the mode exists to avoid, and a page loaded mid-scroll
    // (a refresh, a back navigation) starts transparent over solid content.
    this.#prime();

    // `data-ready` is a hook for anything that wants to know the header has
    // finished priming — it hides nothing and gates nothing. Two frames matches
    // the window `#prime()` uses.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.setAttribute('data-ready', ''));
    });

    // Restoring from the back/forward cache skips `setup()` entirely, and the
    // scroll position it restores is not the one this element last saw.
    this.on(window, 'pageshow', (event) => {
      if (event.persisted) this.#prime();
    });

    // An open drawer must never be hidden by a header that scrolled away.
    this.on(document, EVENTS.OVERLAY_OPEN, () => this.reveal());
  }

  /**
   * Adopt the page's current scroll position without reacting to it as movement.
   *
   * Reloading a page that was already scrolled is the case this exists for. The
   * browser restores the scroll offset, `setup()` runs, and the first
   * `#onScroll` call used to compare that offset against `#lastScroll`, which
   * was still `0` from the field initialiser. So a refresh at 1200px was read as
   * a 1200px downward scroll that had just happened:
   *
   *   - in `scroll-up` mode the header immediately hid itself, sliding up and
   *     out of view a moment after the page appeared, and stayed gone until the
   *     customer scrolled up. That is the jump.
   *   - in every mode the transparent state, the sticky colour scheme and the
   *     shadow were all applied *after* the first paint, so the header painted
   *     in its top-of-page appearance and then transitioned into its scrolled
   *     one over 320ms — visible as the bar changing colour under the cursor on
   *     every reload.
   *
   * The baseline is taken first, so `delta` is 0 and nothing is treated as
   * movement. `data-priming` suppresses transitions for the two frames it takes
   * the attribute writes to land and paint, so the correct state arrives without
   * animating from the wrong one.
   *
   * @private
   */
  #prime() {
    this.setAttribute('data-priming', '');

    this.#lastScroll = Math.max(0, window.scrollY);
    this.#onScroll(window.scrollY, true);

    // One frame for the style change, one for it to be painted. Removing the
    // attribute in the same frame it was added would let the transition run.
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

    setCssVar('--header-sticky-offset', `${this.#stickyOffset()}px`);
    // Published as well as used internally: a section that needs to know where
    // the header's flow position begins can read it without measuring again.
    setCssVar('--header-offset-above', `${this.#offsetAbove()}px`);
  }

  /**
   * How far below the top of the viewport the header sits when nothing is
   * pinned yet — the combined height of everything above it in the header
   * group, which in a default theme is the announcement bar.
   *
   * This is what `scroll-down` pins against. Added to the header's own height it
   * gives the scroll position at which the header's bottom edge passes the top
   * of the viewport — the moment the in-flow header has gone and the fixed one
   * can take its place.
   *
   * `sticky` is counted and `fixed` is not: a sticky section above the header is
   * in flow and does push it down, while a fixed one is out of flow and does
   * not.
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
   * Zero unless something above it is pinned too. A sticky announcement bar
   * keeps the top of the viewport, and a header pinned to `0` lands on top of
   * it — so the header starts where that element ends instead.
   *
   * Measured rather than configured: the merchant can turn the announcement bar
   * on, off or sticky, and none of that should require a second setting here.
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

    // Transparency ends where the banner does. The class stays — it says the
    // template supports transparency — and only the live state is removed, so
    // scrolling back to the top restores it without re-reading any settings.
    if (this.classList.contains('site-header--transparent')) {
      this.toggleAttribute('data-transparent', !scrolled);
    }

    // The sticky scheme goes on the *shell*, not on this element.
    //
    // On the header root it was inherited by everything the header contains —
    // and a mega menu panel or a country list is not part of the bar. They
    // turned dark with it, which is not what "sticky header background" means.
    //
    // The shell is the bar. `--header-surface`, `--header-ink` and the rest are
    // captured one level up on this element, so they keep the *base* scheme and
    // the panels have something correct to reset themselves to.
    const scheme = this.dataset.stickyScheme;
    const shell = this.querySelector('.site-header__shell');

    if (scheme && shell) {
      shell.classList.toggle(scheme, scrolled);
    }

    // `scroll-down` pins rather than hides.
    //
    // It used to set `data-hidden` whenever the page was near the top, which is
    // most of the time a customer spends on a landing page — so the header was
    // simply not there. What it should do is behave like an ordinary header
    // until the page has scrolled past it, and then come back pinned.
    //
    // The switch is the header's own bottom edge: everything above it in the
    // group, plus its own height. Above that line the header is still at least
    // partly on screen and belongs in the flow; below it the header has gone,
    // and the fixed copy can drop in without two of them being visible at once.
    //
    // Decided by position rather than direction, so it is settled here rather
    // than below the deadzone: a page restored mid-scroll needs the header
    // pinned immediately, not after the customer has moved 6px.
    if (mode === 'scroll-down') {
      const pinPoint = this.#offsetAbove() + this.offsetHeight;
      const pinned = position > pinPoint;

      if (pinned !== this.#pinned) {
        this.#pinned = pinned;
        this.toggleAttribute('data-pinned', pinned);

        // A page restored mid-scroll *adopts* the pinned state; it does not
        // enter it. The drop-in keyframes have nothing to come from there — the
        // header was never on screen to leave — so they read as the bar
        // dropping in from the top of the window a beat after the page arrives,
        // on every reload.
        //
        // Cleared as soon as the header unpins, which is the only way back to
        // the animated path: scroll up past the header's place in the flow and
        // the next pin is a real one, with a real starting position.
        this.toggleAttribute('data-instant', pinned && priming);
      }

      // Nothing in this mode hides, and an attribute left behind by a mode
      // change in the editor would strand the header off-screen.
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

    // Priming is not movement. `#prime()` has already adopted the restored
    // scroll offset as the baseline, so `delta` is 0 here — but returning
    // explicitly says why, rather than leaving it to the deadzone below and
    // hoping nobody widens it later.
    if (priming) return;

    // A deadzone stops the header flickering during momentum scrolling, which
    // is the condition Lenis produces most of. It is checked before the mode
    // switch so a mode that ignores direction does not pay for it.
    if (Math.abs(delta) < 6) return;
    this.#lastScroll = position;

    // Only `scroll-up` is left: it is the one mode that reads direction.
    if (mode === 'scroll-up') {
      // Hidden going down, back going up. The second threshold keeps the
      // header still through the first screen, where a customer flicking
      // past the hero is not asking for anything to move.
      this.toggleAttribute('data-hidden', delta > 0 && position > threshold * 2);
    }
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
  /**
   * `data-loaded` is watched because this element writes it and something else
   * removes it.
   *
   * `morph()` reconciles attributes in both directions: anything on the live
   * node that the incoming markup does not carry is removed. Freshly rendered
   * Liquid never carries `data-loaded` — it is a runtime flag, not markup — so
   * every morph strips it from images that are already on screen, and
   * `responsive-image:defined:not([data-loaded]) img[loading='lazy']` fades them
   * to zero.
   *
   * Usually a new `src` follows and the `load` listener puts the flag back. It
   * does not when the src is unchanged, which is the common case in predictive
   * search: type "dre", then "drea", and the same products come back with the
   * same image URLs. No `load` event fires, nothing re-marks the element, and
   * the images stay invisible for the rest of the session.
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
      // A broken image should not leave an empty box faded to zero.
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

    // Only when the pixels are genuinely there. An image still in flight has to
    // stay faded out, or the reveal becomes a pop-in of a half-painted frame.
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
  // Both tags: `<mobile-nav>` is the current drawer navigation, and
  // `<mobile-navigation>` is the previous one, still present in themes that
  // have not taken the new header yet.
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




