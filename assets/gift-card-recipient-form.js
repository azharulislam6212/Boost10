/**
 * `<gift-card-recipient-form>` — sends a gift card straight to its recipient.
 *
 * @module @theme/gift-card-recipient-form
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { themeString, announce, announceUrgent } from '@theme/utilities';

/** How far ahead a gift card may be scheduled, in days. */
const MAX_SCHEDULE_DAYS = 365;

/** A full address: something, an @, a domain and a dot-separated suffix. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export class GiftCardRecipientForm extends BaseComponent {
  static requiredRefs = ['toggle', 'fields'];

  setup() {
    this.on(this.refs.toggle, 'change', () => this.setEnabled(this.refs.toggle.checked));

    if (this.refs.message) {
      this.on(this.refs.message, 'input', () => this.#renderCounter());
      this.#renderCounter();
    }

    if (this.refs.email) {
      this.on(this.refs.email, 'input', () => this.#error(''));
    }

    this.#constrainDate();
    this.setEnabled(this.refs.toggle.checked, { silent: true });
  }

  /* --------------------------------------------------------- public API -- ---- */

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
      field.disabled = !enabled;
    }

    if (this.refs.offset instanceof HTMLInputElement) {
      this.refs.offset.value = String(new Date().getTimezoneOffset());
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
   * @returns {boolean}
   */
  validate() {
    if (!this.enabled) return true;

    const email = this.refs.email;

    if (email instanceof HTMLInputElement) {
      const value = email.value.trim();

      if (value === '') {
        this.#fail(email, themeString('giftCardEmailRequired', ''));
        return false;
      }

      if (!EMAIL_PATTERN.test(value) || !email.checkValidity()) {
        this.#fail(email, themeString('formEmail', '') || themeString('giftCardEmailRequired', ''));
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

  /** Clear every field and switch back to buying for yourself. */
  reset() {
    for (const field of this.refs.fields.querySelectorAll('input, textarea')) {
      if (field.type === 'checkbox') continue;
      field.value = '';
    }

    this.refs.toggle.checked = false;
    this.setEnabled(false, { silent: true });
    this.#renderCounter();
  }

  /* ---------------------------------------------------------- internals -- ---- */

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
