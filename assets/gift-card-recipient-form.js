/**
 * gift-card-recipient-form.js — Boost10
 *
 * `<gift-card-recipient-form>` — sends a gift card straight to its recipient.
 *
 * Shopify reads four line item properties on a gift card product:
 * `Recipient email`, `Recipient name`, `Message` and `Send on`. Setting them
 * makes Shopify email the card on the chosen date. The property names are fixed
 * by the platform, so they are never translated — only their labels are.
 *
 * Three details that are easy to get wrong and expensive to miss:
 *
 *   1. **Disabled fields are not submitted.** That is exactly what is wanted
 *      here: an empty `Recipient email` property on every gift card order would
 *      be noise in the merchant's admin, and Shopify treats the *presence* of
 *      the property as the instruction to send. So the fields stay disabled
 *      until the customer opts in.
 *   2. **`Send on` in the past never sends.** Shopify accepts the value and then
 *      silently does nothing, so the guard has to be in the theme.
 *   3. **Validation has to run before add-to-cart.** `<product-form>` calls
 *      `validate()` and stops the submit if it fails, otherwise a customer buys
 *      a gift card that will never reach anyone.
 *
 * Markup:
 *
 *   <gift-card-recipient-form>
 *     <input type="checkbox" data-ref="toggle" id="…">
 *     <div data-ref="fields" hidden>
 *       <input name="properties[Recipient email]" data-ref="email" type="email" disabled>
 *       <input name="properties[Recipient name]" data-ref="name" disabled>
 *       <textarea name="properties[Message]" data-ref="message" maxlength="200" disabled></textarea>
 *       <input name="properties[Send on]" type="date" data-ref="sendOn" disabled>
 *       <p data-ref="counter"></p>
 *       <p data-ref="error" role="alert" hidden></p>
 *     </div>
 *   </gift-card-recipient-form>
 *
 * @module @theme/gift-card-recipient-form
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { themeString, announce, announceUrgent } from '@theme/utilities';

/** How far ahead a gift card may be scheduled, in days. */
const MAX_SCHEDULE_DAYS = 365;

export class GiftCardRecipientForm extends BaseComponent {
  static requiredRefs = ['toggle', 'fields'];

  setup() {
    this.on(this.refs.toggle, 'change', () => this.setEnabled(this.refs.toggle.checked));

    if (this.refs.message) {
      this.on(this.refs.message, 'input', () => this.#renderCounter());
      this.#renderCounter();
    }

    if (this.refs.email) {
      // Clear the error as soon as the customer starts fixing it, rather than
      // leaving a red message under a field they have already corrected.
      this.on(this.refs.email, 'input', () => this.#error(''));
    }

    this.#constrainDate();
    this.setEnabled(this.refs.toggle.checked, { silent: true });
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {boolean}
   */
  get enabled() {
    return this.refs.toggle.checked;
  }

  /**
   * @returns {{ email: string, name: string, message: string, sendOn: string }}
   */
  get values() {
    return {
      email: this.refs.email?.value?.trim() ?? '',
      name: this.refs.name?.value?.trim() ?? '',
      message: this.refs.message?.value?.trim() ?? '',
      sendOn: this.refs.sendOn?.value ?? ''
    };
  }

  /**
   * Show or hide the recipient fields.
   *
   * @param {boolean} enabled
   * @param {{ silent?: boolean }} [options]
   */
  setEnabled(enabled, { silent = false } = {}) {
    this.refs.fields.hidden = !enabled;
    this.toggleAttribute('data-enabled', enabled);

    for (const field of this.refs.fields.querySelectorAll('input, textarea, select')) {
      // Values are kept, not cleared: a customer who unticks and re-ticks the
      // box should not have to type the address again.
      field.disabled = !enabled;
    }

    if (this.refs.email instanceof HTMLInputElement) {
      this.refs.email.required = enabled;
      if (enabled && !silent) this.refs.email.focus({ preventScroll: true });
    }

    if (!enabled) this.#error('');

    if (!silent) announce(themeString(enabled ? 'giftCardSending' : 'giftCardSelf', ''));
  }

  /**
   * Check the recipient details.
   *
   * Called by `<product-form>` before it submits. Returns true when the card is
   * for the buyer, or when the recipient details are complete.
   *
   * @returns {boolean}
   */
  validate() {
    if (!this.enabled) return true;

    const email = this.refs.email;

    if (email instanceof HTMLInputElement) {
      const value = email.value.trim();

      if (value === '' || !email.checkValidity()) {
        this.#fail(email, themeString('giftCardEmailRequired', ''));
        return false;
      }
    }

    const sendOn = this.refs.sendOn;

    if (sendOn instanceof HTMLInputElement && sendOn.value !== '') {
      const chosen = new Date(`${sendOn.value}T00:00:00`);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (Number.isNaN(chosen.getTime()) || chosen < today) {
        this.#fail(sendOn, themeString('giftCardDatePast', ''));
        return false;
      }
    }

    this.#error('');
    this.removeAttribute('data-invalid');
    return true;
  }

  /**
   * Clear every field and switch back to buying for yourself.
   *
   * Called after a successful add to cart, so the next gift card does not
   * inherit the previous recipient.
   */
  reset() {
    for (const field of this.refs.fields.querySelectorAll('input, textarea')) {
      if (field.type === 'checkbox') continue;
      field.value = '';
    }

    this.refs.toggle.checked = false;
    this.setEnabled(false, { silent: true });
    this.#renderCounter();
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * Bound the date picker to a sensible window.
   *
   * @private
   */
  #constrainDate() {
    const input = this.refs.sendOn;
    if (!(input instanceof HTMLInputElement)) return;

    const today = new Date();
    const max = new Date();
    max.setDate(max.getDate() + MAX_SCHEDULE_DAYS);

    input.min = today.toISOString().split('T')[0];
    input.max = max.toISOString().split('T')[0];
  }

  /** @private */
  #renderCounter() {
    const target = this.refs.counter;
    const message = this.refs.message;
    if (!(target instanceof HTMLElement) || !(message instanceof HTMLTextAreaElement)) return;

    const max = Number(message.maxLength) > 0 ? Number(message.maxLength) : 200;
    target.textContent = themeString('giftCardCharacters', '', { max: max - message.value.length });
  }

  /**
   * @param {HTMLElement} field
   * @param {string} message
   * @private
   */
  #fail(field, message) {
    this.setAttribute('data-invalid', '');
    this.#error(message);

    field.setAttribute('aria-invalid', 'true');
    field.focus({ preventScroll: true });

    announceUrgent(message);
  }

  /**
   * @param {string} message
   * @private
   */
  #error(message) {
    const target = this.refs.error;

    if (target instanceof HTMLElement) {
      target.textContent = message;
      target.toggleAttribute('hidden', !message);
    }

    if (!message) {
      for (const field of this.refs.fields.querySelectorAll('[aria-invalid]')) {
        field.removeAttribute('aria-invalid');
      }
      this.removeAttribute('data-invalid');
    }
  }
}

defineComponent('gift-card-recipient-form', GiftCardRecipientForm);

export default GiftCardRecipientForm;
