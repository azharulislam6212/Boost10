/**
 * variant-picker.js — Boost10
 *
 * `<variant-picker>`, `<variant-swatches>`, `<inventory-status>`,
 * `<product-sku>` and `<pickup-availability>`.
 *
 * `<back-in-stock-form>` moved to its own module: it is only ever on a product
 * page with something out of stock, so every other page was paying for it.
 *
 * The picker owns which variant is selected. Everything else on the product page
 * — the form, the gallery, the price, the inventory line — reads that state or
 * listens for `variant:change`. Nothing else computes it.
 *
 * Two rules shape the implementation:
 *
 *   The controls are real form inputs. Radio buttons and selects, inside the
 *   product form, with names Shopify understands. With JavaScript disabled the
 *   form still submits the chosen variant, and screen readers get a grouped set
 *   of radios rather than a set of divs pretending to be one.
 *
 *   Combinations that do not exist are marked, not removed. Hiding an
 *   unavailable size tells the customer nothing; showing it struck through with
 *   "Mango – unavailable" tells them the flavour exists and this size does not.
 *   Shopify's own `variant_url` behaviour depends on the value staying
 *   selectable, and removing options makes the picker jump under the cursor.
 *
 * @module @theme/variant-picker
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS, variantChangeDetail } from '@theme/events';
import { parseJSONScript, themeString, announce, debounce, fetchConfig, parseResponse, getRoute } from '@theme/utilities';
import { morph } from '@theme/morph';

/* ==========================================================================
   <variant-picker>
   ========================================================================== */

/**
 * Markup:
 *
 *   <variant-picker data-product-id="123" data-section-id="main-product" data-update-url="true">
 *     <script type="application/json" data-variants>[…]</script>
 *
 *     <fieldset data-option-index="1" data-option-name="Flavour">
 *       <legend>…</legend>
 *       <input type="radio" name="Flavour" value="Mango" id="…" checked>
 *       <label for="…">…</label>
 *     </fieldset>
 *
 *     <select name="id" data-ref="idInput" class="visually-hidden">…</select>
 *   </variant-picker>
 */
export class VariantPicker extends BaseComponent {
  /** @type {Object[]} */
  #variants = [];

  /** @type {Object|null} */
  #current = null;

  setup() {
    this.#variants = parseJSONScript(this.querySelector('[data-variants]')) || [];
    this.#current = this.#findVariant(this.selectedOptions) || this.#variants[0] || null;

    this.on(this, 'change', this.#onChange);

    this.#markAvailability();
    this.#syncIdInput();
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {Object|null} The selected variant, or null when the combination
   *   does not exist.
   */
  get currentVariant() {
    return this.#current;
  }

  /**
   * @returns {Object[]}
   */
  get variants() {
    return this.#variants;
  }

  /**
   * @returns {string[]} Option names in position order, e.g. ['Flavour', 'Size'].
   */
  get optionNames() {
    return Array.from(this.querySelectorAll('[data-option-name]')).map(
      (node) => node.dataset.optionName
    );
  }

  /**
   * @returns {string[]} The currently selected value for each option, in order.
   */
  get selectedOptions() {
    return Array.from(this.querySelectorAll('[data-option-index]')).map((group) => {
      const checked = group.querySelector('input:checked');
      if (checked instanceof HTMLInputElement) return checked.value;

      const select = group.querySelector('select');
      return select instanceof HTMLSelectElement ? select.value : '';
    });
  }

  /**
   * Select a variant by id.
   *
   * @param {number|string} id
   * @returns {boolean} True when the variant exists in this product.
   */
  selectVariant(id) {
    const variant = this.#variants.find((item) => String(item.id) === String(id));
    if (!variant) return false;

    for (const [index, value] of variant.options.entries()) {
      this.selectOption(index + 1, value, { silent: true });
    }

    this.#commit(variant);
    return true;
  }

  /**
   * Select one option value.
   *
   * @param {number} position One-based option position.
   * @param {string} value
   * @param {Object} [options]
   * @param {boolean} [options.silent=false] Skip the change broadcast.
   */
  selectOption(position, value, { silent = false } = {}) {
    const group = this.querySelector(`[data-option-index="${position}"]`);
    if (!group) return;

    const input = group.querySelector(`input[value="${CSS.escape(value)}"]`);
    if (input instanceof HTMLInputElement) {
      input.checked = true;
    } else {
      const select = group.querySelector('select');
      if (select instanceof HTMLSelectElement) select.value = value;
    }

    if (!silent) this.#onChange();
  }

  /**
   * @param {number|string} id
   * @returns {boolean}
   */
  isAvailable(id) {
    return Boolean(this.#variants.find((item) => String(item.id) === String(id))?.available);
  }

  /* ---------------------------------------------------------- internals -- */

  /** @private */
  #onChange = () => {
    const variant = this.#findVariant(this.selectedOptions);

    this.#markAvailability();
    this.#commit(variant);
  };

  /**
   * @param {Object|null|undefined} variant
   * @private
   */
  #commit(variant) {
    this.#current = variant || null;
    this.#syncIdInput();

    if (!variant) {
      // The combination does not exist. Say so rather than silently keeping the
      // last valid variant selected, which would let a customer add a product
      // they did not choose.
      const message = themeString('unavailable', '');
      announce(message);

      this.dispatch(
        EVENTS.VARIANT_UNAVAILABLE,
        { options: this.selectedOptions, productId: this.dataset.productId }
      );
      return;
    }

    this.#updateUrl(variant);

    this.dispatch(
      EVENTS.VARIANT_CHANGE,
      variantChangeDetail(variant, {
        options: this.selectedOptions,
        productId: this.dataset.productId,
        sectionId: this.dataset.sectionId
      })
    );

    announce(
      variant.available
        ? themeString('variantSelected', '', { variant: variant.title })
        : themeString('soldOut', '')
    );
  }

  /**
   * @param {string[]} options
   * @returns {Object|undefined}
   * @private
   */
  #findVariant(options) {
    return this.#variants.find((variant) =>
      variant.options.every((value, index) => value === options[index])
    );
  }

  /**
   * Mark each option value as available, sold out or non-existent.
   *
   * Availability is evaluated against the *other* currently selected options, so
   * "Large" is only marked sold out for the flavour the customer is actually
   * looking at.
   *
   * @private
   */
  #markAvailability() {
    const selected = this.selectedOptions;

    for (const group of this.querySelectorAll('[data-option-index]')) {
      const position = Number(group.dataset.optionIndex) - 1;

      for (const input of group.querySelectorAll('input[value], option[value]')) {
        const candidate = [...selected];
        candidate[position] = input.value;

        const match = this.#variants.find((variant) =>
          variant.options.every((value, index) => {
            if (index === position) return value === input.value;
            // Options the customer has not reached yet must not constrain this
            // one, or the second option looks entirely sold out on first load.
            return candidate[index] === undefined || value === candidate[index];
          })
        );

        const exists = Boolean(match);
        const available = Boolean(match?.available);

        input.toggleAttribute('data-unavailable', !available);
        input.toggleAttribute('data-nonexistent', !exists);

        const label = input.labels?.[0] || group.querySelector(`label[for="${input.id}"]`);
        if (label) {
          label.toggleAttribute('data-unavailable', !available);
          label.setAttribute(
            'title',
            available ? '' : themeString('unavailableWithOption', '', { value: input.value })
          );
        }

        // Never disabled: a disabled radio cannot be focused, so a keyboard user
        // can no longer discover that the value exists at all.
        if (input instanceof HTMLOptionElement) input.toggleAttribute('data-disabled', !available);
      }
    }
  }

  /** @private */
  #syncIdInput() {
    const input = this.refs.idInput || this.closest('form')?.querySelector('[name="id"]');
    if (!input) return;

    input.value = this.#current ? String(this.#current.id) : '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Keep the address bar on the selected variant, so the page can be shared,
   * bookmarked and refreshed onto the same choice.
   *
   * `replaceState`, not `pushState`: flicking through five flavours should not
   * put five entries in the history stack for the Back button to walk through.
   *
   * @param {Object} variant
   * @private
   */
  #updateUrl(variant) {
    if (this.dataset.updateUrl === 'false') return;

    const url = new URL(window.location.href);
    url.searchParams.set('variant', String(variant.id));
    window.history.replaceState({ variant: variant.id }, '', `${url.pathname}${url.search}`);
  }
}

defineComponent('variant-picker', VariantPicker);

/* ==========================================================================
   <variant-swatches>
   ========================================================================== */

/**
 * Swatch presentation for one option.
 *
 * The inputs are the same radios the picker reads; this element only manages
 * what a swatch looks like and how many are shown before the "more" control.
 * The visual itself is produced by `snippets/swatch.liquid` from the merchant's
 * `Name=#hexcode` map — including for a **Flavour** option, since the option
 * names that get swatches are a setting rather than a hardcoded "Color".
 *
 * Markup:
 *
 *   <variant-swatches data-max-visible="5">
 *     <input type="radio" name="Flavour" value="Mango" id="…">
 *     <label for="…">{% render 'swatch', value: 'Mango' %}</label>
 *     <button data-ref="more" hidden>…</button>
 *   </variant-swatches>
 */
export class VariantSwatches extends BaseComponent {
  setup() {
    this.#applyLimit();

    if (this.refs.more) {
      this.on(this.refs.more, 'click', () => this.expand());
    }

    // Hover previewing is opt-in, and never on touch, where "hover" fires on tap
    // and would change the selection the customer was about to make.
    if (this.dataset.trigger === 'hover' && window.matchMedia('(hover: hover)').matches) {
      this.on(this, 'pointerenter', this.#onPreview, { capture: true });
    }
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * @returns {HTMLElement[]}
   */
  get swatches() {
    return Array.from(this.querySelectorAll('[data-swatch-item]'));
  }

  /**
   * Reveal every swatch.
   */
  expand() {
    for (const item of this.swatches) item.removeAttribute('hidden');
    this.refs.more?.setAttribute('hidden', '');
    this.setAttribute('data-expanded', '');

    // Focus the first newly revealed swatch, or pressing "+3 more" leaves a
    // keyboard user on a button that has just disappeared.
    const limit = Number(this.dataset.maxVisible) || 5;
    this.swatches[limit]?.querySelector('input')?.focus({ preventScroll: true });
  }

  /* ---------------------------------------------------------- internals -- */

  /** @private */
  #applyLimit() {
    const limit = Number(this.dataset.maxVisible) || 0;
    const items = this.swatches;

    if (limit <= 0 || items.length <= limit) {
      this.refs.more?.setAttribute('hidden', '');
      return;
    }

    for (const [index, item] of items.entries()) {
      // The selected swatch is always shown, even past the limit: hiding the
      // customer's own choice behind "show more" is disorienting.
      const isSelected = item.querySelector('input')?.checked;
      item.toggleAttribute('hidden', index >= limit && !isSelected);
    }

    if (this.refs.more instanceof HTMLElement) {
      this.refs.more.hidden = false;
      this.refs.more.textContent = themeString('swatchesMore', '', {
        count: items.length - limit
      });
    }
  }

  /**
   * @param {PointerEvent} event
   * @private
   */
  #onPreview = (event) => {
    const input = event.target instanceof Element ? event.target.closest('label')?.control : null;
    if (!(input instanceof HTMLInputElement) || input.checked) return;

    const picker = this.closest('variant-picker');
    const variant = picker?.variants?.find((item) => item.options.includes(input.value));
    const mediaId = variant?.featured_media?.id;
    if (!mediaId) return;

    // Preview only: the gallery moves, the selection does not.
    document.querySelector('media-gallery')?.goToMedia?.(mediaId, { animate: false });
  };
}

defineComponent('variant-swatches', VariantSwatches);

/* ==========================================================================
   <inventory-status>
   ========================================================================== */

/**
 * The stock line under the buy button.
 *
 * Reads the selected variant's inventory from the picker's own variant data, so
 * there is no second request and no second source of truth. Quantities are never
 * shown above the low-stock threshold: "312 in stock" is information a customer
 * did not ask for and a competitor did.
 *
 * Markup:
 *
 *   <inventory-status data-threshold="10">
 *     <span data-ref="label"></span>
 *   </inventory-status>
 */
export class InventoryStatus extends BaseComponent {
  static requiredRefs = ['label'];

  setup() {
    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => this.render(event.detail?.variant));

    const picker = this.root.querySelector?.('variant-picker');
    if (picker?.currentVariant) this.render(picker.currentVariant);
  }

  /**
   * @returns {HTMLElement|Document}
   */
  get root() {
    return this.closest('[data-product-root]') || document;
  }

  /**
   * @param {Object|null} variant
   */
  render(variant) {
    if (!variant) {
      this.hidden = true;
      return;
    }

    const threshold = Number(this.dataset.threshold) || 10;
    const managed = Boolean(variant.inventory_management);
    const quantity = Number(variant.inventory_quantity);

    let state = 'in-stock';
    let label = themeString('inStock', '');

    if (!variant.available) {
      state = 'out-of-stock';
      label = themeString('soldOut', '');
    } else if (managed && variant.inventory_policy === 'continue' && quantity <= 0) {
      state = 'backordered';
      label = themeString('backordered', '');
    } else if (managed && Number.isFinite(quantity) && quantity > 0 && quantity <= threshold) {
      state = 'low-stock';
      label = themeString('lowStockCount', '', { count: quantity });
    }

    this.hidden = false;
    this.dataset.state = state;
    this.refs.label.textContent = label;

    this.#renderBar(state, quantity, threshold);
  }

  /**
   * The bar only appears at or below the threshold.
   *
   * A bar reading nearly full is scarcity pointing the wrong way: it tells a
   * customer there is plenty of time. Above the threshold the element reports
   * "in stock" and nothing else.
   *
   * @param {string} state
   * @param {number} quantity
   * @param {number} threshold
   * @private
   */
  #renderBar(state, quantity, threshold) {
    const bar = this.refs.bar;
    if (!(bar instanceof HTMLElement)) return;

    if (state !== 'low-stock' || !Number.isFinite(quantity) || threshold <= 0) {
      bar.hidden = true;
      return;
    }

    const percent = Math.max(4, Math.min(100, Math.round((quantity / threshold) * 100)));

    bar.hidden = false;
    bar.style.setProperty('--stock-percent', `${percent}%`);
    bar.setAttribute('aria-valuemax', String(threshold));
    bar.setAttribute('aria-valuenow', String(quantity));
    bar.setAttribute('aria-label', themeString('lowStockCount', '', { count: quantity }));
  }
}

defineComponent('inventory-status', InventoryStatus);

/* ==========================================================================
   <product-sku>
   ========================================================================== */

/**
 * The SKU or barcode line, updated when the variant changes.
 *
 * Read from the variant data the picker already holds, so there is no second
 * request and no second source of truth.
 *
 * The whole element is hidden when the selected variant has no SKU, rather than
 * showing a label with nothing after it. Many stores fill SKUs in for some
 * variants and not others, and "SKU:" followed by empty space reads as a broken
 * page rather than as missing data.
 *
 * Markup:
 *
 *   <product-sku data-field="sku">
 *     <span class="product-sku__label">SKU</span>
 *     <span data-ref="value">ABC-123</span>
 *   </product-sku>
 */
export class ProductSku extends BaseComponent {
  static requiredRefs = ['value'];

  setup() {
    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => this.render(event.detail?.variant));
    this.on(this.root, EVENTS.VARIANT_UNAVAILABLE, () => this.render(null));

    const picker = this.root.querySelector?.('variant-picker');
    if (picker?.currentVariant) this.render(picker.currentVariant);
  }

  /**
   * @returns {HTMLElement|Document}
   */
  get root() {
    return this.closest('[data-product-root]') || document;
  }

  /**
   * @returns {'sku'|'barcode'}
   */
  get field() {
    return this.dataset.field === 'barcode' ? 'barcode' : 'sku';
  }

  /**
   * @param {Object|null} variant
   */
  render(variant) {
    const value = variant?.[this.field];

    if (!value) {
      this.hidden = true;
      this.refs.value.textContent = '';
      return;
    }

    this.hidden = false;
    this.refs.value.textContent = value;
  }
}

defineComponent('product-sku', ProductSku);

/* ==========================================================================
   <pickup-availability>
   ========================================================================== */

/**
 * Local pickup availability for the selected variant.
 *
 * Shopify renders this itself: the theme requests
 * `/variants/{id}/?section_id=pickup-availability` and Shopify returns the
 * current availability for every location, already translated and already
 * respecting the merchant's pickup settings. Nothing is computed here, because
 * nothing here can know a store's opening hours or stock by location.
 *
 * Fetched on variant change rather than on page load, and only when the variant
 * is actually available — asking about pickup for a sold-out variant returns an
 * empty panel and costs a request.
 *
 * Markup:
 *
 *   <pickup-availability data-base-url="/" data-variant-id="123" data-available="true">
 *     <div data-ref="content"></div>
 *   </pickup-availability>
 */
export class PickupAvailability extends BaseComponent {
  /** @type {AbortController|null} */
  #request = null;

  setup() {
    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => this.fetchFor(event.detail?.variant));
    this.on(this.root, EVENTS.VARIANT_UNAVAILABLE, () => this.clear());

    // Opening the drawer is delegated, so the markup Shopify returns needs no
    // wiring of its own.
    this.on(this, 'click', (event) => {
      const trigger = event.target instanceof Element ? event.target.closest('[data-pickup-open]') : null;
      if (!trigger) return;

      event.preventDefault();
      this.querySelector('drawer-component')?.open?.(trigger);
    });

    const picker = this.root.querySelector?.('variant-picker');
    if (picker?.currentVariant) this.fetchFor(picker.currentVariant);
  }

  teardown() {
    this.#request?.abort();
    this.#request = null;
  }

  /**
   * @returns {HTMLElement|Document}
   */
  get root() {
    return this.closest('[data-product-root]') || document;
  }

  /**
   * @param {Object|null} variant
   * @returns {Promise<boolean>}
   */
  async fetchFor(variant) {
    if (!variant?.available) {
      this.clear();
      return false;
    }

    this.#request?.abort();
    this.#request = new AbortController();

    const base = this.dataset.baseUrl || window.Theme?.routes?.rootUrl || '/';
    const url = `${base}variants/${variant.id}/?section_id=pickup-availability`;

    try {
      const response = await fetch(url, { signal: this.#request.signal, headers: { Accept: 'text/html' } });
      if (!response.ok) throw new Error(String(response.status));

      const html = await response.text();
      const next = new DOMParser()
        .parseFromString(html, 'text/html')
        .querySelector('[data-pickup-content]');

      if (!next || next.children.length === 0) {
        this.clear();
        return false;
      }

      const target = this.refs.content instanceof HTMLElement ? this.refs.content : this;
      morph(target, next, { childrenOnly: true });

      this.hidden = false;
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;

      // Pickup information is supplementary. A failure hides it rather than
      // putting an error where a store address should be.
      console.warn('[Boost10] Pickup availability could not be loaded.', error);
      this.clear();
      return false;
    } finally {
      this.#request = null;
    }
  }

  /**
   * Hide and empty the panel.
   */
  clear() {
    this.hidden = true;
    if (this.refs.content instanceof HTMLElement) this.refs.content.replaceChildren();
  }
}

defineComponent('pickup-availability', PickupAvailability);

export default {
  VariantPicker,
  VariantSwatches,
  InventoryStatus,
  ProductSku,
  PickupAvailability
};
