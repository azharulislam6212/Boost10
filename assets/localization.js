/**
 * localization.js — Boost10
 *
 * `<localization-form>` — the country/region and language selectors.
 *
 * Shopify's localization form is a real `<form>` posting to
 * `/localization`, containing a hidden input and one submit button per option.
 * That is the only supported way to change market or locale, and it works with
 * JavaScript disabled. This element does not replace it — it wraps it, turning a
 * list of a hundred and fifty submit buttons into a searchable disclosure.
 *
 * The list is rendered by Liquid from `localization.available_countries`, with
 * flags, currency codes and localised country names already in place. Nothing is
 * fetched and nothing is sorted here; the filter only hides rows.
 *
 * Accessibility: the trigger is a real button with `aria-expanded`, the panel is
 * a listbox of buttons, Escape closes and returns focus, and the filtered count
 * is announced so a screen reader user knows the list changed under them.
 *
 * Markup:
 *
 *   <localization-form data-type="country">
 *     <form method="post" action="{{ routes.root_url }}localization" id="CountryForm">
 *       <input type="hidden" name="_method" value="put">
 *       <input type="hidden" name="country_code" value="{{ localization.country.iso_code }}" data-ref="input">
 *
 *       <button type="button" data-ref="trigger" aria-expanded="false" aria-controls="CountryPanel">…</button>
 *
 *       <div data-ref="panel" id="CountryPanel" hidden>
 *         <input type="search" data-ref="filter">
 *         <ul data-ref="list" role="listbox">
 *           <li><button type="submit" name="country_code" value="GB" data-option data-label="United Kingdom">…</button></li>
 *         </ul>
 *         <p data-ref="empty" hidden>…</p>
 *       </div>
 *     </form>
 *   </localization-form>
 *
 * @module @theme/localization
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { debounce, themeString, announce, getFocusableElements } from '@theme/utilities';


export class LocalizationForm extends BaseComponent {
  static requiredRefs = ['trigger', 'panel'];

  setup() {
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

      // The field is always shown, and the threshold that used to hide it is
      // gone.
      //
      // It was a reasonable-sounding rule — a search box over a handful of
      // options is noise, and on a phone it opens a keyboard over the very list
      // it is meant to help with — and it was wrong here for one reason: what a
      // customer looks for in this control is a currency, and a store selling in
      // two markets is exactly where the field disappeared. The search box was
      // in the markup the whole time and simply never rendered.
      this.refs.filter.closest('[data-filter-wrapper]')?.removeAttribute('hidden');
    }

    // Arrow keys move through the options once the panel is open.
    this.on(this.refs.panel, 'keydown', this.#onPanelKeydown);
  }

  /* --------------------------------------------------------- public API -- */

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

    // Two open selectors overlap and neither is usable.
    for (const other of document.querySelectorAll('localization-form[data-open]')) {
      if (other !== this) other.close?.();
    }

    this.setAttribute('data-open', '');
    this.refs.panel.hidden = false;
    this.refs.trigger.setAttribute('aria-expanded', 'true');

    const first = this.refs.filter instanceof HTMLElement ? this.refs.filter : this.#selectedOption();
    first?.focus({ preventScroll: true });
  }

  close() {
    if (!this.isOpen) {
      this.refs.panel.hidden = true;
      this.refs.trigger.setAttribute('aria-expanded', 'false');
      return;
    }

    this.removeAttribute('data-open');
    this.refs.panel.hidden = true;
    this.refs.trigger.setAttribute('aria-expanded', 'false');
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
   * Matching is done on `data-label`, which Liquid renders with the localised
   * country name. Matching on the button's text would also match the currency
   * code, so typing "USD" would surface every country that happens to use it —
   * which is occasionally useful and mostly confusing.
   *
   * @param {string} term
   */
  filter(term) {
    const needle = String(term || '')
      .trim()
      .toLowerCase();

    let visible = 0;

    for (const option of this.options) {
      // `data-label` first, then the row's own text — which is what carries the
      // currency code. Matching only `data-label` meant typing "USD" found
      // nothing, in the one control where a currency is what people search for.
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

  /* ---------------------------------------------------------- internals -- */

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
