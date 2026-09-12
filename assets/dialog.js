/**
 * dialog.js — Boost10
 *
 * Every overlay in the theme: modals, drawers, toasts and the quick option
 * drawer. They live in one file because they share one behaviour — taking over
 * the page, trapping focus, and giving both back cleanly — and duplicating that
 * across four files is how overlays start behaving differently from each other.
 *
 *   <modal-dialog>         Centred modal
 *   <drawer-component>     Edge drawer: start, end, top or bottom
 *   <quick-add-modal>  Drawer that fetches product options on demand
 *
 * Built on the native `<dialog>` element rather than a hand-rolled overlay. The
 * browser then owns the hard parts: the top layer (so nothing can z-index above
 * it), background inertness, and Escape handling. Attempting to reproduce those
 * with `div` and `aria-modal` is where most themes' accessibility fails.
 *
 * Two rules that the rest of the theme depends on:
 *
 *   1. Any scrollable region inside an overlay carries `data-lenis-prevent`.
 *      This class adds it automatically to the body ref, because otherwise
 *      Lenis swallows the wheel event and a tall drawer refuses to scroll.
 *   2. Scroll locking is reference counted through `lockScroll()`, so a quick
 *      view opening the cart drawer does not release the page underneath.
 *
 * @module @theme/dialog
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { ShadowComponent } from '@theme/shadow-component';
import { EVENTS, overlayDetail } from '@theme/events';
import {
  trapFocus,
  lockScroll,
  unlockScroll,
  prefersReducedMotion,
  themeString,
  announce,
  announceUrgent,
  uniqueId
} from '@theme/utilities';

/* ==========================================================================
   Shared overlay behaviour
   ========================================================================== */

/**
 * Base class for anything that covers the page. Not registered: it has no tag
 * of its own and is only ever extended.
 *
 * Expected markup:
 *
 *   <drawer-component id="CartDrawer">
 *     <dialog data-ref="dialog">
 *       <div data-ref="panel">
 *         <button data-overlay-close>…</button>
 *         <div data-ref="body">…scrollable content…</div>
 *       </div>
 *     </dialog>
 *   </drawer-component>
 *
 * Triggers live anywhere in the document and carry
 * `data-overlay-open="<overlay id>"`.
 */
export class Overlay extends BaseComponent {
  static requiredRefs = ['dialog'];

  /** Which side the panel animates from. Overridden by subclasses. */
  static defaultPlacement = 'center';

  /** @type {(() => void)|null} */
  #releaseFocus = null;

  /** @type {HTMLElement|null} */
  #trigger = null;

  /** @type {boolean} */
  #open = false;

  /* ------------------------------------------------------------ lifecycle */

  setup() {
    if (!this.id) this.id = uniqueId('overlay');

    // A tall drawer that will not scroll is almost always this attribute
    // missing, so it is applied here rather than left to section authors.
    const body = this.refs.body;
    if (body instanceof HTMLElement && !body.hasAttribute('data-lenis-prevent')) {
      body.setAttribute('data-lenis-prevent', '');
    }

    this.on(document, 'click', this.#onDocumentClick);
    this.on(this.refs.dialog, 'click', this.#onDialogClick);
    this.on(this.refs.dialog, 'cancel', this.#onCancel);
    this.on(this.refs.dialog, 'close', this.#onNativeClose);

    // The element may be re-connected while open, for instance after a morph.
    this.#open = this.refs.dialog.open;
  }

  teardown() {
    if (this.#open) this.#release();
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {boolean}
   */
  get isOpen() {
    return this.#open;
  }

  /**
   * @returns {string} `drawer`, `modal` or `toast`. Reported in the event detail.
   */
  get overlayType() {
    return this.dataset.overlayType || 'drawer';
  }

  /**
   * How long the entrance runs, in milliseconds.
   *
   * A getter and not a constant so a subclass can make it the merchant's —
   * `<modal-dialog>` reads `data-animation-duration`. Every other overlay keeps
   * the 320/240 pair this file has always used, because a drawer's length is
   * part of the drawer feeling attached to the edge it came from rather than
   * something a store would want to tune.
   *
   * @returns {number}
   */
  get enterDuration() {
    return 320;
  }

  /**
   * @returns {number} How long the exit runs, in milliseconds.
   */
  get exitDuration() {
    return 240;
  }

  /**
   * Open the overlay.
   *
   * @param {HTMLElement} [trigger] The control that opened it. Focus returns here on close.
   * @returns {Promise<void>} Resolves once the entrance animation has finished.
   */
  async open(trigger) {
    if (this.#open) return;

    this.#trigger = trigger instanceof HTMLElement ? trigger : null;
    this.#trigger?.setAttribute('aria-expanded', 'true');

    this.#open = true;
    this.setAttribute('data-state', 'opening');

    // showModal puts the dialog in the top layer and makes everything behind it
    // inert. Nothing else gives that for free.
    if (!this.refs.dialog.open) this.refs.dialog.showModal();

    lockScroll();

    // Started here, awaited below, and the difference matters for any overlay
    // whose `beforeOpen()` fetches something.
    //
    // The entrance used to run *after* that fetch, so a quick add opened in two
    // beats: the panel appeared instantly at its loading size — no animation at
    // all, because nothing had started one — the customer watched a spinner in
    // it, and only once the product had landed did the panel play an entrance
    // it had already finished making. That is the jump.
    //
    // Begun with the dialog instead, the panel animates in while the request is
    // in flight and is settled by the time the content arrives. For every other
    // overlay `beforeOpen()` resolves on the same microtask, so this is the
    // order it always had.
    const entrance = this.animateIn();

    await this.beforeOpen();

    this.setAttribute('data-state', 'open');

    this.#releaseFocus = trapFocus(this.refs.panel || this.refs.dialog, {
      initialFocus: this.#initialFocusTarget()
    });

    this.dispatch(
      EVENTS.OVERLAY_OPEN,
      overlayDetail(this.id, { triggerId: this.#trigger?.id || null, type: this.overlayType })
    );

    await entrance;
    this.afterOpen();
  }

  /**
   * Close the overlay and return focus to whatever opened it.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.#open) return;

    this.setAttribute('data-state', 'closing');
    await this.animateOut();

    this.#release();

    // Closing the native dialog fires `close`, which is why #onNativeClose
    // guards against running the teardown twice.
    if (this.refs.dialog.open) this.refs.dialog.close();

    this.dispatch(
      EVENTS.OVERLAY_CLOSE,
      overlayDetail(this.id, { triggerId: this.#trigger?.id || null, type: this.overlayType })
    );

    this.afterClose();
  }

  /**
   * @param {HTMLElement} [trigger]
   * @returns {Promise<void>}
   */
  toggle(trigger) {
    return this.#open ? this.close() : this.open(trigger);
  }

  /* ------------------------------------------------------------- hooks --- */

  /** Runs after the dialog is shown but before focus moves. Subclasses may await work here. */
  async beforeOpen() {}

  /** Runs once the entrance animation has finished. */
  afterOpen() {}

  /** Runs once the overlay is fully closed. */
  afterClose() {}

  /**
   * Cancel any previous WAAPI animation on the panel before starting a new
   * direction. This is important when a modal is closed while its entrance
   * animation is still settling: reversing an already-running animation can
   * briefly expose the CSS transform and makes the panel appear to jump.
   *
   * @private
   */
  #cancelPanelAnimations() {
    if (!(this.refs.panel instanceof HTMLElement)) return;
    for (const animation of this.refs.panel.getAnimations()) animation.cancel();
  }

  /**
   * @returns {Promise<void>|undefined}
   */
  async animateIn() {
    if (prefersReducedMotion() || !this.refs.panel) return undefined;

    this.#cancelPanelAnimations();

    // `enterDuration` is a getter rather than a constant so a subclass or an
    // attribute can set it — `<modal-dialog>` reads `data-animation-duration`.
    // The default is the 320ms every overlay has always used.
    const animation = this.refs.panel.animate(this.enterKeyframes(), {
      duration: this.enterDuration,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'both'
    });

    try {
      await animation.finished;
    } catch {
      // A close/open race can cancel the animation. The next animation owns
      // the panel's transform, so cancellation is not an error.
    }
  }

  /**
   * @returns {Promise<void>|undefined}
   */
  async animateOut() {
    if (prefersReducedMotion() || !this.refs.panel) return undefined;

    this.#cancelPanelAnimations();

    const animation = this.refs.panel.animate(this.enterKeyframes().slice().reverse(), {
      duration: this.exitDuration,
      easing: 'cubic-bezier(0.76, 0, 0.24, 1)',
      fill: 'both'
    });

    try {
      await animation.finished;
    } catch {
      // A second close/open action may cancel this animation.
    }
  }

  /**
   * @returns {Keyframe[]}
   */
  enterKeyframes() {
    return [
      { opacity: 0, transform: 'scale(0.98)' },
      { opacity: 1, transform: 'scale(1)' }
    ];
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * Release focus, scroll and trigger state. Idempotent, because a native
   * `close` event and an explicit `close()` call can both reach it.
   *
   * @private
   */
  #release() {
    if (!this.#open) return;
    this.#open = false;

    this.setAttribute('data-state', 'closed');

    this.#releaseFocus?.();
    this.#releaseFocus = null;

    unlockScroll();

    this.#trigger?.setAttribute('aria-expanded', 'false');
    this.#trigger = null;
  }

  /**
   * @returns {HTMLElement|undefined}
   * @private
   */
  #initialFocusTarget() {
    const explicit = this.querySelector('[data-overlay-autofocus]');
    if (explicit instanceof HTMLElement) return explicit;

    // Focusing the close button first is the least surprising default: it is
    // the action a customer is most likely to want, and it never puts the caret
    // into a search field on a device that will then open the keyboard.
    const close = this.querySelector('[data-overlay-close]');
    return close instanceof HTMLElement ? close : undefined;
  }

  /**
   * @param {MouseEvent} event
   * @private
   */
  #onDocumentClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const opener = target.closest(`[data-overlay-open="${CSS.escape(this.id)}"]`);
    if (opener instanceof HTMLElement) {
      event.preventDefault();
      this.open(opener);
      return;
    }

    const toggler = target.closest(`[data-overlay-toggle="${CSS.escape(this.id)}"]`);
    if (toggler instanceof HTMLElement) {
      event.preventDefault();
      this.toggle(toggler);
    }
  };

  /**
   * Close buttons inside the overlay, and clicks on the backdrop.
   *
   * The backdrop is the `<dialog>` element itself: anything visible sits inside
   * the panel, so a click whose target is the dialog landed outside the panel.
   *
   * @param {MouseEvent} event
   * @private
   */
  #onDialogClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;

    if (target?.closest('[data-overlay-close]')) {
      event.preventDefault();
      this.close();
      return;
    }

    if (target === this.refs.dialog && this.dataset.dismissible !== 'false') {
      this.close();
    }
  };

  /**
   * @param {Event} event
   * @private
   */
  #onCancel = (event) => {
    // Take over Escape so the exit animation runs and focus is restored the
    // same way it is for every other close path.
    event.preventDefault();
    this.close();
  };

  /** @private */
  #onNativeClose = () => {
    this.#release();
  };
}

/* ==========================================================================
   <modal-dialog>
   ========================================================================== */

/**
 * The entrances a modal can make.
 *
 * A drawer's movement is decided by the edge it comes from, which is why
 * `<drawer-component>` reads `data-placement` and has no choice to offer. A
 * modal has no edge — it is in the middle of the screen — so how it arrives is
 * a design decision, and until now it was one decision made here for every
 * modal in the theme.
 *
 * Each entry is the *opening* frame; the resting frame is added below, and the
 * exit is the whole thing reversed. So a movement is one line here and needs no
 * second keyframe written backwards — which is the way the two used to drift
 * apart in every theme that wrote both.
 *
 * `zoom-out` is the one that is not the reverse of another: it arrives *larger*
 * and settles, which reads as the modal coming towards the customer rather than
 * away from the page. It is the right one over a photograph, where a panel that
 * grows into place competes with the image behind it.
 *
 * @type {Record<string, Keyframe>}
 */
const MODAL_ENTRANCES = {
  fade: { opacity: 0 },
  'fade-up': { opacity: 0, transform: 'translate3d(0, 24px, 0)' },
  'fade-down': { opacity: 0, transform: 'translate3d(0, -24px, 0)' },
  'zoom-in': { opacity: 0, transform: 'scale(0.92)' },
  'zoom-out': { opacity: 0, transform: 'scale(1.06)' },
  'rise': { opacity: 0, transform: 'translate3d(0, 12px, 0) scale(0.98)' }
};

/** The entrance a modal makes when it names none. Unchanged from before these existed. */
const MODAL_ENTRANCE_DEFAULT = 'rise';

/**
 * A centred modal. Used for size guides, share sheets, address forms and
 * anything else that interrupts the page rather than sitting beside it.
 *
 * ## The entrance is the element's, and so is its length
 *
 * `data-animation` picks one of `MODAL_ENTRANCES` and `data-animation-duration`
 * sets how long it runs. Both are attributes rather than settings read from
 * theme config here, because `assets/dialog.js` drives every overlay in the
 * theme and only the Liquid that renders one knows which merchant setting it
 * belongs to — `sections/overlays.liquid` writes them onto the quick add modal
 * from **Theme settings › Product cards › Quick add modal**.
 *
 * The exit is the entrance reversed and a little faster, which it always was.
 * A modal leaving at the same speed it arrived reads as hesitant: the customer
 * has already decided, and the only thing left is to get out of the way.
 */
export class ModalDialog extends Overlay {
  get overlayType() {
    return this.dataset.overlayType || 'modal';
  }

  /**
   * @returns {number} Entrance length in milliseconds.
   */
  get enterDuration() {
    const value = Number(this.dataset.animationDuration);
    // Clamped rather than trusted: a merchant slider is a number this file did
    // not choose, and an overlay that takes three seconds to appear is one the
    // customer thinks is broken. Zero is allowed and means "no movement".
    return Number.isFinite(value) && value >= 0 ? Math.min(value, 1200) : 320;
  }

  /**
   * @returns {number} Exit length in milliseconds.
   */
  get exitDuration() {
    return Math.round(this.enterDuration * 0.75);
  }

  enterKeyframes() {
    const name = this.dataset.animation || MODAL_ENTRANCE_DEFAULT;
    const from = MODAL_ENTRANCES[name] ?? MODAL_ENTRANCES[MODAL_ENTRANCE_DEFAULT];

    // The resting frame names both properties whatever the opening frame used,
    // so a movement that only fades still lands on a known transform rather
    // than on whatever the stylesheet happens to leave behind.
    return [{ transform: 'none', ...from }, { opacity: 1, transform: 'none' }];
  }
}

defineComponent('modal-dialog', ModalDialog);

/* ==========================================================================
   <drawer-component>
   ========================================================================== */

/**
 * An edge drawer. `data-placement` accepts `start`, `end`, `top` or `bottom`;
 * `start` and `end` are logical, so a right-hand drawer in English becomes a
 * left-hand drawer in Arabic without a second stylesheet.
 */
export class DrawerComponent extends Overlay {
  get overlayType() {
    return this.dataset.overlayType || 'drawer';
  }

  enterKeyframes() {
    const placement = this.dataset.placement || 'end';

    switch (placement) {
      case 'start':
        return [
          { opacity: 0, transform: 'translate3d(-100%, 0, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' }
        ];
      case 'top':
        return [
          { opacity: 0, transform: 'translate3d(0, -100%, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' }
        ];
      case 'bottom':
        return [
          { opacity: 0, transform: 'translate3d(0, 100%, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' }
        ];
      default:
        // `end` is the physical right side in the default LTR theme.
        // Opening must therefore travel right -> left: 100% -> 0%.
        return [
          { opacity: 0, transform: 'translate3d(100%, 0, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' }
        ];
    }
  }
}

defineComponent('drawer-component', DrawerComponent);

/* ==========================================================================
   <quick-add-modal>
   ========================================================================== */

/**
 * A modal that renders a product's options on demand.
 *
 * Nothing is fetched until a customer actually asks for it, which is the whole
 * point: a collection page with forty products would otherwise ship forty
 * hidden variant pickers. The markup that arrives is rendered by Liquid through
 * the Section Rendering API, so translations, money formatting and metafield
 * logic are not duplicated in JavaScript.
 *
 * ## A modal, not a modal
 *
 * It extends `ModalDialog`, so it arrives in the centre of the screen with the
 * modal's own scale-and-rise entrance. That is the difference between quick add
 * and every drawer in the theme, and it is deliberate: a modal is a place a
 * customer goes and comes back from — the cart, the menu, the filters — while
 * quick add is one decision taken on top of the page the customer is already
 * reading. Sliding the page aside to ask which size they want puts a
 * navigational gesture on an inline choice.
 *
 * Only the placement changes. Fetching, focus, Escape, scroll locking and the
 * abort on teardown are all the same code they were, inherited one class higher
 * up rather than rewritten.
 *
 * Triggers pass the product through the trigger element:
 *
 *   <button
 *     data-overlay-open="QuickAdd"
 *     data-product-url="{{ product.url }}"
 *     data-section-id="quick-add">Choose options</button>
 */
export class QuickAddModal extends ModalDialog {
  /** @type {AbortController|null} */
  #request = null;

  /** @type {string|null} */
  #loadedUrl = null;

  get overlayType() {
    return 'quick-add';
  }

  /**
   * Fetch the product markup before focus moves, so a screen reader is not sent
   * into an empty modal.
   */
  async beforeOpen() {
    const url = this.dataset.pendingUrl;
    if (!url || url === this.#loadedUrl) return;

    await this.load(url, this.dataset.pendingSection || 'quick-add');
  }

  /**
   * Load a product into the modal.
   *
   * @param {string} url Product URL.
   * @param {string} [sectionId='quick-add']
   * @returns {Promise<void>}
   */
  async load(url, sectionId = 'quick-add') {
    const body = this.refs.body;
    if (!(body instanceof HTMLElement)) return;

    this.#request?.abort();
    this.#request = new AbortController();

    this.setLoading(true);
    body.setAttribute('aria-busy', 'true');

    try {
      const { fetchSection, applyHTML } = await import('@theme/section-renderer');
      const html = await fetchSection(sectionId, { url, signal: this.#request.signal });

      // `childrenOnly`, and this is the whole of why the modal had no padding.
      //
      // `morph()` syncs attributes both ways: it copies the source's onto the
      // target and removes any the source does not have. Morphing the fetched
      // `[data-quick-add-content]` wrapper *onto* the body therefore rewrote
      // `class="modal__body"` as `class="quick-add__content"` and dropped
      // `data-ref="body"` and `data-lenis-prevent` with it. From the first fetch
      // onwards the element was no longer the modal body, so it lost the body's
      // padding, its `overflow-y: auto` — a tall product could not be scrolled —
      // and its opt-out from Lenis's wheel handling.
      //
      // Only the contents are the section's. The body's own identity is this
      // file's, and `sections/overlays.liquid` carries the two hooks the fetched
      // wrapper used to bring with it, so `<variant-picker>`, `<product-form>`
      // and `<quick-add-summary>` still scope themselves to the modal.
      applyHTML(html, body, {
        selector: '[data-quick-add-content]',
        sectionId,
        morphOptions: { childrenOnly: true }
      });
      this.#loadedUrl = url;
    } catch (error) {
      if (error?.name === 'AbortError') return;

      console.error('[Boost10] <quick-add-modal> could not load the product.', error);
      body.textContent = themeString('networkError', '');
      announceUrgent(themeString('networkError', ''));
    } finally {
      this.setLoading(false);
      body.removeAttribute('aria-busy');
      this.#request = null;
    }
  }

  /**
   * Record which product a trigger asked for before the base class opens.
   *
   * @param {HTMLElement} [trigger]
   * @returns {Promise<void>}
   */
  open(trigger) {
    if (trigger?.dataset.productUrl) {
      this.dataset.pendingUrl = trigger.dataset.productUrl;
      if (trigger.dataset.sectionId) this.dataset.pendingSection = trigger.dataset.sectionId;
    }

    return super.open(trigger);
  }

  teardown() {
    this.#request?.abort();
    this.#request = null;
    super.teardown();
  }
}

defineComponent('quick-add-modal', QuickAddModal);

export default { Overlay, ModalDialog, DrawerComponent, QuickAddModal };
