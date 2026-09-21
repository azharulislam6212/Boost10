/**
 * `<back-in-stock-form>` — sign-up for a notification when a sold-out variant
 * returns.
 *
 * @module @theme/back-in-stock
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { themeString, announce } from '@theme/utilities';

/** Sign-up for a notification when a sold-out variant returns. */
export class BackInStockForm extends BaseComponent {
  static requiredRefs = ['form'];

  setup() {
    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => this.#syncTo(event.detail?.variant));
    this.on(this.root, EVENTS.VARIANT_UNAVAILABLE, () => this.#syncTo(null));
    this.on(this.refs.form, 'submit', this.#onSubmit);

    this.on(this.root, EVENTS.VARIANT_READY, (event) => this.#syncTo(event.detail?.variant ?? null));

    const picker = this.root.querySelector?.('variant-picker');
    if (!picker || picker.currentVariant !== undefined) this.#syncTo(picker?.currentVariant ?? null);
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
