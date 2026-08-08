/**
 * customer-addresses.js — Boost10
 *
 * `<customer-address-form>` — the address book on `/account/addresses`.
 *
 * Shopify's address forms are ordinary POST forms with `_method` overrides for
 * update and delete. They are not AJAX endpoints, and there is no JSON API for
 * them. So this element does not intercept submission: it lets the form post and
 * the page reload, which is what Shopify expects and what keeps flash messages,
 * validation errors and redirects working.
 *
 * What it does add:
 *
 *   - Province lists that follow the selected country, from data Shopify
 *     renders into the page. Getting this wrong is how customers end up unable
 *     to save an address for their own country.
 *   - Optional modal editing, so the address book does not become a wall of
 *     expanded forms.
 *   - A delete confirmation, because deletion is irreversible and the native
 *     `confirm()` dialog cannot be styled or translated consistently.
 *   - Focus management: opening a form focuses its first field, cancelling
 *     returns focus to the control that opened it.
 *
 * Markup:
 *
 *   <customer-address-form data-modal="true">
 *     <button data-ref="newTrigger" data-address-open="new">…</button>
 *
 *     <div data-address-form="new" hidden>
 *       <form method="post" action="/account/addresses">
 *         <select data-country name="address[country]" data-default="United Kingdom">…</select>
 *         <div data-province-wrapper>
 *           <select data-province name="address[province]"></select>
 *         </div>
 *         <button type="button" data-address-cancel>…</button>
 *       </form>
 *     </div>
 *
 *     <li data-address-item>
 *       <button data-address-open="123">…</button>
 *       <form method="post" action="/account/addresses/123" data-address-delete>
 *         <input type="hidden" name="_method" value="delete">
 *         <button type="submit" data-address-delete-trigger>…</button>
 *       </form>
 *     </li>
 *   </customer-address-form>
 *
 * @module @theme/customer-addresses
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { getFocusableElements, themeString, announce, parseJSONScript } from '@theme/utilities';

export class CustomerAddressForm extends BaseComponent {
  /** The control that opened the form currently showing. */
  #opener = null;

  setup() {
    this.#initCountries();

    this.on(this, 'click', this.#onClick);
    this.on(this, 'change', this.#onChange);

    this.on(this, 'keydown', (event) => {
      if (event.key !== 'Escape') return;
      const open = this.querySelector('[data-address-form]:not([hidden])');
      if (!open) return;

      event.preventDefault();
      this.close(open.dataset.addressForm);
    });
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {boolean}
   */
  get usesModal() {
    return this.dataset.modal === 'true';
  }

  /**
   * Show an address form.
   *
   * @param {string} id `new`, or an address id.
   * @param {HTMLElement} [opener] Focus returns here on close.
   */
  open(id, opener) {
    const form = this.querySelector(`[data-address-form="${CSS.escape(id)}"]`);
    if (!(form instanceof HTMLElement)) return;

    // One at a time: two open address forms are two sets of identical field
    // labels, and a screen reader cannot tell them apart.
    for (const other of this.querySelectorAll('[data-address-form]')) {
      if (other !== form) other.hidden = true;
    }

    this.#opener = opener instanceof HTMLElement ? opener : null;
    this.#opener?.setAttribute('aria-expanded', 'true');

    form.hidden = false;
    this.setAttribute('data-editing', id);

    if (this.usesModal) {
      form.closest('modal-dialog')?.open?.(this.#opener);
      return;
    }

    const first = getFocusableElements(form)[0];
    first?.focus({ preventScroll: true });
  }

  /**
   * Hide an address form and return focus.
   *
   * @param {string} id
   */
  close(id) {
    const form = this.querySelector(`[data-address-form="${CSS.escape(id)}"]`);
    if (form instanceof HTMLElement) form.hidden = true;

    this.removeAttribute('data-editing');

    if (this.usesModal) {
      form?.closest('modal-dialog')?.close?.();
    }

    this.#opener?.setAttribute('aria-expanded', 'false');
    this.#opener?.focus({ preventScroll: true });
    this.#opener = null;
  }

  /**
   * Confirm and submit a deletion.
   *
   * @param {HTMLFormElement} form
   */
  confirmDelete(form) {
    const label = form.dataset.addressLabel || '';
    const message = themeString('addressDeleteConfirm', '', { address: label });

    // A native confirm is used deliberately. It cannot be styled, but it is
    // keyboard accessible everywhere, cannot be missed, and cannot be dismissed
    // by a stray click — which matters for an irreversible action.
    if (!window.confirm(message)) return;

    form.submit();
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @param {MouseEvent} event
   * @private
   */
  #onClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const opener = target.closest('[data-address-open]');
    if (opener instanceof HTMLElement) {
      event.preventDefault();
      this.open(opener.dataset.addressOpen, opener);
      return;
    }

    const cancel = target.closest('[data-address-cancel]');
    if (cancel instanceof HTMLElement) {
      event.preventDefault();
      this.close(cancel.closest('[data-address-form]')?.dataset.addressForm || 'new');
      return;
    }

    const remove = target.closest('[data-address-delete-trigger]');
    if (remove instanceof HTMLElement) {
      event.preventDefault();
      const form = remove.closest('form[data-address-delete]');
      if (form instanceof HTMLFormElement) this.confirmDelete(form);
    }
  };

  /**
   * @param {Event} event
   * @private
   */
  #onChange = (event) => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.hasAttribute('data-country')) return;

    this.#syncProvinces(select);
  };

  /**
   * Populate every province select on first render.
   *
   * @private
   */
  #initCountries() {
    for (const select of this.querySelectorAll('select[data-country]')) {
      // Shopify renders the saved country as `data-default`, and the option list
      // itself only after `country_option_tags` has run.
      if (select.dataset.default) select.value = select.dataset.default;
      this.#syncProvinces(select);
    }
  }

  /**
   * Rebuild the province select for the selected country.
   *
   * Countries with no provinces hide the field entirely rather than showing an
   * empty dropdown, which customers read as a required field they cannot fill.
   *
   * @param {HTMLSelectElement} countrySelect
   * @private
   */
  #syncProvinces(countrySelect) {
    const group = countrySelect.closest('form') || this;
    const province = group.querySelector('select[data-province]');
    if (!(province instanceof HTMLSelectElement)) return;

    const option = countrySelect.selectedOptions[0];
    const provinces = parseJSONScript(option) || this.#parseAttribute(option);
    const wrapper = province.closest('[data-province-wrapper]');

    if (!Array.isArray(provinces) || provinces.length === 0) {
      province.replaceChildren();
      province.disabled = true;
      wrapper?.setAttribute('hidden', '');
      return;
    }

    const selected = province.dataset.default || province.value;

    province.replaceChildren(
      ...provinces.map(([value, label]) => {
        const node = document.createElement('option');
        node.value = value;
        node.textContent = label;
        return node;
      })
    );

    province.disabled = false;
    wrapper?.removeAttribute('hidden');

    if (selected) province.value = selected;
  }

  /**
   * Shopify writes the province list into `data-provinces` on each country
   * option as a JSON array.
   *
   * @param {HTMLOptionElement|undefined} option
   * @returns {Array|null}
   * @private
   */
  #parseAttribute(option) {
    const raw = option?.getAttribute('data-provinces');
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch {
      // A malformed list must not break the whole form.
      console.warn('[Boost10] Could not parse the province list for this country.');
      return null;
    }
  }
}

defineComponent('customer-address-form', CustomerAddressForm);

export default CustomerAddressForm;
