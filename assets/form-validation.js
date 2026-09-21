/**
 * `<validated-form>` — inline validation for every form in the theme.
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

    form.setAttribute('novalidate', '');

    this.on(form, 'submit', this.#onSubmit);

    this.on(form, 'invalid', (event) => event.preventDefault(), { capture: true });

    for (const field of this.fields) {
      this.on(field, 'input', () => {
        if (this.#submitted) this.validateField(field);
      });

      this.on(field, 'blur', () => {
        if (this.#submitted) this.validateField(field);
      });
    }
  }

  /* --------------------------------------------------------- public API -- ---- */

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

  /* ---------------------------------------------------------- internals -- ---- */

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

      field.insertAdjacentElement('afterend', target);
    }

    target.textContent = message;
    target.hidden = false;

    field.setAttribute('aria-invalid', 'true');

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
