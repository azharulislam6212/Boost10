/**
 * Quantity price breaks: `<volume-pricing>` shows the tier table,
 * `<price-per-item>` the per-unit price the customer is about to pay, and
 * `<variant-cart-qty>` the quantity already in the cart — which counts toward
 * the tier, so all three read the same number.
 *
 * @module @theme/price-per-item
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { formatMoney, themeString } from '@theme/utilities';

/* ==========================================================================
   Shared reading
   ========================================================================== */

/**
 * @typedef {Object} PriceBreak
 * @property {number} quantity The minimum quantity the price applies from.
 * @property {number} price Unit price in cents at that quantity.
 */

/**
 * Parses the `[data-tiers]` payload an element carries, or borrows the one on
 * the `<volume-pricing>` in the same product.
 *
 * @param {Element} element
 * @returns {Map<string, PriceBreak[]>} Keyed by variant id, ascending by quantity.
 */
function readTiers(element) {
  /** @type {Map<string, PriceBreak[]>} */
  const map = new Map();
  const script = element.querySelector('script[data-tiers]');

  if (!script?.textContent) return map;

  /** @type {Array<{ id: number|string, tiers: PriceBreak[] }>} */
  let parsed = [];

  try {
    parsed = JSON.parse(script.textContent);
  } catch {
    console.warn('[Boost10] Volume pricing tiers could not be parsed.');
    return map;
  }

  for (const entry of parsed) {
    if (!entry?.id || !Array.isArray(entry.tiers)) continue;

    const tiers = entry.tiers
      .map((tier) => ({ quantity: Number(tier.quantity), price: Number(tier.price) }))
      .filter((tier) => Number.isFinite(tier.quantity) && Number.isFinite(tier.price))
      .sort((a, b) => a.quantity - b.quantity);

    if (tiers.length) map.set(String(entry.id), tiers);
  }

  return map;
}

/**
 * How many of a variant are already in the cart.
 *
 * @param {Object|null} state A cart object, as returned by Shopify.
 * @param {string|null} variantId
 * @returns {number}
 */
function cartQuantity(state, variantId) {
  if (!variantId || !Array.isArray(state?.items)) return 0;

  return state.items
    .filter((item) => String(item?.variant_id) === String(variantId))
    .reduce((total, item) => total + (Number(item?.quantity) || 0), 0);
}

/**
 * The last tier whose minimum has been met.
 *
 * @param {PriceBreak[]} tiers Ascending by quantity.
 * @param {number} quantity
 * @returns {PriceBreak|null}
 */
function tierFor(tiers, quantity) {
  let match = null;

  for (const tier of tiers) {
    if (quantity < tier.quantity) break;
    match = tier;
  }

  return match;
}

/* ==========================================================================
   The shared half of all three elements
   ========================================================================== */

/**
 * Tracks the selected variant, the quantity in the form and the quantity
 * already in the cart, and calls `render()` whenever any of them moves.
 *
 * @abstract
 */
class PriceBreakComponent extends BaseComponent {
  /** @type {Map<string, PriceBreak[]>} */
  #tiers = new Map();

  /** @type {string|null} */
  #variantId = null;

  /** Unit price of the selected variant, in cents, before any break. */
  #variantPrice = 0;

  /** What the quantity input is showing. */
  #quantity = 1;

  /** @type {Object|null} */
  #cart = null;

  setup() {
    this.#tiers = readTiers(this);
    this.#variantId = this.dataset.variantId || null;
    this.#variantPrice = Number(this.dataset.variantPrice) || 0;
    this.#cart = globalThis.Theme?.cart ?? null;
    this.#quantity = this.#readQuantity();

    const root = this.root;

    this.on(root, EVENTS.VARIANT_CHANGE, (event) => this.#onVariant(event.detail?.variant));
    this.on(root, EVENTS.VARIANT_READY, (event) => this.#onVariant(event.detail?.variant));
    this.on(root, EVENTS.QUANTITY_CHANGE, this.#onQuantityEvent);

    this.on(document, EVENTS.CART_UPDATED, this.#onCart);
    this.on(document, EVENTS.CART_ITEM_ADDED, this.#onCart);
    this.on(document, EVENTS.CART_ITEM_REMOVED, this.#onCart);

    // The stepper debounces its own event so the cart is not hammered. A price
    // the customer is reading as they type should not wait on that.
    const input = this.#quantityInput();
    if (input) this.on(input, 'input', () => this.#setQuantity(Number(input.value)));

    this.render();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {HTMLElement|Document}
   */
  get root() {
    return this.closest('[data-product-root]') || document;
  }

  /**
   * Tiers for the selected variant, borrowed from the `<volume-pricing>` in the
   * same product when this element carries none of its own.
   *
   * @returns {PriceBreak[]}
   */
  get tiers() {
    if (!this.#variantId) return [];

    const own = this.#tiers.get(this.#variantId);
    if (own) return own;

    // An empty map means this element was rendered without a payload of its
    // own, not that the variant has no breaks — read the owner's and keep it.
    if (this.#tiers.size === 0) {
      const owner = this.root.querySelector?.('volume-pricing');
      if (owner && owner !== this) this.#tiers = readTiers(owner);
    }

    return this.#tiers.get(this.#variantId) ?? [];
  }

  /**
   * Cart quantity plus what the form is about to add — the number Shopify will
   * price the line at.
   *
   * @returns {number}
   */
  get effectiveQuantity() {
    return this.inCart + Math.max(0, this.#quantity);
  }

  /**
   * @returns {number}
   */
  get inCart() {
    return cartQuantity(this.#cart, this.#variantId);
  }

  /**
   * @returns {number} Unit price in cents at the quantity in play.
   */
  get unitPrice() {
    return tierFor(this.tiers, this.effectiveQuantity)?.price ?? this.#variantPrice;
  }

  /**
   * @param {number} price Unit price in cents.
   * @returns {string}
   */
  money(price) {
    return formatMoney(price, this.dataset.moneyFormat);
  }

  /**
   * Whole percent saved against the variant's own price.
   *
   * @param {number} price Unit price in cents.
   * @returns {number}
   */
  savingPercent(price) {
    if (this.#variantPrice <= 0 || price >= this.#variantPrice) return 0;
    return Math.round(((this.#variantPrice - price) / this.#variantPrice) * 100);
  }

  /** Subclasses draw themselves here. */
  render() {}

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * @param {Object|null|undefined} variant
   * @private
   */
  #onVariant(variant) {
    if (!variant?.id) return;

    this.#variantId = String(variant.id);
    if (Number.isFinite(Number(variant.price))) this.#variantPrice = Number(variant.price);

    this.dataset.variantId = this.#variantId;
    this.render();
  }

  /**
   * @param {Event} event
   * @private
   */
  #onQuantityEvent = (event) => {
    const detail = /** @type {CustomEvent} */ (event).detail;

    // Cart lines carry a line or key and broadcast on the same event name.
    if (detail?.line != null || detail?.key) return;

    this.#setQuantity(Number(detail?.quantity));
  };

  /**
   * @param {Event} event
   * @private
   */
  #onCart = (event) => {
    const state = /** @type {CustomEvent} */ (event).detail?.cart;
    if (state) this.#cart = state;

    this.render();
  };

  /**
   * @param {number} value
   * @private
   */
  #setQuantity(value) {
    if (!Number.isFinite(value) || value < 0) return;
    if (value === this.#quantity) return;

    this.#quantity = value;
    this.render();
  }

  /**
   * @returns {HTMLInputElement|null}
   * @private
   */
  #quantityInput() {
    const input = this.root.querySelector?.('product-form [name="quantity"]');
    return input instanceof HTMLInputElement ? input : null;
  }

  /**
   * @returns {number}
   * @private
   */
  #readQuantity() {
    const value = Number(this.#quantityInput()?.value);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }
}

/* ==========================================================================
   <volume-pricing>
   ========================================================================== */

/** The tier table, with the tier currently in force marked. */
export class VolumePricing extends PriceBreakComponent {
  static requiredRefs = ['list'];

  /** Whether the merchant's row limit has been lifted by the customer. */
  #expanded = false;

  setup() {
    super.setup();

    if (this.refs.toggle instanceof HTMLButtonElement) {
      this.on(this.refs.toggle, 'click', () => {
        this.#expanded = !this.#expanded;
        this.render();
      });
    }
  }

  /**
   * @returns {number} Rows shown before the toggle hides the rest. 0 means all.
   */
  get limit() {
    const value = Number(this.dataset.visibleTiers);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  render() {
    const tiers = this.tiers;
    const list = this.refs.list;

    if (!(list instanceof HTMLElement)) return;

    this.hidden = tiers.length === 0;
    if (this.hidden) return;

    const active = tierFor(tiers, this.effectiveQuantity);
    const limit = this.#expanded ? 0 : this.limit;

    list.replaceChildren(
      ...tiers.map((tier, index) => this.#row(tier, tier === active, limit > 0 && index >= limit))
    );

    this.#renderToggle(tiers.length, limit);
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * @param {PriceBreak} tier
   * @param {boolean} active
   * @param {boolean} hidden
   * @returns {HTMLLIElement}
   * @private
   */
  #row(tier, active, hidden) {
    const row = document.createElement('li');
    row.className = 'volume-pricing__tier';
    row.dataset.quantity = String(tier.quantity);
    row.toggleAttribute('data-active', active);
    row.toggleAttribute('hidden', hidden);

    const quantity = document.createElement('span');
    quantity.className = 'volume-pricing__tier-quantity';
    quantity.textContent = themeString('volumeMinimum', `${tier.quantity}+`, {
      quantity: tier.quantity
    });

    const price = document.createElement('span');
    price.className = 'volume-pricing__tier-price';
    price.textContent = themeString('volumeEach', this.money(tier.price), {
      price: this.money(tier.price)
    });

    row.append(quantity, price);

    const percent = this.savingPercent(tier.price);

    if (percent > 0) {
      const saving = document.createElement('span');
      saving.className = 'volume-pricing__tier-saving';
      saving.textContent = themeString('volumeSavePercent', `-${percent}%`, { percent });
      row.append(saving);
    }

    return row;
  }

  /**
   * @param {number} total
   * @param {number} limit
   * @private
   */
  #renderToggle(total, limit) {
    const toggle = this.refs.toggle;
    if (!(toggle instanceof HTMLButtonElement)) return;

    const needed = this.limit > 0 && total > this.limit;

    toggle.hidden = !needed;
    if (!needed) return;

    toggle.textContent = this.#expanded
      ? themeString('volumeShowLess', 'Show less')
      : themeString('volumeShowMore', `Show all ${total}`, { count: total });

    toggle.setAttribute('aria-expanded', String(limit === 0));
  }
}

defineComponent('volume-pricing', VolumePricing);

/* ==========================================================================
   <price-per-item>
   ========================================================================== */

/** The per-unit price for the quantity the customer has chosen. */
export class PricePerItem extends PriceBreakComponent {
  static requiredRefs = ['amount'];

  render() {
    const tiers = this.tiers;

    this.hidden = tiers.length === 0;
    if (this.hidden) return;

    const price = this.unitPrice;

    this.refs.amount.textContent = themeString('volumeEach', this.money(price), {
      price: this.money(price)
    });

    const saving = this.refs.saving;
    if (!(saving instanceof HTMLElement)) return;

    const percent = this.savingPercent(price);

    saving.textContent = percent > 0 ? themeString('volumeSavePercent', `-${percent}%`, { percent }) : '';
    saving.hidden = percent === 0;
  }
}

defineComponent('price-per-item', PricePerItem);

/* ==========================================================================
   <variant-cart-qty>
   ========================================================================== */

/** "3 already in your cart" — the head start toward the next tier. */
export class VariantCartQty extends PriceBreakComponent {
  static requiredRefs = ['label'];

  render() {
    const quantity = this.inCart;

    this.hidden = quantity === 0;
    if (this.hidden) return;

    this.refs.label.textContent = themeString('volumeInCart', `${quantity} in your cart`, {
      count: quantity
    });
  }
}

defineComponent('variant-cart-qty', VariantCartQty);
