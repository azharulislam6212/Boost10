/**
 * promo-popup.js — Boost10
 *
 * `<promo-popup>` — the newsletter and discount overlay.
 *
 * This is the component most likely to make a store worse, so the defaults are
 * cautious and the restraint is deliberate rather than accidental.
 *
 * What it will not do:
 *
 *   - Show on the first page view. A modal before a customer has seen anything
 *     converts badly and is one of the interstitials Google penalises on mobile.
 *   - Show again after it has been dismissed or converted, until the merchant's
 *     chosen number of days has passed.
 *   - Show on checkout, the cart, or while another overlay is open.
 *   - Use exit intent on touch devices, where the pointer never leaves the
 *     viewport and every scroll upward would fire it.
 *
 * Storage is `localStorage`, namespaced per shop through `storage`. Nothing is
 * sent anywhere: whether a visitor has seen a popup is not information a theme
 * should collect.
 *
 * The discount code is stored on the cart and appended to the checkout URL by
 * `cart.applyDiscount`. No storefront API can validate a code, so the popup says
 * "applied at checkout" rather than claiming a saving it cannot verify.
 *
 * Markup:
 *
 *   <promo-popup
 *     data-trigger="delay"        delay | scroll | exit-intent
 *     data-delay="6"              seconds
 *     data-scroll-depth="50"      percent
 *     data-frequency="7"          days before showing again
 *     data-discount-code="WELCOME10">
 *     <dialog data-ref="dialog">
 *       <div data-ref="panel">
 *         <button data-overlay-close>…</button>
 *         <form data-ref="form">…</form>
 *         <p data-ref="message" role="status"></p>
 *       </div>
 *     </dialog>
 *   </promo-popup>
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

  /* --------------------------------------------------------- public API -- */

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

    // A modal on the first page view interrupts someone who has not yet seen
    // anything worth signing up for, and is the interstitial pattern Google
    // penalises on mobile.
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

    // Never stack on top of a drawer the customer opened themselves.
    if (document.querySelector('[data-overlay-open-state]')) return;

    this.#remember();
    await this.open();
  }

  /**
   * Dismiss and do not show again for `frequency` days.
   */
  dismiss() {
    this.#remember();
    this.close();
  }

  afterClose() {
    this.#remember();
  }

  /* ---------------------------------------------------------- internals -- */

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
   * Pointer devices only. On a touchscreen the pointer never leaves, and every
   * upward scroll would look like an exit.
   *
   * @private
   */
  #watchExitIntent() {
    if (isTouchDevice()) {
      // Fall back to a generous delay rather than showing nothing at all.
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
    // Shopify's customer form handles the signup itself, with a page reload. The
    // only thing intercepted is the discount, which has to reach the cart before
    // the customer navigates away.
    if (!this.discountCode) return;

    event.preventDefault();

    const submit = this.refs.form.querySelector('[type="submit"]');
    submit?.setAttribute('disabled', '');

    try {
      await cart.applyDiscount(this.discountCode);

      this.#message(themeString('discountApplied', '', { code: this.discountCode }));
      this.setAttribute('data-converted', '');

      // The form still needs to submit for the signup itself.
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
