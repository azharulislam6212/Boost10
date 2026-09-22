/**
 * Every overlay in the theme: modals, drawers, toasts and the quick option
 * drawer. They live in one file because they share one behaviour — taking over
 * the page, trapping focus, and giving both back cleanly — and duplicating that
 * across four files is how overlays start behaving differently from each other.
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

  /* ------------------------------------------------------------ lifecycle ---- */

  setup() {
    if (!this.id) this.id = uniqueId('overlay');

    const body = this.refs.body;
    if (body instanceof HTMLElement && !body.hasAttribute('data-lenis-prevent')) {
      body.setAttribute('data-lenis-prevent', '');
    }

    this.on(document, 'click', this.#onDocumentClick);
    this.on(this.refs.dialog, 'click', this.#onDialogClick);
    this.on(this.refs.dialog, 'cancel', this.#onCancel);
    this.on(this.refs.dialog, 'close', this.#onNativeClose);

    this.#open = this.refs.dialog.open;
  }

  teardown() {
    if (this.#open) this.#release();
  }

  /* --------------------------------------------------------- public API -- ---- */

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

    try {
      if (!this.refs.dialog.open) this.refs.dialog.showModal();
    } catch (error) {
      this.#open = false;
      this.setAttribute('data-state', 'closed');
      this.#trigger?.setAttribute('aria-expanded', 'false');
      this.#trigger = null;
      console.error(`[Boost10] ${this.id} could not open.`, error);
      return;
    }

    lockScroll();

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

    const animation = this.refs.panel.animate(this.enterKeyframes(), {
      duration: this.enterDuration,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'both'
    });

    try {
      await animation.finished;
    } catch {}
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
    } catch {}
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

  /* ---------------------------------------------------------- internals -- ---- */

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

/** A modal that renders a product's options on demand. */
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

      if (this.#loadedUrl !== url) body.replaceChildren();

      applyHTML(html, body, {
        selector: '[data-quick-add-content]',
        sectionId,
        morphOptions: { childrenOnly: true }
      });
      this.#loadedUrl = url;
    } catch (error) {
      if (error?.name === 'AbortError') return;

      this.#loadedUrl = null;

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
