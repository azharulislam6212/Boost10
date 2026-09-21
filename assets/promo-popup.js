/**
 * `<promo-popup>` — the newsletter and discount overlay.
 *
 * @module @theme/promo-popup
 */

import { defineComponent } from '@theme/component';
import { ModalDialog } from '@theme/dialog';
import { cart } from '@theme/cart-drawer';
import { storage, themeString, announce, announceUrgent, isTouchDevice, debounce } from '@theme/utilities';

/** Storage key, namespaced per shop by `storage`. */
const SEEN_KEY = 'promo-popup-seen';

/** Page views before a popup may appear at all. */
const MIN_PAGE_VIEWS = 2;

/** Storage key for the counter above. */
const VIEWS_KEY = 'page-views';

export class PromoPopup extends ModalDialog {
  /** @type {number|null} */
  #timer = null;

  /** @type {(() => void)|null} */
  #detach = null;

  get overlayType() {
    return 'promo';
  }

  setup() {
    super.setup();

    this.#countPageView();

    if (!this.shouldShow) return;

    if (this.refs.form) {
      this.on(this.refs.form, 'submit', this.#onSubmit);
    }

    switch (this.trigger) {
      case 'scroll':
        this.#watchScroll();
        break;
      case 'exit-intent':
        this.#watchExitIntent();
        break;
      default:
        this.#timer = window.setTimeout(() => this.reveal(), this.delay);
    }
  }

  teardown() {
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
    this.#detach?.();
    this.#detach = null;
    super.teardown();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {'delay'|'scroll'|'exit-intent'}
   */
  get trigger() {
    return this.dataset.trigger || 'delay';
  }

  /**
   * @returns {number} Milliseconds.
   */
  get delay() {
    return (Number(this.dataset.delay) || 6) * 1000;
  }

  /**
   * @returns {number} Days before it may show again.
   */
  get frequency() {
    return Number(this.dataset.frequency) || 7;
  }

  /**
   * @returns {string|null}
   */
  get discountCode() {
    return this.dataset.discountCode || null;
  }

  /**
   * Whether this visitor should see the popup at all.
   *
   * @returns {boolean}
   */
  get shouldShow() {
    if (window.Theme?.designMode) return false;

    if (this.#pageViews() < MIN_PAGE_VIEWS) return false;

    const seen = storage.get(SEEN_KEY, null);
    if (!seen) return true;

    const days = (Date.now() - Number(seen)) / 86_400_000;
    return days >= this.frequency;
  }

  /**
   * Show the popup and record that it was shown.
   *
   * @returns {Promise<void>}
   */
  async reveal() {
    if (!this.shouldShow) return;

    if (document.querySelector('[data-overlay-open-state]')) return;

    this.#remember();
    await this.open();
  }

  /** Dismiss and do not show again for `frequency` days. */
  dismiss() {
    this.#remember();
    this.close();
  }

  afterClose() {
    this.#remember();
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /** @private */
  #remember() {
    storage.set(SEEN_KEY, String(Date.now()));
  }

  /**
   * @returns {number}
   * @private
   */
  #pageViews() {
    return Number(storage.get(VIEWS_KEY, 0)) || 0;
  }

  /** @private */
  #countPageView() {
    storage.set(VIEWS_KEY, this.#pageViews() + 1);
  }

  /** @private */
  #watchScroll() {
    const depth = Number(this.dataset.scrollDepth) || 50;

    const check = debounce(() => {
      const scrolled = window.scrollY + window.innerHeight;
      const total = document.documentElement.scrollHeight;
      if (total <= 0) return;

      if ((scrolled / total) * 100 < depth) return;

      window.removeEventListener('scroll', check);
      this.reveal();
    }, 150);

    window.addEventListener('scroll', check, { passive: true, signal: this.signal });
    this.#detach = () => window.removeEventListener('scroll', check);
  }

  /**
   * Exit intent: the pointer leaves through the top of the viewport.
   *
   * @private
   */
  #watchExitIntent() {
    if (isTouchDevice()) {
      this.#timer = window.setTimeout(() => this.reveal(), this.delay * 3);
      return;
    }

    const onLeave = (event) => {
      if (event.clientY > 0 || event.relatedTarget) return;

      document.removeEventListener('mouseout', onLeave);
      this.reveal();
    };

    document.addEventListener('mouseout', onLeave, { signal: this.signal });
    this.#detach = () => document.removeEventListener('mouseout', onLeave);
  }

  /**
   * @param {SubmitEvent} event
   * @private
   */
  #onSubmit = async (event) => {
    if (!this.discountCode) return;

    event.preventDefault();

    const submit = this.refs.form.querySelector('[type="submit"]');
    submit?.setAttribute('disabled', '');

    try {
      await cart.applyDiscount(this.discountCode);

      this.#message(themeString('discountApplied', '', { code: this.discountCode }));
      this.setAttribute('data-converted', '');

      window.setTimeout(() => this.refs.form.submit(), 600);
    } catch (error) {
      console.warn('[Boost10] The promotion code could not be stored.', error);
      announceUrgent(themeString('cartError', ''));
      this.refs.form.submit();
    } finally {
      submit?.removeAttribute('disabled');
      this.#remember();
    }
  };

  /**
   * @param {string} text
   * @private
   */
  #message(text) {
    if (this.refs.message instanceof HTMLElement) this.refs.message.textContent = text;
    announce(text);
  }
}

defineComponent('promo-popup', PromoPopup);

export default PromoPopup;
