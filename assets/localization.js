/**
 * `<localization-form>` — the country/region and language selectors.
 *
 * @module @theme/localization
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { debounce, themeString, announce, getFocusableElements } from '@theme/utilities';

export class LocalizationForm extends BaseComponent {
  static requiredRefs = ['trigger', 'panel'];

  setup() {
    this.refs.panel.removeAttribute('hidden');

    this.close();

    this.on(this.refs.trigger, 'click', () => this.toggle());

    this.on(this, 'keydown', (event) => {
      if (event.key !== 'Escape' || !this.isOpen) return;
      event.preventDefault();
      this.close();
      this.refs.trigger.focus();
    });

    this.on(document, 'click', (event) => {
      if (this.contains(event.target)) return;
      this.close();
    });

    if (this.refs.filter instanceof HTMLInputElement) {
      const filter = debounce((value) => this.filter(value), 150);
      this.on(this.refs.filter, 'input', (event) => filter(event.target.value));

      this.on(this.refs.filter, 'keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();

        this.filter(event.target.value);
        const matches = this.visibleOptions;
        if (matches.length === 1) matches[0].click();
      });

      this.refs.filter.closest('[data-filter-wrapper]')?.removeAttribute('hidden');
    }

    this.on(this.refs.panel, 'keydown', this.#onPanelKeydown);
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {boolean}
   */
  get isOpen() {
    return this.hasAttribute('data-open');
  }

  /**
   * @returns {'country'|'language'}
   */
  get type() {
    return this.dataset.type === 'language' ? 'language' : 'country';
  }

  /**
   * @returns {HTMLElement[]} Every option button, including hidden ones.
   */
  get options() {
    return Array.from(this.querySelectorAll('[data-option]'));
  }

  /**
   * @returns {HTMLElement[]} Options currently visible.
   */
  get visibleOptions() {
    return this.options.filter((option) => !option.closest('[hidden]'));
  }

  open() {
    if (this.isOpen) return;

    for (const other of document.querySelectorAll('localization-form[data-open]')) {
      if (other !== this) other.close?.();
    }

    this.setAttribute('data-open', '');
    this.refs.panel.removeAttribute('inert');
    this.refs.panel.removeAttribute('aria-hidden');
    this.refs.trigger.setAttribute('aria-expanded', 'true');

    const first = this.refs.filter instanceof HTMLElement ? this.refs.filter : this.#selectedOption();
    requestAnimationFrame(() => {
      if (this.isOpen) first?.focus({ preventScroll: true });
    });
  }

  close() {
    this.removeAttribute('data-open');
    this.refs.trigger.setAttribute('aria-expanded', 'false');

    this.refs.panel.setAttribute('inert', '');
    this.refs.panel.setAttribute('aria-hidden', 'true');
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Hide options that do not match a term.
   *
   * @param {string} term
   */
  filter(term) {
    const needle = String(term || '')
      .trim()
      .toLowerCase();

    let visible = 0;

    for (const option of this.options) {
      const label = `${option.dataset.label || ''} ${option.textContent || ''}`.toLowerCase();
      const matches = needle === '' || label.includes(needle);

      const row = option.closest('li') || option;
      row.toggleAttribute('hidden', !matches);

      if (matches) visible += 1;
    }

    if (this.refs.empty instanceof HTMLElement) {
      this.refs.empty.toggleAttribute('hidden', visible > 0);
    }

    announce(
      visible > 0
        ? themeString('searchResultsCount', '', { count: visible })
        : themeString('localizationNoResults', '')
    );
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * @returns {HTMLElement|null}
   * @private
   */
  #selectedOption() {
    return (
      this.querySelector('[data-option][aria-selected="true"]') ||
      this.visibleOptions[0] ||
      null
    );
  }

  /**
   * @param {KeyboardEvent} event
   * @private
   */
  #onPanelKeydown = (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

    const options = this.visibleOptions;
    if (options.length === 0) return;

    event.preventDefault();

    const current = options.indexOf(document.activeElement);
    let next;

    switch (event.key) {
      case 'ArrowDown':
        next = current + 1 >= options.length ? 0 : current + 1;
        break;
      case 'ArrowUp':
        next = current <= 0 ? options.length - 1 : current - 1;
        break;
      case 'Home':
        next = 0;
        break;
      default:
        next = options.length - 1;
    }

    options[next].focus({ preventScroll: true });
    options[next].scrollIntoView({ block: 'nearest' });
  };
}

defineComponent('localization-form', LocalizationForm);

export default LocalizationForm;
