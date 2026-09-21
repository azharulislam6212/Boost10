/**
 * `<product-bundle>` — the tray in `sections/product-bundle.liquid`.
 *
 * @module @theme/product-bundle
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { cart } from '@theme/cart-drawer';
import { announce, announceUrgent, clamp, formatMoney, parseJSONScript, themeString, wait } from '@theme/utilities';

/** How long a row's spinner turns for at minimum, in milliseconds. */
const MIN_SPIN = 420;

/**
 * One entry in the tray.
 *
 * @typedef {Object} BundleItem
 * @property {number} productId
 * @property {number} variantId
 * @property {string} title
 * @property {string} [variantTitle]
 * @property {string} image
 * @property {number} price Cents, per unit.
 * @property {number} quantity
 */

/**
 * What one slot's discount is, as the merchant configured it.
 *
 * @typedef {Object} SlotDiscount
 * @property {number} slot One-based slot position.
 * @property {string} code Discount code, or an empty string.
 * @property {'percentage'|'amount'} type
 * @property {number} value Percent, or cents per item when `type` is `amount`.
 */

/**
 * A slot, resolved: what is in it and what it costs.
 *
 * @typedef {Object} BundleSlot
 * @property {number} index One-based slot position.
 * @property {BundleItem} item
 * @property {SlotDiscount|null} discount
 * @property {number} subtotal Cents, before any discount.
 * @property {number} total Cents, after it.
 * @property {number} percent The percentage that produced `total`, for the line property.
 */

/**
 * How many of this row the customer asked for.
 *
 * @param {HTMLElement} row
 * @returns {number}
 */
function quantityOf(row) {
  const input = row.querySelector('[data-bundle-quantity] [data-ref="input"]');
  if (!(input instanceof HTMLInputElement)) return 1;

  const value = Math.round(Number(input.value));
  if (!Number.isFinite(value)) return 1;

  const min = Math.max(1, Number(input.min) || 1);
  const max = Number(input.max) || Infinity;

  return clamp(value, min, max);
}

export class ProductBundle extends BaseComponent {
  static requiredRefs = ['slots', 'submit', 'total'];

  /** @type {BundleItem[]} */
  #items = [];

  /**
   * The merchant's per-slot discounts, keyed by one-based slot position.
   *
   * @type {Map<number, SlotDiscount>}
   */
  #discounts = new Map();

  setup() {
    this.#readDiscounts();

    this.delegate('click', '[data-bundle-add]', (event, target) => {
      event.preventDefault();
      this.#onRowToggle(target);
    });

    this.delegate('click', '[data-slot-remove]', (event, target) => {
      event.preventDefault();
      this.#removeAt(this.#slotIndexOf(target));
    });

    this.delegate('click', '[data-slot-increase]', (event, target) => {
      event.preventDefault();
      this.#step(this.#slotIndexOf(target), 1);
    });

    this.delegate('click', '[data-slot-decrease]', (event, target) => {
      event.preventDefault();
      this.#step(this.#slotIndexOf(target), -1);
    });

    this.delegate('click', '[data-slot-fill]', (event) => {
      event.preventDefault();
      this.#focusPicker();
    });

    this.on(this.refs.submit, 'click', () => this.addToCart());

    this.#bindQuickAdd();
    this.render();
  }

  teardown() {
    this.#clearPending();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /** @returns {number} How many slots the tray has. */
  get size() {
    return Number(this.dataset.size) || 0;
  }

  /** @returns {BundleItem[]} A copy — the tray's own array is never handed out. */
  get items() {
    return this.#items.map((item) => ({ ...item }));
  }

  /** @returns {number} Total units in the tray, not distinct products. */
  get count() {
    return this.#items.reduce((total, item) => total + item.quantity, 0);
  }

  /** @returns {boolean} */
  get isFull() {
    return this.#items.length >= this.size;
  }

  /**
   * Discount tiers, ascending, parsed from `quantity:percent,…`.
   *
   * @returns {{ quantity: number, percent: number }[]}
   */
  get tiers() {
    return (this.dataset.tiers || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [quantity, percent] = part.split(':');
        return { quantity: Number(quantity), percent: Number(percent) };
      })
      .filter((tier) => Number.isFinite(tier.quantity) && Number.isFinite(tier.percent))
      .sort((a, b) => a.quantity - b.quantity);
  }

  /** @returns {number} Subtotal in cents, before any discount. */
  get subtotal() {
    return this.#items.reduce((total, item) => total + item.price * item.quantity, 0);
  }

  /**
   * The discount configured for a slot, if it has one of its own.
   *
   * @param {number} index Zero-based index into the tray.
   * @returns {SlotDiscount|null}
   */
  discountFor(index) {
    return this.#discounts.get(index + 1) || null;
  }

  /**
   * Every filled slot, with what it costs and why.
   *
   * @returns {BundleSlot[]}
   */
  get slots() {
    const ladder = this.percent;

    return this.#items.map((item, index) => {
      const subtotal = item.price * item.quantity;
      const discount = this.discountFor(index);

      const prices = discount !== null && discount.value > 0;

      const total = prices
        ? discount.type === 'amount'
          ? Math.max(0, subtotal - discount.value * item.quantity)
          : Math.round(subtotal * (1 - discount.value / 100))
        : Math.round(subtotal * (1 - ladder / 100));

      return {
        index: index + 1,
        item,
        discount,
        subtotal,
        total,
        percent: prices ? (discount.type === 'percentage' ? discount.value : 0) : ladder
      };
    });
  }

  /** @returns {boolean} Whether any filled slot is priced by its own discount. */
  get hasSlotDiscounts() {
    return this.slots.some((slot) => slot.discount !== null && slot.discount.value > 0);
  }

  /**
   * The best tier the tray has reached.
   *
   * @returns {number} Percent, 0 when no tier is reached.
   */
  get percent() {
    let earned = 0;
    for (const tier of this.tiers) {
      if (this.count >= tier.quantity) earned = tier.percent;
    }
    return earned;
  }

  /** @returns {number} What the tray is expected to cost after the discounts. */
  get total() {
    return this.slots.reduce((total, slot) => total + slot.total, 0);
  }

  /** @returns {number} Cents the tray expects to save at checkout. */
  get savings() {
    return Math.max(0, this.subtotal - this.total);
  }

  /** @returns {{ quantity: number, percent: number }|null} The next tier, if any. */
  get nextTier() {
    return this.tiers.find((tier) => this.count < tier.quantity) || null;
  }

  /**
   * Put a product in the first free slot.
   *
   * @param {BundleItem} item
   * @returns {boolean} False when the tray is full or the product is already in it.
   */
  add(item) {
    if (this.#indexOfProduct(item.productId) !== -1) return false;

    if (this.isFull) {
      this.#error(themeString('bundleFull', ''));
      return false;
    }

    this.#items.push({ ...item, quantity: Math.max(1, Number(item.quantity) || 1) });
    this.#error('');
    this.render();

    announce(
      themeString('bundleAdded', '', {
        product: item.title,
        count: this.#items.length,
        total: this.size
      })
    );

    this.dispatch(EVENTS.BUNDLE_ITEM_TOGGLE, { productId: item.productId, added: true });
    return true;
  }

  /**
   * Take a product out, whichever slot it is in.
   *
   * @param {number} productId
   * @returns {boolean}
   */
  remove(productId) {
    return this.#removeAt(this.#indexOfProduct(productId));
  }

  /** Empty the tray, all the way back to how it arrived. */
  clear() {
    this.#items = [];
    this.#error('');
    this.#clearPending();
    this.#resetRowQuantities();
    this.render();
  }

  /**
   * Add every slot to the cart in one request.
   *
   * @returns {Promise<Object|null>}
   */
  async addToCart() {
    if (this.#items.length === 0) return null;

    if (this.#submitting) return null;

    if (this.dataset.requireFull === 'true' && !this.isFull) {
      this.#error(themeString('bundleIncomplete', '', { count: this.size - this.#items.length }));
      return null;
    }

    this.#submitting = true;
    this.setLoading(true);
    this.#error('');

    try {
      const bundleId = this.dataset.bundleId || 'bundle';
      const label = this.dataset.bundleLabel || '';

      const lines = this.slots.map((slot) => ({
        id: slot.item.variantId,
        quantity: slot.item.quantity,
        properties: {
          _bundle: bundleId,
          _bundle_size: String(this.size),
          _bundle_count: String(this.count),
          _bundle_slot: String(slot.index),
          _bundle_discount: String(slot.percent),
          ...(slot.discount?.type === 'amount' ? { _bundle_discount_amount: String(slot.discount.value) } : {}),
          ...(slot.discount?.code ? { _bundle_discount_code: slot.discount.code } : {}),
          ...(label ? { [themeString('bundleProperty', 'Bundle')]: label } : {})
        }
      }));

      const codes = this.#codes;
      const result = await cart.addItem(lines);

      this.toggleAttribute('data-added', true);
      announce(themeString('bundleAddedToCart', ''));

      const existing = (cart.state?.attributes?.discount_code || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

      const wanted = [...new Set([...existing, ...codes])];

      if (wanted.length > 0 && wanted.join(',') !== existing.join(',')) {
        await cart.applyDiscount(wanted.join(',')).catch((error) => {
          console.warn('[Boost10] The bundle was added but its discount could not be applied.', error);
        });
      }

      return result;
    } catch (error) {
      const message = error?.message || themeString('cartError', '');
      this.#error(message);
      announceUrgent(message);
      return null;
    } finally {
      this.#submitting = false;
      this.setLoading(false);
    }
  }

  /** @type {boolean} True while a bundle is on its way to the cart. */
  #submitting = false;

  /** Redraw every slot, the totals, the message and every row's pressed state. */
  render() {
    this.#renderSlots();
    this.#renderTotals();
    this.#renderProgress();
    this.#renderNote();
    this.#syncRows();

    if (this.refs.submit instanceof HTMLButtonElement) {
      const needsMore = this.dataset.requireFull === 'true' && !this.isFull;
      this.refs.submit.disabled = this.#items.length === 0 || needsMore;
    }

    this.dataset.count = String(this.count);
    this.toggleAttribute('data-full', this.isFull);

    this.removeAttribute('data-added');

    this.dispatch(EVENTS.BUNDLE_CHANGE, {
      count: this.count,
      filled: this.#items.length,
      percent: this.percent,
      subtotal: this.subtotal,
      total: this.total
    });
  }

  /* ------------------------------------------------------ the modal -- ---- */

  /** @type {HTMLElement|null} */
  #pendingRow = null;

  /**
   * Listen to the quick add modal for a variant chosen on this tray's behalf.
   *
   * @private
   */
  #bindQuickAdd() {
    const modal = this.#quickAdd;
    if (!modal) return;

    this.on(modal, 'submit', this.#onQuickAddSubmit, { capture: true });

    this.on(modal, EVENTS.SECTION_RENDERED, () => this.#claimQuickAdd());
    this.on(modal, EVENTS.OVERLAY_OPEN, () => this.#claimQuickAdd({ redraw: true }));

    this.on(modal, EVENTS.OVERLAY_CLOSE, () => this.#clearPending());
  }

  /**
   * Claim a quick add that was opened on a product this tray sells.
   *
   * @param {Object} [options]
   * @param {boolean} [options.redraw=false] Ask the summary to rewrite the
   *   button. Needed only on the reopen path, where nothing rendered.
   * @private
   */
  #claimQuickAdd({ redraw = false } = {}) {
    if (this.#pendingRow) return;

    const modal = this.#quickAdd;
    if (!modal || modal.dataset.bundleMode) return;

    const product = parseJSONScript(modal.querySelector('[data-quick-add-product]'));
    const productId = Number(product?.id);
    const row = product ? this.#rowFor(productId) : null;
    if (!row) return;

    if (this.#indexOfProduct(productId) !== -1 || this.isFull) return;

    this.#pendingRow = row;
    modal.dataset.bundleMode = this.dataset.sectionId || '';

    if (redraw) {
      const summary = modal.querySelector('quick-add-summary');
      /** @type {any} */ (summary)?.schedule?.();
    }
  }

  /** @returns {HTMLElement|null} */
  get #quickAdd() {
    return document.getElementById('QuickAdd');
  }

  /**
   * @param {SubmitEvent} event
   * @private
   */
  #onQuickAddSubmit = (event) => {
    if (!this.#pendingRow) return;

    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    const modal = this.#quickAdd;
    if (!modal) return;

    if (modal.dataset.bundleMode !== (this.dataset.sectionId || '')) return;

    const product = parseJSONScript(modal.querySelector('[data-quick-add-product]'));
    if (!product) return;

    const picker = modal.querySelector('variant-picker');
    const selected = Number(/** @type {any} */ (picker)?.currentVariant?.id) || 0;
    const variantId = selected || Number(new FormData(form).get('id'));

    const variant = product.variants?.find((entry) => Number(entry.id) === variantId);
    if (!variant) return;

    event.preventDefault();
    event.stopPropagation();

    if (variant.available === false) {
      const message = themeString('soldOut', '');
      this.#error(message);
      announceUrgent(message);
      return;
    }

    const quantity = Number(new FormData(form).get('quantity')) || 1;

    const item = {
      productId: Number(product.id),
      variantId,
      title: product.title,
      variantTitle: product.has_only_default_variant ? '' : variant.title,
      image: variant.featured_image?.src || product.featured_image || '',
      price: Number(variant.price) || 0,
      quantity
    };

    const productForm = form.closest('product-form');
    productForm?.setLoading?.(true);

    wait(MIN_SPIN).then(() => {
      this.#releaseRow();
      this.add(item);

      Promise.resolve(modal?.close?.()).finally(() => productForm?.setLoading?.(false));
    });
  };

  /**
   * Hand a product with options to the quick add modal.
   *
   * @param {HTMLElement} row
   * @private
   */
  #openQuickAddFor(row) {
    const modal = this.#quickAdd;
    const button = row.querySelector('[data-bundle-add]');
    if (!(button instanceof HTMLElement)) return;

    if (!modal) {
      if (row.dataset.productUrl) {
        button.dataset.loading = '';
        window.location.assign(row.dataset.productUrl);
      }
      return;
    }

    this.#pendingRow = row;
    button.dataset.loading = '';

    modal.dataset.bundleMode = this.dataset.sectionId || '';

    button.dataset.productUrl = row.dataset.productUrl || '';
    button.dataset.sectionId = 'quick-add';

    const quantity = quantityOf(row);

    Promise.resolve(modal.open?.(button))
      .then(() => this.#applyQuantity(modal, quantity))
      .catch(() => this.#clearPending());
  }

  /**
   * Set the modal's stepper to the number the row was showing.
   *
   * @param {HTMLElement} modal
   * @param {number} quantity
   * @private
   */
  #applyQuantity(modal, quantity) {
    if (!Number.isFinite(quantity) || quantity <= 1) return;

    const form = modal.querySelector('product-form');
    if (form && typeof (/** @type {any} */ (form).setQuantity) === 'function') {
      /** @type {any} */ (form).setQuantity(quantity);
      return;
    }

    const input = modal.querySelector('[name="quantity"]');
    if (input instanceof HTMLInputElement) input.value = String(quantity);
  }

  /**
   * The row's half: its control stops spinning and stops being the pending one.
   *
   * @private
   */
  #releaseRow() {
    const button = this.#pendingRow?.querySelector('[data-bundle-add]');
    if (button instanceof HTMLElement) delete button.dataset.loading;

    this.#pendingRow = null;
  }

  /**
   * Both halves. This is the dismissal path — closing without choosing — and
   * `teardown()`, where nothing is going to run afterwards that could care
   * about either flag.
   *
   * @private
   */
  #clearPending() {
    this.#releaseRow();
    delete this.#quickAdd?.dataset.bundleMode;
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * Read the merchant's per-slot discounts, once.
   *
   * @private
   */
  #readDiscounts() {
    const entries = parseJSONScript(this.querySelector('[data-bundle-discounts]')) || [];
    this.#discounts = new Map();

    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      const slot = Number(entry?.slot);
      const value = Number(entry?.value);
      const code = String(entry?.code || '').trim();
      const type = entry?.type === 'amount' ? 'amount' : 'percentage';

      if (!Number.isFinite(slot) || slot < 1) continue;
      if (!Number.isFinite(value) || value < 0) continue;

      if (value === 0 && code === '') continue;

      this.#discounts.set(slot, { slot, code, type, value });
    }
  }

  /**
   * The distinct discount codes the filled slots name, in slot order.
   *
   * @returns {string[]}
   * @private
   */
  get #codes() {
    return [...new Set(this.slots.map((slot) => slot.discount?.code || '').filter(Boolean))];
  }

  /**
   * @param {number} productId
   * @returns {HTMLElement|null} The picker row for a product, if this tray has one.
   * @private
   */
  #rowFor(productId) {
    if (!Number.isFinite(productId)) return null;

    for (const row of this.querySelectorAll('[data-bundle-row]')) {
      if (row instanceof HTMLElement && Number(row.dataset.productId) === productId) return row;
    }

    return null;
  }

  /**
   * Put every row's stepper back to one.
   *
   * @private
   */
  #resetRowQuantities() {
    for (const selector of this.querySelectorAll('[data-bundle-quantity]')) {
      if (typeof (/** @type {any} */ (selector).setValue) === 'function') {
        /** @type {any} */ (selector).setValue(1);
        continue;
      }

      const input = selector.querySelector('[data-ref="input"]');
      if (input instanceof HTMLInputElement) input.value = '1';
    }
  }

  /**
   * @param {HTMLElement} button
   * @private
   */
  #onRowToggle(button) {
    const row = button.closest('[data-bundle-row]');
    if (!(row instanceof HTMLElement)) return;

    const productId = Number(row.dataset.productId);

    if (this.#indexOfProduct(productId) !== -1) {
      this.remove(productId);
      return;
    }

    if (this.isFull) {
      this.#error(themeString('bundleFull', ''));
      announceUrgent(themeString('bundleFull', ''));
      return;
    }

    if (button.dataset.loading !== undefined) return;

    if (row.dataset.needsOptions === 'true') {
      this.#openQuickAddFor(row);
      return;
    }

    const item = {
      productId,
      variantId: Number(row.dataset.variantId),
      title: row.dataset.title || '',
      variantTitle: '',
      image: row.dataset.image || '',
      price: Number(row.dataset.price) || 0,
      quantity: quantityOf(row)
    };

    this.#hold(button, () => this.add(item));
  }

  /**
   * Spin a row's control for a beat, then hand over.
   *
   * @param {HTMLElement} button
   * @param {() => void} then Run once the spinner has come off, in the same task.
   * @private
   */
  #hold(button, then) {
    button.dataset.loading = '';

    wait(MIN_SPIN).then(() => {
      delete button.dataset.loading;

      then();
    });
  }

  /**
   * @param {number} productId
   * @returns {number} Index in the tray, or -1.
   * @private
   */
  #indexOfProduct(productId) {
    return this.#items.findIndex((item) => item.productId === productId);
  }

  /**
   * Which slot a control inside the tray belongs to.
   *
   * @param {HTMLElement} target
   * @returns {number} Index into `#items`, or -1.
   * @private
   */
  #slotIndexOf(target) {
    const slot = target.closest('[data-bundle-slot]');
    if (!(slot instanceof HTMLElement)) return -1;

    const index = Number(slot.dataset.index) - 1;
    return index >= 0 && index < this.#items.length ? index : -1;
  }

  /**
   * @param {number} index
   * @returns {boolean}
   * @private
   */
  #removeAt(index) {
    if (index < 0 || index >= this.#items.length) return false;

    const [removed] = this.#items.splice(index, 1);
    this.#error('');
    this.render();

    announce(themeString('bundleRemoved', '', { product: removed.title }));
    this.dispatch(EVENTS.BUNDLE_ITEM_TOGGLE, { productId: removed.productId, added: false });

    return true;
  }

  /**
   * @param {number} index
   * @param {number} delta
   * @private
   */
  #step(index, delta) {
    if (index < 0 || index >= this.#items.length) return;

    const max = Number(this.dataset.maxPerProduct) || 4;
    const next = this.#items[index].quantity + delta;

    if (next < 1) {
      this.#removeAt(index);
      return;
    }

    if (next > max) return;

    this.#items[index].quantity = next;
    this.render();
  }

  /**
   * The next row a customer could add, in the category they are looking at.
   *
   * @private
   */
  #focusPicker() {
    const candidates = this.querySelectorAll(
      '[data-bundle-panel] [data-bundle-row]:not([data-in-bundle]) [data-bundle-add]'
    );

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) continue;
      const rendered = candidate.checkVisibility?.() ?? candidate.offsetParent !== null;
      if (!rendered) continue;
      candidate.focus();
      return;
    }
  }

  /**
   * Fill the slots the tray has, and empty the ones it does not.
   *
   * @private
   */
  #renderSlots() {
    const slots = this.refs.slots?.querySelectorAll('[data-bundle-slot]') ?? [];
    const priced = this.slots;

    for (const [index, slot] of [...slots].entries()) {
      const item = this.#items[index];
      const pricing = priced[index] || null;

      slot.dataset.state = item ? 'filled' : 'empty';

      const filled = slot.querySelector('[data-slot-filled]');
      const fill = slot.querySelector('[data-slot-fill]');

      if (filled instanceof HTMLElement) filled.hidden = !item;
      if (fill instanceof HTMLElement) fill.hidden = Boolean(item);

      if (item) {
        const image = slot.querySelector('[data-slot-image]');
        if (image instanceof HTMLImageElement && image.src !== item.image) image.src = item.image;

        const title = slot.querySelector('[data-slot-title]');
        if (title instanceof HTMLElement) {
          title.textContent = item.variantTitle ? `${item.title} — ${item.variantTitle}` : item.title;
        }

        const count = slot.querySelector('[data-slot-count]');
        if (count instanceof HTMLElement) count.textContent = String(item.quantity).padStart(2, '0');

        const remove = slot.querySelector('[data-slot-remove]');
        if (remove instanceof HTMLElement) {
          remove.setAttribute(
            'aria-label',
            themeString('bundleRemoveLabel', '', { product: item.title, index: index + 1 })
          );
        }
      }

      this.#renderSlotPricing(slot, pricing);

      const tier = slot.querySelector('[data-slot-tier]');
      if (tier instanceof HTMLElement) {
        tier.toggleAttribute('data-reached', this.count >= index + 1);
      }
    }
  }

  /**
   * What one filled slot costs, and the code that made it so.
   *
   * @param {Element} slot
   * @param {BundleSlot|null} pricing
   * @private
   */
  #renderSlotPricing(slot, pricing) {
    const container = slot.querySelector('[data-slot-pricing]');
    if (!(container instanceof HTMLElement)) return;

    const own = pricing?.discount || null;

    if (!own) {
      container.hidden = true;
      return;
    }

    container.hidden = false;

    const saved = pricing.subtotal - pricing.total;
    const priced = own.value > 0;

    const price = slot.querySelector('[data-slot-price]');
    if (price instanceof HTMLElement) price.textContent = formatMoney(pricing.total);

    const original = slot.querySelector('[data-slot-original]');
    if (original instanceof HTMLElement) {
      const show = priced && saved > 0;
      original.textContent = show ? formatMoney(pricing.subtotal) : '';
      original.hidden = !show;
    }

    const discount = slot.querySelector('[data-slot-discount]');
    if (discount instanceof HTMLElement) {
      const code = own.code;

      const text = priced
        ? code
          ? themeString('bundleSlotDiscount', '', { code, amount: formatMoney(saved) })
          : themeString('bundleSlotSaving', '', { amount: formatMoney(saved) })
        : code;

      discount.textContent = text;
      discount.hidden = text === '';
      discount.title = code;
    }
  }

  /** @private */
  #renderTotals() {
    const total = this.refs.total;
    if (total instanceof HTMLElement) total.textContent = formatMoney(this.total);

    const saved = this.savings;

    const original = this.refs.originalTotal;
    if (original instanceof HTMLElement) {
      const discounted = saved > 0 && this.subtotal > 0;
      original.textContent = discounted ? formatMoney(this.subtotal) : '';
      original.hidden = !discounted;
    }

    const discount = this.refs.discount;
    if (discount instanceof HTMLElement) {
      const active = saved > 0;

      discount.textContent = active
        ? this.hasSlotDiscounts
          ? themeString('bundleSaved', '', { amount: formatMoney(saved) })
          : themeString('bundleSavedWithPercent', '', {
              amount: formatMoney(saved),
              percent: this.percent
            })
        : '';
      discount.hidden = !active;
    }
  }

  /** @private */
  #renderProgress() {
    const track = this.refs.progressTrack;
    if (!(track instanceof HTMLElement)) return;

    const filled = Math.min(this.#items.length, this.size);

    track.setAttribute('aria-valuenow', String(filled));
    track.style.setProperty('--bundle-progress', this.size > 0 ? String(filled / this.size) : '0');
  }

  /**
   * The one line that says what happens next.
   *
   * @private
   */
  #renderNote() {
    const target = this.refs.noteText;
    if (!(target instanceof HTMLElement)) return;

    if (!this.#defaultNote) this.#defaultNote = target.textContent || '';

    const next = this.nextTier;

    if (next && next.percent > 0) {
      target.textContent = themeString('bundleProgress', this.#defaultNote, {
        count: next.quantity - this.count,
        percent: next.percent
      });
      return;
    }

    if (this.percent > 0) {
      target.textContent = themeString('bundleUnlocked', this.#defaultNote, { percent: this.percent });
      return;
    }

    target.textContent = this.#defaultNote;
  }

  /** @type {string} */
  #defaultNote = '';

  /**
   * Put every row's control into the state the tray says it is in.
   *
   * @private
   */
  #syncRows() {
    for (const row of this.querySelectorAll('[data-bundle-row]')) {
      if (!(row instanceof HTMLElement)) continue;

      const inBundle = this.#indexOfProduct(Number(row.dataset.productId)) !== -1;
      const button = row.querySelector('[data-bundle-add]');

      row.toggleAttribute('data-in-bundle', inBundle);

      if (!(button instanceof HTMLButtonElement)) continue;

      button.setAttribute('aria-pressed', String(inBundle));
      button.setAttribute(
        'aria-label',
        `${themeString(inBundle ? 'bundleRemove' : 'bundleAdd', '')}: ${row.dataset.title || ''}`
      );

      const unavailable = row.hasAttribute('data-unavailable');
      button.disabled = unavailable || (this.isFull && !inBundle);
    }
  }

  /**
   * @param {string} message
   * @private
   */
  #error(message) {
    const target = this.refs.error;
    if (!(target instanceof HTMLElement)) return;

    target.textContent = message;
    target.hidden = message === '';
  }
}

defineComponent('product-bundle', ProductBundle);

export default ProductBundle;
