/**
 * header.js — Boost10
 *
 * Two elements:
 *
 *   <nav-menu>       the desktop navigation
 *   <nav-disclosure> a single dropdown outside the navigation (the account menu)
 *   <mobile-nav>     the drawer navigation, accordion or slide
 *
 * Everything that opens here is a `<details>`. The browser already owns the
 * open/closed state, the Enter and Space handling and the "expands something"
 * announcement, and it does all three before this file has downloaded. What is
 * added on top is animation, hover intent, and the rule that only one panel is
 * open at a time.
 *
 * @module @theme/header
 */
import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import {
  closeDisclosure,
  openDisclosure,
  panelOf,
  prefersReducedMotion
} from '@theme/utilities';

/** Pointer must rest this long before a panel opens. */
const HOVER_IN_DELAY = 70;

/** Grace period after the pointer leaves, so a diagonal path does not dismiss. */
const HOVER_OUT_DELAY = 180;

/* ==========================================================================
   <nav-menu>
   ========================================================================== */

/**
 * The desktop navigation.
 *
 * ## Panel relocation
 *
 * `{% content_for 'blocks' %}` renders every mega menu block in one place and
 * in block order, so a panel cannot be emitted inside the `<li>` it belongs to.
 * Each panel is emitted into a hidden bay carrying `data-menu-item`, and moved
 * here into the `<details>` with the same value.
 *
 * Moving rather than cloning matters: the theme editor's block highlighting
 * follows the element carrying `shopify_attributes`, and a clone leaves the
 * highlighted copy sitting invisible in the bay.
 *
 * A panel naming an item that no longer exists stays in the bay, hidden, which
 * is the visible-but-harmless failure a merchant can diagnose. A menu item with
 * no panel keeps the dropdown Liquid already built from its own child links.
 */
export class NavMenu extends BaseComponent {
  /** @type {number|null} */
  #hoverTimer = null;

  /** @type {MutationObserver|null} */
  #bayObserver = null;

  /** @type {WeakSet<HTMLDetailsElement>} */
  #bound = new WeakSet();

  setup() {
    this.#relocatePanels();

    // The bay is emitted after this element, so during a streaming parse the
    // panels may not exist yet — and a mega menu that misses relocation falls
    // back to its plain dropdown, which for a menu item with no child links is
    // an empty box. That is the empty Science panel.
    //
    // One retry on `DOMContentLoaded` was not enough: the theme editor replaces
    // the bay's contents without reloading, and a merchant adding a block gets
    // no second parse. So the bay is watched until it is empty.
    if (document.readyState === 'loading') {
      this.on(document, 'DOMContentLoaded', () => this.#relocatePanels());
    }

    this.#watchBay();

    this.delegate('click', '[data-nav-summary]', (event, summary) => {
      const details = /** @type {HTMLDetailsElement|null} */ (summary.closest('[data-nav-details]'));
      if (!details) return;

      // The default toggle is prevented so the close animation can run. Without
      // this the browser flips `open` off on the same frame and the panel
      // disappears rather than sliding away.
      event.preventDefault();

      // On a hover-driven menu the panel is already open by the time the
      // pointer reaches the label, so a plain toggle closes it — which reads as
      // the menu dismissing itself the moment you click it. A click there means
      // "keep this", not "undo that".
      const hoverOpened =
        details.dataset.state === 'open' &&
        details.dataset.kind !== 'sub' &&
        this.dataset.trigger !== 'click' &&
        !window.matchMedia('(hover: none)').matches;

      if (hoverOpened) return;

      this.toggle(details);
    });

    // Bound to each `<details>`, not delegated from here.
    //
    // `pointerleave` does not bubble, so it was being caught in the capture
    // phase — which meant it fired for *every descendant* the pointer left.
    // Moving the mouse from one card to the next inside an open mega menu left a
    // child, resolved to the ancestor `<details>`, and scheduled a close. The
    // panel shut while the customer was still using it.
    //
    // On the element itself these two events fire once on entry and once on
    // exit, which is the whole contract they were chosen for.
    for (const details of this.items) {
      this.on(details, 'pointerenter', (event) => this.#onPointer(event, details, true));
      this.on(details, 'pointerleave', (event) => this.#onPointer(event, details, false));
    }

    this.on(this, 'keydown', (event) => this.#onKeydown(event));

    this.on(this, 'focusout', (event) => {
      const next = /** @type {Node|null} */ (event.relatedTarget);

      // `relatedTarget` is null whenever focus goes nowhere — which is what
      // happens on every click on a non-focusable element. Clicking a heading or
      // an image inside an open panel was therefore read as "focus left the
      // menu" and closed it mid-use.
      //
      // Nothing received focus, so nothing has left. Only a move to a real
      // element outside this menu counts.
      if (!next) return;
      if (this.contains(next)) return;

      this.closeAll();
    });

    // A drawer opening over the header must not leave a panel hanging behind it.
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

  /* --------------------------------------------------------- public API -- */

  /** @returns {HTMLDetailsElement[]} */
  get items() {
    return /** @type {HTMLDetailsElement[]} */ ([...this.querySelectorAll('[data-nav-details]')]);
  }

  /** @param {HTMLDetailsElement} details */
  open(details) {
    // Siblings only. Closing every open disclosure would close the parent of a
    // submenu the moment the submenu opened.
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

  /* ---------------------------------------------------------- internals -- */

  /**
   * Bind hover intent to one disclosure, once.
   *
   * `setup()` cannot be the only place this happens: a panel that arrives late —
   * from the bay observer, or from a menu item promoted below — produces a
   * `<details>` that did not exist when the loop ran. The set is what stops a
   * second pass double-binding the ones that were there from the start.
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
   * Liquid builds the `<details>` only when it can match the block's Menu item to
   * a link, and that comparison has been the most fragile thing in this header —
   * a trailing space or one capital letter and the panel had nowhere to land.
   * Rather than make the match stricter or the merchant more careful, the
   * component builds what is missing.
   *
   * The item's own destination is not thrown away: it becomes a "View all" link
   * at the top of the panel, because a `<summary>` cannot navigate and a customer
   * who clicks a category still expects the category.
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

    // No chevron is added.
    //
    // It used to clone one from a sibling so a promoted item looked like the
    // ones Liquid built. But the link did not have a chevron a moment ago, and
    // adding one makes the item about 16px wider — the navigation re-centres,
    // and the whole menu slides sideways. That happens on every page load, right
    // after the module arrives, which is exactly the jump you see on reload.
    //
    // A menu item that opens a panel and has no chevron is a small loss. A menu
    // that moves on every load is not.
    //
    // The real fix is upstream: match the block's Menu item to the navigation
    // and Liquid builds the disclosure — chevron included — before first paint.
    // This path only runs when that match failed.

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
   * Disconnects itself once the bay is empty — every panel has been placed and
   * there is nothing left to observe.
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

      // Matched case-insensitively on the trimmed title. A merchant who typed
      // "shop by category" against a menu item called "Shop By Category" has
      // made a typo nobody can see, and the panel vanishing is not a useful way
      // to report it.
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

      // No disclosure for this name. Before giving up, look for a plain link
      // with the same label — the usual reason there is no `<details>` is that
      // Liquid's match was stricter than this one, not that the item is gone.
      const link = [...this.querySelectorAll('.nav > .nav__item > .nav__link')].find(
        (node) => node.textContent?.trim().toLowerCase() === name.toLowerCase()
      );

      if (link instanceof HTMLAnchorElement) {
        const promoted = this.#promote(link, /** @type {HTMLElement} */ (panel), name);
        if (promoted) this.#bindHover(promoted);
        continue;
      }

      // Genuinely nothing to attach to. The panel stays in the bay, hidden, and
      // says so by name — that line is the only way a merchant discovers a panel
      // pointing at a menu item that no longer exists.
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

    // Submenus always open on hover: the customer is already inside a panel
    // they opened deliberately, and asking for a second click to see one more
    // level is a click for nothing. Only top-level items respect the setting.
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
      // In the sticky header too - see `MarketPicker.show()`.
      /** @type {HTMLElement|null} */ (summary)?.focus({ preventScroll: true });
      return;
    }

    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    // Arrow keys move along the top-level strip. Inside an open panel they
    // belong to whatever the panel contains — a tab strip, a text field — so
    // they are left alone there.
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
    // Arrow-key movement between top-level items, all of them in the sticky
    // header. Scrolling to a document position here would be the same jump.
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

/**
 * A dropdown that lives outside the navigation — currently the account menu.
 *
 * Same class, different tag. It inherits the animation, the hover intent and
 * the Escape handling rather than growing a second, subtly different copy of
 * all three next to the cart button.
 */
export class NavDisclosure extends NavMenu {}

defineComponent('nav-disclosure', NavDisclosure);

/* ==========================================================================
   <mobile-nav>
   ========================================================================== */

/**
 * The drawer navigation, in one of two shapes.
 *
 * **accordion** nests `<details>` in place, using the same open and close
 * helpers as the desktop menu.
 *
 * **slide** moves through panels one level per screen. Only the active panel is
 * reachable — the others are `inert`, so Tab does not wander into a menu the
 * customer cannot see, and focus moves into each panel as it arrives or the
 * drawer becomes unusable by keyboard the moment a submenu opens.
 *
 * Attributes:
 *   data-mode  accordion | slide
 */
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

  /* --------------------------------------------------------- public API -- */

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

  /* ---------------------------------------------------------- internals -- */

  /**
   * Copy each mega menu panel that opted into mobile into its placeholder.
   *
   * A copy, not a move: the desktop panel is the same element and is still
   * needed at desktop widths. Ids inside the copy are suffixed, because a tab
   * strip carries `aria-controls` and two identical ids in one document make
   * both of them ambiguous.
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

      // Siblings close, ancestors do not. An accordion that keeps every branch
      // open turns a four-item menu into a sixty-item scroll.
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

    // A cloned mega panel, a late-loading image or a font swap all change the
    // active screen's height after the first measurement.
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
   * Every screen is absolutely positioned — that is what lets them cross over
   * each other — which takes all of them out of the flow and leaves the
   * container with no height at all. Measuring the active one and animating to
   * it is what makes the drawer grow and shrink as the customer moves through
   * the levels instead of jumping.
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

    // Focus moves to the Back button rather than to the first link. The
    // customer who arrived by keyboard needs the way out to be one Shift+Tab
    // away, not at the end of a list of twenty categories.
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

/**
 * The country and language selector.
 *
 * ## Why this is not the theme's `<localization-form>`
 *
 * That component expects the markup `snippets/localization-selectors.liquid`
 * emits, and the header needs a different one: a plain list of options, a search
 * field that is present but hidden at desktop widths, and two instances on one
 * page — the header and the drawer — whose panels must not answer to each
 * other's trigger.
 *
 * Bending the old component to all three was producing a panel that opened with
 * nothing in it but a stray input, which is what the screenshots showed.
 *
 * ## It is still Shopify's form
 *
 * Every option is a `<button type="submit">` inside `{% form 'localization' %}`.
 * That is the only supported way to change market or locale, it is what works
 * with JavaScript off, and this component only decides what is visible.
 */
export class MarketPicker extends BaseComponent {
  /** @type {number|undefined} */
  #closeTimer;

  /** @type {number|undefined} */
  #settleTimer;

  // `menu`, not `panel`.
  //
  // The markup was renamed so it would stop colliding with `DrawerComponent`'s
  // own `panel` ref, but this list was not. `refs.panel` was therefore missing,
  // `#validateRefs` failed, and `setup()` never ran — which is why clicking the
  // country or language control did nothing at all, with no error to show for
  // it.
  static requiredRefs = ['trigger', 'menu'];

  setup() {
    this.on(this.refs.trigger, 'click', () => this.toggle());

    // Filtering runs against the option's own label, so it works whatever the
    // merchant's markets are called and in whatever script they are written.
    if (this.refs.filter) {
      this.on(this.refs.filter, 'input', () => this.#filter());
    }

    this.on(this, 'keydown', (event) => {
      if (event.key !== 'Escape' || !this.open) return;
      event.stopPropagation();
      this.close();
      // Same reason as `show()`: the trigger sits in the sticky header, and
      // scrolling to its document position would throw the page to the top.
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

    // `hidden` first, `data-open` on the next frame — the same two-step every
    // other disclosure in the header uses. A panel that is `display: none` has
    // no from-state, so setting both together animates nothing at all.
    this.refs.menu.removeAttribute('hidden');
    this.refs.trigger.setAttribute('aria-expanded', 'true');

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.refs.menu.hasAttribute('hidden')) return;
        this.refs.menu.setAttribute('data-open', '');

        // Scrolling is switched on only once the panel has finished opening.
        //
        // A panel that is scrollable while it moves paints its scrollbar for the
        // whole transition, and again on the way out while the box is still
        // overflowing as it collapses. On a control nobody has used yet that
        // reads as a flicker. It matters more here than elsewhere because the
        // list is filled as the panel opens, so the height is genuinely still
        // changing during those frames.
        const settle = () => this.refs.menu.setAttribute('data-settled', '');

        if (prefersReducedMotion()) {
          settle();
          return;
        }

        this.refs.menu.addEventListener('transitionend', settle, { once: true });
        this.#settleTimer = window.setTimeout(settle, 500);
      });
    });

    // Focus goes to the search field only when it is actually visible. At
    // desktop widths it is display:none, and focusing a hidden field puts the
    // caret nowhere and swallows the next keystroke.
    const filter = /** @type {HTMLElement|undefined} */ (this.refs.filter);
    // `preventScroll`, and this is the whole of the country-picker jump.
    //
    // `focus()` scrolls the focused element into view. The header is pinned by
    // `position: sticky`, so it is at the top of the *viewport* while its place
    // in the *document* is at the top of the page - and it is the document
    // position the browser scrolls to. Opening the picker therefore threw the
    // page back to the top, every time, and only ever once the header had stuck.
    //
    // The panel is already on screen when it opens, so there was nothing to
    // scroll to in the first place.
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

    // Scrolling off first, so the closing animation has no scrollbar either.
    clearTimeout(this.#settleTimer);
    this.refs.menu.removeAttribute('data-settled');
    this.refs.menu.removeAttribute('data-open');
    this.refs.trigger.setAttribute('aria-expanded', 'false');

    // `hidden` goes back on only once the panel has finished leaving, or the
    // closing half of the animation is never seen.
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
      // The row is hidden, not the button, so an empty result collapses the list
      // rather than leaving a column of blank space behind.
      option.closest('li')?.toggleAttribute('hidden', !match);
      if (match) shown += 1;
    }

    this.refs.empty?.toggleAttribute('hidden', shown > 0);
  }
}

defineComponent('market-picker', MarketPicker);
