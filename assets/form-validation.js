/**
 * form-validation.js — Boost10
 *
 * `<validated-form>` — inline validation for every form in the theme.
 *
 * ## What this does not do
 *
 * It does **not** replace the browser's validation, and it does not replace
 * Shopify's. The browser already knows what a valid email looks like in every
 * locale; Shopify already knows whether that email is already registered. This
 * only fixes the part neither of them does well: *where and when* the message
 * appears.
 *
 * Native validation shows one bubble, on the first invalid field, that vanishes
 * on the next keystroke and is invisible to some screen readers. Shopify's own
 * errors arrive after a page reload, at the top, with the field that caused them
 * possibly off screen.
 *
 * So: `novalidate` turns off the bubbles, `checkValidity()` still decides what is
 * valid, and this places the message beside the field with `aria-describedby` and
 * `aria-invalid`.
 *
 * ## Three rules about timing
 *
 * **Nothing is validated before the first submit.** Marking a field red because
 * someone has not finished typing their email is the most disliked pattern in
 * form design, and it punishes slow typists hardest.
 *
 * **After a failed submit, fields re-validate on input.** Once someone knows
 * there is a problem, live feedback is help rather than nagging — and the error
 * clearing as they fix it is the confirmation they need.
 *
 * **Focus moves to the first invalid field, once.** Not to the summary, because
 * the summary is not where the work is; and not on every keystroke, because
 * stealing focus mid-typing is worse than any error message.
 *
 * @module @theme/form-validation
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { themeString, announceUrgent } from '@theme/utilities';

/** Fields worth validating. Buttons, hidden inputs and honeypots are not. */
const FIELD_SELECTOR = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea';

export class ValidatedForm extends BaseComponent {
  /** True once a submit has been attempted and rejected. */
  #submitted = false;

  setup() {
    const form = this.form;
    if (!form) return;

    // The browser's own bubbles are turned off, but `checkValidity()` still
    // works — so the rules stay native and only the presentation changes.
    form.setAttribute('novalidate', '');

    this.on(form, 'submit', this.#onSubmit);

    // `invalid` does not bubble, so it has to be captured.
    this.on(form, 'invalid', (event) => event.preventDefault(), { capture: true });

    for (const field of this.fields) {
      this.on(field, 'input', () => {
        if (this.#submitted) this.validateField(field);
      });

      // Blur validates only after a failed submit too. A field that turns red
      // the moment someone tabs past it is the same nagging by another name.
      this.on(field, 'blur', () => {
        if (this.#submitted) this.validateField(field);
      });
    }
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {HTMLFormElement|null}
   */
  get form() {
    return this.querySelector('form');
  }

  /**
   * @returns {HTMLElement[]}
   */
  get fields() {
    return Array.from(this.form?.querySelectorAll(FIELD_SELECTOR) ?? []);
  }

  /**
   * Validate everything and report.
   *
   * @returns {boolean}
   */
  validate() {
    let firstInvalid = null;

    for (const field of this.fields) {
      const valid = this.validateField(field);
      if (!valid && !firstInvalid) firstInvalid = field;
    }

    if (firstInvalid) {
      // Focus the field, not the summary. The summary is not where the work is,
      // and `preventScroll` plus an explicit scroll keeps a sticky header from
      // covering the thing we just focused.
      firstInvalid.focus({ preventScroll: true });
      firstInvalid.scrollIntoView({ block: 'center', behavior: 'smooth' });

      announceUrgent(themeString('formError', ''));
    }

    return !firstInvalid;
  }

  /**
   * Validate one field and show or clear its message.
   *
   * @param {HTMLElement} field
   * @returns {boolean}
   */
  validateField(field) {
    if (typeof field.checkValidity !== 'function') return true;

    const valid = field.checkValidity();

    if (valid) {
      this.#clearError(field);
      return true;
    }

    this.#showError(field, this.messageFor(field));
    return false;
  }

  /**
   * The message for a field's failure.
   *
   * Written per failure type rather than passing `validationMessage` through,
   * because the browser's wording is not translated with the rest of the theme —
   * a French storefront would show a French field label above an English error,
   * or vice versa, depending on the customer's browser language.
   *
   * @param {HTMLElement} field
   * @returns {string}
   */
  messageFor(field) {
    const state = field.validity;
    const label = this.#labelFor(field);

    if (state.valueMissing) return themeString('formRequired', '', { field: label });
    if (state.typeMismatch && field.type === 'email') return themeString('formEmail', '');
    if (state.typeMismatch && field.type === 'tel') return themeString('formPhone', '');
    if (state.typeMismatch && field.type === 'url') return themeString('formUrl', '');
    if (state.tooShort) return themeString('formTooShort', '', { min: field.minLength });
    if (state.tooLong) return themeString('formTooLong', '', { max: field.maxLength });
    if (state.rangeUnderflow) return themeString('formMin', '', { min: field.min });
    if (state.rangeOverflow) return themeString('formMax', '', { max: field.max });
    if (state.patternMismatch) return field.dataset.patternMessage || themeString('formPattern', '');

    return themeString('formInvalid', '');
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @param {SubmitEvent} event
   * @private
   */
  #onSubmit = (event) => {
    this.#submitted = true;

    if (this.validate()) return;

    event.preventDefault();
    event.stopPropagation();
  };

  /**
   * The field's visible label, so a message can name it the way the customer
   * sees it rather than by its `name` attribute.
   *
   * @param {HTMLElement} field
   * @returns {string}
   * @private
   */
  #labelFor(field) {
    const explicit = field.id ? this.querySelector(`label[for="${CSS.escape(field.id)}"]`) : null;
    const wrapper = field.closest('label');
    const source = explicit || wrapper;

    if (!source) return field.getAttribute('aria-label') || '';

    // Strip a trailing required marker, so a message does not read
    // "Email * is required".
    return source.textContent.replace(/\s*\*\s*$/, '').trim();
  }

  /**
   * @param {HTMLElement} field
   * @param {string} message
   * @private
   */
  #showError(field, message) {
    const id = this.#errorId(field);
    let target = this.querySelector(`#${CSS.escape(id)}`);

    if (!target) {
      target = document.createElement('p');
      target.id = id;
      target.className = 'form-field__error';

      // Not `role="alert"`. One alert per field means a screen reader announces
      // four errors in a row over the top of each other; `aria-describedby`
      // means each is read when its field is reached, which is when it is
      // useful. The single summary announcement covers the overall failure.
      field.insertAdjacentElement('afterend', target);
    }

    target.textContent = message;
    target.hidden = false;

    field.setAttribute('aria-invalid', 'true');

    // Preserve any describedby the markup already set, such as a help text id.
    const described = (field.dataset.describedby ??= field.getAttribute('aria-describedby') || '');
    field.setAttribute('aria-describedby', `${described} ${id}`.trim());
  }

  /**
   * @param {HTMLElement} field
   * @private
   */
  #clearError(field) {
    const id = this.#errorId(field);
    const target = this.querySelector(`#${CSS.escape(id)}`);

    if (target) {
      target.textContent = '';
      target.hidden = true;
    }

    field.removeAttribute('aria-invalid');

    const described = field.dataset.describedby ?? '';
    if (described) field.setAttribute('aria-describedby', described);
    else field.removeAttribute('aria-describedby');
  }

  /**
   * @param {HTMLElement} field
   * @returns {string}
   * @private
   */
  #errorId(field) {
    const base = field.id || field.name || 'field';
    return `${base}-error`.replace(/[^\w-]/g, '-');
  }
}

defineComponent('validated-form', ValidatedForm);

export default ValidatedForm;
