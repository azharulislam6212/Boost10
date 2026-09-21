/**
 * Four elements:
 *
 * @module @theme/header
 */
import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import {
  closeDisclosure,
  isRTL,
  matchesQuery,
  openDisclosure,
  panelOf,
  prefersReducedMotion,
  rafThrottle
} from '@theme/utilities';

/** Pointer must rest this long before a panel opens. */
const HOVER_IN_DELAY = 70;

/** Grace period after the pointer leaves, so a diagonal path does not dismiss. */
const HOVER_OUT_DELAY = 180;

/* ==========================================================================
   <nav-menu>
   ========================================================================== */

/** The desktop navigation. */
export class NavMenu extends BaseComponent {
  /** @type {number|null} */
  #hoverTimer = null;

  /** @type {MutationObserver|null} */
  #bayObserver = null;

  /** @type {WeakSet<HTMLDetailsElement>} */
  #bound = new WeakSet();

  setup() {
    this.#relocatePanels();

    if (document.readyState === 'loading') {
      this.on(document, 'DOMContentLoaded', () => this.#relocatePanels());
    }

    this.#watchBay();

    this.delegate('click', '[data-nav-summary]', (event, summary) => {
      const details = /** @type {HTMLDetailsElement|null} */ (summary.closest('[data-nav-details]'));
      if (!details) return;

      event.preventDefault();

      const hoverOpened =
        details.dataset.state === 'open' &&
        details.dataset.kind !== 'sub' &&
        this.dataset.trigger !== 'click' &&
        !window.matchMedia('(hover: none)').matches;

      if (hoverOpened) return;

      this.toggle(details);
    });

    for (const details of this.items) {
      this.on(details, 'pointerenter', (event) => this.#onPointer(event, details, true));
      this.on(details, 'pointerleave', (event) => this.#onPointer(event, details, false));
    }

    this.on(this, 'keydown', (event) => this.#onKeydown(event));

    this.on(this, 'focusout', (event) => {
      const next = /** @type {Node|null} */ (event.relatedTarget);

      if (!next) return;
      if (this.contains(next)) return;

      this.closeAll();
    });

    this.on(document, EVENTS.OVERLAY_OPEN, () => this.closeAll());

    this.on(document, 'click', (event) => {
      if (this.contains(/** @type {Node} */ (event.target))) return;
      this.closeAll();
    });
  }

  teardown() {
    this.#clearHover();
    this.#bayObserver?.disconnect();
    this.#bayObserver = null;
  }

  /* --------------------------------------------------------- public API -- ---- */

  /** @returns {HTMLDetailsElement[]} */
  get items() {
    return /** @type {HTMLDetailsElement[]} */ ([...this.querySelectorAll('[data-nav-details]')]);
  }

  /** @param {HTMLDetailsElement} details */
  open(details) {
    for (const other of this.items) {
      if (other === details || other.contains(details) || details.contains(other)) continue;
      closeDisclosure(other);
    }

    openDisclosure(details);
  }

  /** @param {HTMLDetailsElement} details */
  close(details) {
    for (const nested of details.querySelectorAll('[data-nav-details]')) {
      closeDisclosure(/** @type {HTMLDetailsElement} */ (nested));
    }
    closeDisclosure(details);
  }

  /** @param {HTMLDetailsElement} details */
  toggle(details) {
    if (details.dataset.state === 'open') {
      this.close(details);
    } else {
      this.open(details);
    }
  }

  closeAll() {
    this.#clearHover();
    for (const details of this.items) closeDisclosure(details);
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * Bind hover intent to one disclosure, once.
   *
   * @param {HTMLDetailsElement} details
   * @private
   */
  #bindHover(details) {
    if (this.#bound.has(details)) return;
    this.#bound.add(details);

    this.on(details, 'pointerenter', (event) => this.#onPointer(event, details, true));
    this.on(details, 'pointerleave', (event) => this.#onPointer(event, details, false));
  }

  /**
   * Turn a plain navigation link into a disclosure so a panel has somewhere to go.
   *
   * @param {HTMLAnchorElement} link
   * @param {HTMLElement} panel
   * @param {string} name
   * @returns {HTMLDetailsElement|null}
   * @private
   */
  #promote(link, panel, name) {
    const item = link.closest('.nav__item');
    if (!item) return null;

    const details = document.createElement('details');
    details.className = 'nav__details';
    details.setAttribute('data-nav-details', '');
    details.dataset.kind = 'mega';
    details.dataset.menuItem = name;

    const summary = document.createElement('summary');
    summary.className = 'nav__link';
    summary.setAttribute('data-nav-summary', '');
    summary.setAttribute('aria-expanded', 'false');
    summary.innerHTML = link.innerHTML;
    if (link.dataset.current) summary.dataset.current = link.dataset.current;

    const href = link.getAttribute('href');
    const inner = panel.querySelector('.nav__panel-inner');

    if (href && href !== '#' && inner && !inner.querySelector('.nav__panel-jump')) {
      const jump = document.createElement('a');
      jump.className = 'nav__panel-jump';
      jump.href = href;
      jump.textContent = link.textContent?.trim() || name;
      inner.prepend(jump);
    }

    details.append(summary, panel);
    link.replaceWith(details);
    item.classList.add('nav__item--parent');

    return details;
  }

  /**
   * Watch the bay so a panel that arrives late still finds its menu item.
   *
   * @private
   */
  #watchBay() {
    const bay = this.closest('sticky-header')?.querySelector('[data-nav-bay]');
    if (!bay) return;

    this.#bayObserver = new MutationObserver(() => {
      this.#relocatePanels();
      if (!bay.querySelector('[data-mega-panel]')) {
        this.#bayObserver?.disconnect();
        this.#bayObserver = null;
      }
    });

    this.#bayObserver.observe(bay, { childList: true, subtree: true });
  }

  /** @private */
  #relocatePanels() {
    const bay = this.closest('sticky-header')?.querySelector('[data-nav-bay]');
    if (!bay) return;

    for (const panel of [...bay.querySelectorAll('[data-mega-panel]')]) {
      const name = /** @type {HTMLElement} */ (panel).dataset.menuItem?.trim();
      if (!name) continue;

      const details = [...this.querySelectorAll('[data-nav-details][data-menu-item]')].find(
        (node) =>
          /** @type {HTMLElement} */ (node).dataset.menuItem?.trim().toLowerCase() ===
          name.toLowerCase()
      );
      if (details) {
        const existing = panelOf(/** @type {HTMLDetailsElement} */ (details));
        if (!existing) continue;

        existing.replaceWith(panel);
        this.#bindHover(/** @type {HTMLDetailsElement} */ (details));
        continue;
      }

      const link = [...this.querySelectorAll('.nav > .nav__item > .nav__link')].find(
        (node) => node.textContent?.trim().toLowerCase() === name.toLowerCase()
      );

      if (link instanceof HTMLAnchorElement) {
        const promoted = this.#promote(link, /** @type {HTMLElement} */ (panel), name);
        if (promoted) this.#bindHover(promoted);
        continue;
      }

      console.warn(
        `[Boost10] Mega menu panel "${name}" has no matching header menu item.`
      );
    }
  }

  /**
   * Hover intent.
   *
   * @param {Event} event
   * @param {HTMLDetailsElement} details
   * @param {boolean} entering
   * @private
   */
  #onPointer(event, details, entering) {
    if (window.matchMedia('(hover: none)').matches) return;

    const isSub = details.dataset.kind === 'sub';
    if (!isSub && this.dataset.trigger === 'click') return;

    this.#clearHover();

    this.#hoverTimer = window.setTimeout(
      () => (entering ? this.open(details) : this.close(details)),
      entering ? HOVER_IN_DELAY : HOVER_OUT_DELAY
    );
  }

  /**
   * @param {KeyboardEvent} event
   * @private
   */
  #onKeydown(event) {
    if (event.key === 'Escape') {
      const open = this.querySelector('[data-nav-details][data-open]');
      if (!open) return;

      event.stopPropagation();
      const summary = open.querySelector('[data-nav-summary]');
      this.close(/** @type {HTMLDetailsElement} */ (open));
      /** @type {HTMLElement|null} */ (summary)?.focus({ preventScroll: true });
      return;
    }

    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    const summary = /** @type {Element|null} */ (event.target)?.closest?.('.nav > .nav__item [data-nav-summary]');
    const link = /** @type {Element|null} */ (event.target)?.closest?.('.nav > .nav__item > .nav__link');
    if (!summary && !link) return;

    const stops = /** @type {HTMLElement[]} */ ([
      ...this.querySelectorAll('.nav > .nav__item > .nav__link, .nav > .nav__item > .nav__details > .nav__link')
    ]);
    const current = stops.indexOf(/** @type {HTMLElement} */ (summary || link));
    if (current === -1) return;

    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    stops[(current + step + stops.length) % stops.length]?.focus({ preventScroll: true });
  }

  /** @private */
  #clearHover() {
    if (this.#hoverTimer === null) return;
    window.clearTimeout(this.#hoverTimer);
    this.#hoverTimer = null;
  }
}

defineComponent('nav-menu', NavMenu);

/** A dropdown that lives outside the navigation — currently the account menu. */
export class NavDisclosure extends NavMenu {}

defineComponent('nav-disclosure', NavDisclosure);

/* ==========================================================================
   <mobile-nav>
   ========================================================================== */

/** The drawer navigation, in one of two shapes. */
export class MobileNav extends BaseComponent {
  /** @type {string[]} */
  #stack = [];

  /** @type {ResizeObserver|null} */
  #observer = null;

  setup() {
    this.#adoptMegaPanels();

    if (this.dataset.mode === 'slide') {
      this.#setupSlide();
    } else {
      this.#setupAccordion();
    }
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * Return to the root panel. Called when the drawer closes, so it reopens at
   * the top rather than four levels deep.
   */
  reset() {
    if (this.dataset.mode !== 'slide') return;
    this.#stack = [];
    this.#applySlideState();
  }

  teardown() {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * Copy each mega menu panel that opted into mobile into its placeholder.
   *
   * @private
   */
  #adoptMegaPanels() {
    const placeholders = this.querySelectorAll('[data-mobile-mega]');
    if (placeholders.length === 0) return;

    for (const placeholder of placeholders) {
      const name = /** @type {HTMLElement} */ (placeholder).dataset.mobileMega;
      if (!name) continue;

      const source = document.querySelector(
        `[data-mega-panel][data-mobile="true"][data-menu-item="${CSS.escape(name)}"]`
      );
      if (!source) continue;

      const copy = /** @type {HTMLElement} */ (source.cloneNode(true));
      copy.removeAttribute('data-mega-panel');
      copy.removeAttribute('data-nav-panel');
      copy.classList.add('nav__panel--mobile');

      for (const node of copy.querySelectorAll('[id]')) {
        const id = node.getAttribute('id');
        node.setAttribute('id', `${id}-m`);

        for (const attribute of ['aria-controls', 'aria-labelledby']) {
          for (const referrer of copy.querySelectorAll(`[${attribute}="${CSS.escape(id)}"]`)) {
            referrer.setAttribute(attribute, `${id}-m`);
          }
        }
      }

      placeholder.replaceWith(copy);
    }
  }

  /** @private */
  #setupAccordion() {
    this.delegate('click', 'summary', (event, summary) => {
      const details = /** @type {HTMLDetailsElement|null} */ (summary.closest('[data-mobile-details]'));
      if (!details) return;

      event.preventDefault();

      if (details.dataset.state === 'open') {
        closeDisclosure(details);
        return;
      }

      const siblings = details.parentElement?.parentElement?.querySelectorAll(':scope > li > [data-mobile-details]');
      for (const sibling of siblings || []) {
        if (sibling !== details) closeDisclosure(/** @type {HTMLDetailsElement} */ (sibling));
      }

      openDisclosure(details);
    });
  }

  /** @private */
  #setupSlide() {
    this.#stack = [];
    this.#applySlideState();

    this.#observer = new ResizeObserver(() => this.#resize());
    for (const screen of this.querySelectorAll('[data-menu-panel]')) this.#observer.observe(screen);

    this.on(this, 'click', (event) => {
      const target = /** @type {Element|null} */ (event.target);

      const opener = target?.closest?.('[data-menu-open]');
      if (opener instanceof HTMLElement) {
        event.preventDefault();
        this.#stack.push(opener.dataset.menuOpen || '');
        this.#applySlideState();
        return;
      }

      if (target?.closest?.('[data-menu-back]')) {
        event.preventDefault();
        this.#stack.pop();
        this.#applySlideState();
      }
    });
  }

  /**
   * Match the container to the active screen.
   *
   * @private
   */
  #resize() {
    const screen = this.querySelector('[data-menu-panel][data-active]');
    if (!(screen instanceof HTMLElement)) return;
    this.style.blockSize = `${screen.scrollHeight}px`;
  }

  /** @private */
  #applySlideState() {
    const active = this.#stack[this.#stack.length - 1] || null;

    for (const screen of this.querySelectorAll('[data-menu-panel]')) {
      const isActive =
        active === null
          ? screen.hasAttribute('data-menu-root')
          : /** @type {HTMLElement} */ (screen).dataset.menuPanel === active;

      screen.toggleAttribute('data-active', isActive);
      screen.toggleAttribute('inert', !isActive);
    }

    this.dataset.depth = String(this.#stack.length);
    this.#resize();

    if (this.#stack.length === 0) return;

    const screen = this.querySelector('[data-menu-panel][data-active]');
    /** @type {HTMLElement|null} */ (screen?.querySelector('[data-menu-back]'))?.focus({
      preventScroll: true
    });
  }
}

defineComponent('mobile-nav', MobileNav);

export default { NavMenu, NavDisclosure, MobileNav };

/* ==========================================================================
   <market-picker>
   ========================================================================== */

/** The country and language selector. */
export class MarketPicker extends BaseComponent {
  /** @type {number|undefined} */
  #closeTimer;

  /** @type {number|undefined} */
  #settleTimer;

  static requiredRefs = ['trigger', 'menu'];

  setup() {
    this.on(this.refs.trigger, 'click', () => this.toggle());

    if (this.refs.filter) {
      this.on(this.refs.filter, 'input', () => this.#filter());
    }

    this.on(this, 'keydown', (event) => {
      if (event.key !== 'Escape' || !this.open) return;
      event.stopPropagation();
      this.close();
      /** @type {HTMLElement} */ (this.refs.trigger).focus({ preventScroll: true });
    });

    this.on(document, 'click', (event) => {
      if (this.contains(/** @type {Node} */ (event.target))) return;
      this.close();
    });

    this.on(document, EVENTS.OVERLAY_OPEN, () => this.close());
  }

  /** @returns {boolean} */
  get open() {
    return !this.refs.menu.hasAttribute('hidden');
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    clearTimeout(this.#closeTimer);

    this.refs.menu.removeAttribute('hidden');
    this.refs.trigger.setAttribute('aria-expanded', 'true');

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.refs.menu.hasAttribute('hidden')) return;
        this.refs.menu.setAttribute('data-open', '');

        const settle = () => this.refs.menu.setAttribute('data-settled', '');

        if (prefersReducedMotion()) {
          settle();
          return;
        }

        this.refs.menu.addEventListener('transitionend', settle, { once: true });
        this.#settleTimer = window.setTimeout(settle, 500);
      });
    });

    const filter = /** @type {HTMLElement|undefined} */ (this.refs.filter);
    if (filter && getComputedStyle(filter).display !== 'none') {
      filter.focus({ preventScroll: true });
      return;
    }

    /** @type {HTMLElement|null} */ (this.refs.menu.querySelector('[data-option]'))?.focus({
      preventScroll: true,
    });
  }

  close() {
    if (!this.open) return;

    clearTimeout(this.#settleTimer);
    this.refs.menu.removeAttribute('data-settled');
    this.refs.menu.removeAttribute('data-open');
    this.refs.trigger.setAttribute('aria-expanded', 'false');

    const finish = () => this.refs.menu.setAttribute('hidden', '');

    if (prefersReducedMotion()) {
      finish();
      return;
    }

    this.refs.menu.addEventListener('transitionend', finish, { once: true });
    this.#closeTimer = window.setTimeout(finish, 400);
  }

  /** @private */
  #filter() {
    const term = /** @type {HTMLInputElement} */ (this.refs.filter).value.trim().toLowerCase();
    let shown = 0;

    for (const option of this.refs.menu.querySelectorAll('[data-option]')) {
      const label = /** @type {HTMLElement} */ (option).dataset.label?.toLowerCase() || '';
      const match = label.includes(term);
      option.closest('li')?.toggleAttribute('hidden', !match);
      if (match) shown += 1;
    }

    this.refs.empty?.toggleAttribute('hidden', shown > 0);
  }
}

defineComponent('market-picker', MarketPicker);

/* ==========================================================================
   <account-anchor>
   ========================================================================== */

/** Anchors Shopify's account sheet under the account icon. */
export class AccountAnchor extends BaseComponent {
  /** The width at which the component switches from bottom drawer to popover. */
  static POPOVER_QUERY = '(min-width: 751px)';

  /** Distance between the bottom of the icon and the top of the sheet. */
  static GAP = 8;

  /** The sheet never comes closer than this to an edge of the window. */
  static MIN_EDGE = 12;

  /** @type {HTMLElement|null} */
  #account = null;

  /** @type {boolean} */
  #styled = false;

  /** @type {boolean} */
  #open = false;

  setup() {
    this.#account = this.querySelector('shopify-account');
    if (!this.#account) return;

    this.on(this.#account, 'open', () => {
      this.#open = true;
      this.#injectPlacementRule();
      this.place();
    });

    this.on(this.#account, 'close', () => {
      this.#open = false;
    });

    const reposition = rafThrottle(() => {
      if (this.#open) this.place();
    });

    this.on(window, 'resize', reposition);
    this.on(window, 'scroll', reposition, { passive: true });
  }

  teardown() {
    this.#open = false;
    this.#styled = false;
  }

  /** Points the sheet at the icon. Safe to call when nothing is open. */
  place() {
    const account = this.#account;
    if (!account) return;

    const { POPOVER_QUERY, GAP, MIN_EDGE } = AccountAnchor;

    if (!matchesQuery(POPOVER_QUERY)) {
      account.style.removeProperty('--shopify-account-dialog-position-top');
      account.style.removeProperty('--account-sheet-inline-end');
      return;
    }

    const icon = account.getBoundingClientRect();

    const viewport = document.documentElement.clientWidth;

    const top = Math.max(MIN_EDGE, Math.round(icon.bottom + GAP));
    const trailing = isRTL() ? icon.left : viewport - icon.right;

    account.style.setProperty('--shopify-account-dialog-position-top', `${top}px`);
    account.style.setProperty(
      '--account-sheet-inline-end',
      `${Math.max(MIN_EDGE, Math.round(trailing))}px`
    );
  }

  /**
   * Adds the one rule the component does not expose a variable for, once.
   *
   * @private
   */
  #injectPlacementRule() {
    if (this.#styled) return;

    const root = this.#account?.shadowRoot;
    if (!root) return;

    const style = document.createElement('style');

    const nonce = /** @type {HTMLElement|null} */ (
      document.querySelector('style[nonce], script[nonce]')
    )?.nonce;
    if (nonce) style.nonce = nonce;

    style.textContent = `@media ${AccountAnchor.POPOVER_QUERY} {
  dialog[open] {
    inset-inline-end: var(--account-sheet-inline-end, var(--app-page-spacing));
  }
}`;

    root.appendChild(style);
    this.#styled = true;
  }
}

defineComponent('account-anchor', AccountAnchor);
