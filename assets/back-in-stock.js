/**
 * back-in-stock.js — Boost10
 *
 * `<back-in-stock-form>` — sign-up for a notification when a sold-out variant
 * returns.
 *
 * Its own module because it is only ever on a product page with something out of
 * stock, and because the alternative — leaving it inside `variant-picker.js` —
 * meant every storefront paid for it on every page.
 *
 * Submits through Shopify's native contact form, so the request lands in the
 * merchant's admin with no app and no external service. The theme stores nothing
 * and sends nothing anywhere: a theme that collected email addresses itself
 * would be doing an app's job, which the Theme Store rejects.
 *
 * @module @theme/back-in-stock
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { themeString, announce } from '@theme/utilities';

/**
 * Sign-up for a notification when a sold-out variant returns.
 *
 * Submits through Shopify's native contact form, so the request lands in the
 * merchant's admin with no app and no external service. The theme stores
 * nothing and sends nothing anywhere — a theme that collected email addresses
 * itself would be doing an app's job, which the Theme Store rejects.
 *
 * Markup:
 *
 *   <back-in-stock-form data-product-title="…">
 *     <form data-ref="form">…</form>
 *     <p data-ref="message" role="status"></p>
 *   </back-in-stock-form>
 */
export class BackInStockForm extends BaseComponent {
  static requiredRefs = ['form'];

  setup() {
    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => this.#syncTo(event.detail?.variant));
    this.on(this.root, EVENTS.VARIANT_UNAVAILABLE, () => this.#syncTo(null));
    this.on(this.refs.form, 'submit', this.#onSubmit);

    const picker = this.root.querySelector?.('variant-picker');
    this.#syncTo(picker?.currentVariant ?? null);
  }

  /**
   * @returns {HTMLElement|Document}
   */
  get root() {
    return this.closest('[data-product-root]') || document;
  }

  /**
   * @param {Object|null} variant
   * @private
   */
  #syncTo(variant) {
    const show = Boolean(variant) && !variant.available;
    this.hidden = !show;

    // Closing the modal when the customer switches to an in-stock variant stops
    // them submitting a request for something they can simply buy.
    if (!show) {
      this.querySelector('modal-dialog')?.close?.();
      return;
    }

    const field = this.refs.form.querySelector('[name="contact[variant]"]');
    if (field instanceof HTMLInputElement) field.value = variant.title;

    const body = this.refs.form.querySelector('[name="contact[body]"]');
    if (body instanceof HTMLInputElement || body instanceof HTMLTextAreaElement) {
      body.value = themeString('backInStockBody', '', {
        product: this.dataset.productTitle || '',
        variant: variant.title
      });
    }
  }

  /**
   * @param {SubmitEvent} event
   * @private
   */
  #onSubmit = async (event) => {
    event.preventDefault();

    const submit = this.refs.form.querySelector('[type="submit"]');
    submit?.setAttribute('disabled', '');
    submit?.setAttribute('aria-busy', 'true');

    try {
      const response = await fetch(this.refs.form.action, {
        method: 'POST',
        body: new FormData(this.refs.form),
        headers: { Accept: 'text/html' }
      });

      if (!response.ok) throw new Error(String(response.status));

      this.#message(themeString('backInStockSuccess', ''));
      this.refs.form.reset();

      // Leave the confirmation on screen for a moment rather than closing on
      // top of the message the customer just earned.
      window.setTimeout(() => this.querySelector('modal-dialog')?.close?.(), 2500);
    } catch {
      this.#message(themeString('backInStockError', ''), true);
    } finally {
      submit?.removeAttribute('disabled');
      submit?.removeAttribute('aria-busy');
    }
  };

  /**
   * @param {string} text
   * @param {boolean} [isError=false]
   * @private
   */
  #message(text, isError = false) {
    const target = this.refs.message;
    if (target instanceof HTMLElement) {
      target.textContent = text;
      target.toggleAttribute('data-error', isError);
    }
    announce(text);
  }
}

defineComponent('back-in-stock-form', BackInStockForm);

export default BackInStockForm;
