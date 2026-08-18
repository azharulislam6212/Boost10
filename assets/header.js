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
import { prefersReducedMotion } from '@theme/utilities';

/** Pointer must rest this long before a panel opens. */
const HOVER_IN_DELAY = 70;

/** Grace period after the pointer leaves, so a diagonal path does not dismiss. */
const HOVER_OUT_DELAY = 180;

/** Ceiling for waiting on `transitionend`, in case the panel never transitions. */
const CLOSE_FALLBACK = 500;

/* ==========================================================================
   Shared disclosure mechanics
   ========================================================================== */

/**
 * The animated part of a `<details>`.
 *
 * @param {HTMLDetailsElement} details
 * @returns {HTMLElement|null}
 */
function panelOf(details) {
  return details.querySelector(':scope > [data-nav-panel], :scope > [data-mobile-panel]');
}

/**
 * Open a `<details>` with a transition.
 *
 * `open` has to be set first — the panel is `display: none` until it is, and a
 * transition on a display-none element never starts. `data-open` is then set on
 * the next frame, which is the frame the browser has already laid the panel out
 * in, so the transition has a from-state to run from.
 *
 * @param {HTMLDetailsElement} details
 */
/**
 * Give a measured panel a pixel height to animate to, and take it away again.
 *
 * A `<details>` panel has no height until it is open and no *known* height once
 * it is — `auto` cannot be transitioned. So the height is written in pixels for
 * the duration of the transition and released afterwards, which is what lets a
 * submenu opening inside an already-open panel still grow it.
 *
 * @param {HTMLElement|null} panel
 * @param {'open'|'close'} direction
 */
function measurePanel(panel, direction) {
  if (!panel || !panel.hasAttribute('data-mobile-panel')) return;

  if (direction === 'close') {
    // From its current height, not from `auto`, or there is nothing to animate
    // away from.
    panel.style.blockSize = `${panel.scrollHeight}px`;
    void panel.offsetHeight;
    panel.style.blockSize = '0px';
    return;
  }

  panel.style.blockSize = '0px';
  void panel.offsetHeight;
  panel.style.blockSize = `${panel.scrollHeight}px`;

  panel.addEventListener(
    'transitionend',
    (event) => {
      if (event.propertyName !== 'block-size' && event.propertyName !== 'height') return;
      panel.style.blockSize = 'auto';
    },
    { once: true }
  );
}

/**
 * Nudge anything inside a panel that could not measure itself while hidden.
 *
 * A carousel built inside a closed `<details>` sees a zero-width track and lays
 * out as a single slide. It recovers the first time it gains width, but a panel
 * revealed by an attribute change is not a resize it can observe. One `resize`
 * on the window tells every one of them to look again.
 *
 * @param {HTMLElement} root
 */
function remeasureCarousels(root) {
  if (!root.querySelector('swiper-carousel')) return;
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function openDisclosure(details) {
  if (details.dataset.state === 'open') return;

  clearTimeout(Number(details.dataset.closeTimer));
  details.dataset.state = 'open';
  details.open = true;

  const summary = details.querySelector('[data-nav-summary], summary');
  summary?.setAttribute('aria-expanded', 'true');

  // Two frames, not one. Setting `open` makes the panel renderable, but the
  // browser has not laid it out until the frame after that — and a transition
  // whose start and end values are computed in the same layout pass simply jumps
  // to the end. One frame was enough for the transform panels and not enough for
  // the accordion, which is measured, so it opened instantly.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
    // A close may have been requested inside those frames.
    if (details.dataset.state !== 'open') return;
    details.setAttribute('data-open', '');
    measurePanel(panelOf(details), 'open');

    // The panel clips its own contents so the inner element can slide out from
    // behind the header. That clip also cuts off anything a *child* disclosure
    // opens sideways, which is why submenus were invisible: they were rendering
    // correctly, outside a `hidden` overflow.
    //
    // The clip is only needed while the reveal is running, so it is released the
    // moment the transition finishes. Releasing it earlier would show the panel
    // contents sitting above the header before they had slid down.
    settle(details);
    });
  });
}

/**
 * Release the panel's clip once its reveal has finished.
 *
 * @param {HTMLDetailsElement} details
 */
function settle(details) {
  if (prefersReducedMotion()) {
    details.setAttribute('data-settled', '');
    return;
  }

  const panel = panelOf(details);
  const inner = panel?.querySelector(':scope > .nav__panel-inner, :scope > .drawer-nav__panel-inner');

  const done = () => {
    clearTimeout(Number(details.dataset.settleTimer));
    if (details.dataset.state !== 'open') return;
    details.setAttribute('data-settled', '');
    remeasureCarousels(details);
  };

  inner?.addEventListener('transitionend', done, { once: true });
  details.dataset.settleTimer = String(window.setTimeout(done, CLOSE_FALLBACK));
}

/**
 * Close a `<details>`, waiting for the transition before removing `open`.
 *
 * Removing `open` immediately puts the panel back to `display: none` on the
 * same frame, and the closing animation is never seen. The timeout is the
 * safety net for the cases where `transitionend` will not fire: reduced motion,
 * a panel with no transition, a tab that was backgrounded mid-close.
 *
 * @param {HTMLDetailsElement} details
 */
function closeDisclosure(details) {
  if (!details.open || details.dataset.state === 'closed') return;

  details.dataset.state = 'closed';
  clearTimeout(Number(details.dataset.settleTimer));

  // The clip goes back on before the panel starts moving, so a submenu that was
  // hanging outside the panel is cut off rather than left floating over the page
  // while its parent slides away.
  details.removeAttribute('data-settled');
  details.removeAttribute('data-open');
  measurePanel(panelOf(details), 'close');

  const summary = details.querySelector('[data-nav-summary], summary');
  summary?.setAttribute('aria-expanded', 'false');

  const finish = () => {
    clearTimeout(Number(details.dataset.closeTimer));
    if (details.dataset.state !== 'closed') return;
    details.open = false;
    delete details.dataset.state;
  };

  if (prefersReducedMotion()) {
    finish();
    return;
  }

  const panel = panelOf(details);
  panel?.addEventListener(
    'transitionend',
    (event) => {
      if (event.target !== event.currentTarget && !panel.contains(/** @type {Node} */ (event.target))) return;
      finish();
    },
    { once: true }
  );

  details.dataset.closeTimer = String(window.setTimeout(finish, CLOSE_FALLBACK));
}

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

  setup() {
    this.#relocatePanels();

    // `<nav-menu>` sits in the header row and the panel bay is emitted after it,
    // so during a streaming parse this element can upgrade before the panels
    // exist — and every mega menu silently falls back to its plain dropdown.
    // Retrying once the document is parsed costs nothing and is the difference
    // between the panels appearing and not.
    if (document.readyState === 'loading') {
      this.on(document, 'DOMContentLoaded', () => this.#relocatePanels());
    }

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
      const existing = details ? panelOf(/** @type {HTMLDetailsElement} */ (details)) : null;
      if (!existing) continue;

      existing.replaceWith(panel);
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
      /** @type {HTMLElement|null} */ (summary)?.focus();
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
    stops[(current + step + stops.length) % stops.length]?.focus();
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

export default { NavMenu, NavDisclosure, MobileNav, openDisclosure, closeDisclosure };

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
      /** @type {HTMLElement} */ (this.refs.trigger).focus();
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
    this.refs.menu.removeAttribute('hidden');
    this.refs.trigger.setAttribute('aria-expanded', 'true');

    // Focus goes to the search field only when it is actually visible. At
    // desktop widths it is display:none, and focusing a hidden field puts the
    // caret nowhere and swallows the next keystroke.
    const filter = /** @type {HTMLElement|undefined} */ (this.refs.filter);
    if (filter && getComputedStyle(filter).display !== 'none') {
      filter.focus();
      return;
    }

    /** @type {HTMLElement|null} */ (this.refs.menu.querySelector('[data-option]'))?.focus();
  }

  close() {
    if (!this.open) return;
    this.refs.menu.setAttribute('hidden', '');
    this.refs.trigger.setAttribute('aria-expanded', 'false');
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
