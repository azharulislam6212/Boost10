/**
 * cart-shipping.js — Boost10
 *
 * `<shipping-calculator>` — an estimate of shipping rates before checkout.
 *
 * Uses `/cart/shipping_rates.json`, which returns the merchant's real configured
 * rates for a destination. It is an estimate only: the final price depends on
 * the checkout address and on any rate adjustments Shopify applies there, which
 * is why every result is labelled as an estimate rather than a quote.
 *
 * The country and province selects are rendered by Liquid with real `<option>`
 * elements, so the form works without JavaScript and the province list is
 * correct on first paint. This module only keeps the province select in step
 * with the country and performs the lookup.
 *
 * Markup:
 *
 *   <shipping-calculator>
 *     <select data-ref="country" name="country">…</select>
 *     <select data-ref="province" name="province" data-provinces='{"United Kingdom":[…]}'>…</select>
 *     <input data-ref="zip" name="zip">
 *     <button data-ref="submit" type="button">Calculate</button>
 *     <div data-ref="results" role="status"></div>
 *   </shipping-calculator>
 *
 * @module @theme/cart-shipping
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { getRoute, formatMoney, themeString, announce, announceUrgent, parseJSONScript } from '@theme/utilities';

export class ShippingCalculator extends BaseComponent {
  static requiredRefs = ['country', 'zip', 'submit'];

  /** @type {AbortController|null} */
  #request = null;

  setup() {
    this.on(this.refs.submit, 'click', () => this.calculate());
    this.on(this.refs.country, 'change', () => this.#syncProvinces());

    this.on(this.refs.zip, 'keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.calculate();
    });

    this.#syncProvinces();
  }

  teardown() {
    this.#request?.abort();
    this.#request = null;
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * Look up rates for the entered destination.
   *
   * @returns {Promise<Array>} The rates returned by Shopify.
   */
  async calculate() {
    const country = this.refs.country.value;
    const province = this.refs.province?.value || '';
    const zip = this.refs.zip.value.trim();

    this.#request?.abort();
    this.#request = new AbortController();

    this.#busy(true);
    this.#clear();

    const params = new URLSearchParams({
      'shipping_address[country]': country,
      'shipping_address[province]': province,
      'shipping_address[zip]': zip
    });

    try {
      const response = await fetch(`${getRoute('cart')}/shipping_rates.json?${params}`, {
        signal: this.#request.signal,
        headers: { Accept: 'application/json' }
      });

      const data = await response.json();

      if (!response.ok) {
        // Shopify returns field-level errors here, for instance an invalid
        // postcode for the selected country. They are more useful than a generic
        // failure, so they are surfaced verbatim.
        this.#renderErrors(data);
        return [];
      }

      const rates = data.shipping_rates || [];
      this.#renderRates(rates, [country, province, zip].filter(Boolean).join(', '));

      return rates;
    } catch (error) {
      if (error?.name === 'AbortError') return [];

      const message = themeString('shippingError', '');
      this.#renderMessage(message, true);
      announceUrgent(message);
      return [];
    } finally {
      this.#busy(false);
      this.#request = null;
    }
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * Repopulate the province select for the selected country, and hide it
   * entirely for countries that have none.
   *
   * @private
   */
  #syncProvinces() {
    const select = this.refs.province;
    if (!(select instanceof HTMLSelectElement)) return;

    const map = parseJSONScript(this.querySelector('[data-provinces]')) || {};
    const provinces = map[this.refs.country.value] || [];

    if (provinces.length === 0) {
      select.replaceChildren();
      select.closest('[data-province-wrapper]')?.setAttribute('hidden', '');
      select.disabled = true;
      return;
    }

    select.closest('[data-province-wrapper]')?.removeAttribute('hidden');
    select.disabled = false;

    const options = provinces.map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    });

    select.replaceChildren(...options);
  }

  /**
   * @param {Array} rates
   * @param {string} address
   * @private
   */
  #renderRates(rates, address) {
    const container = this.refs.results;
    if (!(container instanceof HTMLElement)) return;

    if (rates.length === 0) {
      this.#renderMessage(themeString('shippingNoRates', ''));
      return;
    }

    const heading = document.createElement('p');
    heading.className = 'shipping-calculator__heading';
    heading.textContent = themeString('shippingRatesFound', '', {
      count: rates.length,
      address
    });

    const list = document.createElement('ul');
    list.className = 'shipping-calculator__list';
    list.setAttribute('role', 'list');

    for (const rate of rates) {
      const item = document.createElement('li');
      item.className = 'shipping-calculator__rate';

      const name = document.createElement('span');
      name.className = 'shipping-calculator__rate-name';
      name.textContent = rate.presentment_name || rate.name;

      const price = document.createElement('span');
      price.className = 'shipping-calculator__rate-price';
      price.textContent = formatMoney(Number(rate.price) * 100);

      item.append(name, price);
      list.appendChild(item);
    }

    container.replaceChildren(heading, list);
    announce(heading.textContent);
  }

  /**
   * @param {Object} data
   * @private
   */
  #renderErrors(data) {
    const messages = Object.values(data || {})
      .flat()
      .filter(Boolean);

    this.#renderMessage(messages.join('. ') || themeString('shippingError', ''), true);
    announceUrgent(messages[0] || themeString('shippingError', ''));
  }

  /**
   * @param {string} text
   * @param {boolean} [isError=false]
   * @private
   */
  #renderMessage(text, isError = false) {
    const container = this.refs.results;
    if (!(container instanceof HTMLElement)) return;

    const paragraph = document.createElement('p');
    paragraph.className = isError
      ? 'shipping-calculator__message shipping-calculator__message--error'
      : 'shipping-calculator__message';
    paragraph.textContent = text;

    container.replaceChildren(paragraph);
  }

  /** @private */
  #clear() {
    if (this.refs.results instanceof HTMLElement) this.refs.results.replaceChildren();
  }

  /**
   * @param {boolean} busy
   * @private
   */
  #busy(busy) {
    this.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (this.refs.submit instanceof HTMLButtonElement) this.refs.submit.disabled = busy;
  }
}

defineComponent('shipping-calculator', ShippingCalculator);

export default ShippingCalculator;
