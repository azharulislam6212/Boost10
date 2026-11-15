/**
 * `<product-bundle>` — the picker and the Summary panel in
 * `sections/product-bundle.liquid`.
 *
 * @module @theme/product-bundle
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { cart } from '@theme/cart-drawer';
import {
  announce,
  announceUrgent,
  clamp,
  formatMoney,
  parseJSONScript,
  prefersReducedMotion,
  themeString,
  wait
} from '@theme/utilities';

/** How long a row's spinner turns for at minimum, in milliseconds. */
const MIN_SPIN = 420;

/** The theme's ease-out-expo, for the few animations started from script. */
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';

/**
 * One entry in the bundle.
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
 * The discount the Summary block configures.
 *
 * @typedef {Object} BundleDiscount
 * @property {'percentage'|'amount'} type
 * @property {number} value Percent, or cents off the bundle when `type` is `amount`.
 * @property {string} code Discount code, or an empty string.
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

/**
 * Play a short entrance on an element, unless the customer asked for less motion.
 *
 * @param {Element|null} element
 * @param {Keyframe[]} keyframes
 * @param {number} [duration=420]
 */
function play(element, keyframes, duration = 420) {
  if (!(element instanceof HTMLElement) || prefersReducedMotion()) return;
  if (typeof element.animate !== 'function') return;

  element.getAnimations?.().forEach((animation) => animation.cancel());
  element.animate(keyframes, { duration, easing: EASE_OUT });
}

export class ProductBundle extends BaseComponent {
  /** @type {BundleItem[]} */
  #items = [];

  /** @type {boolean} True while a bundle is on its way to the cart. */
  #submitting = false;

  /** @type {HTMLElement|null} */
  #pendingRow = null;

  setup() {
    this.delegate('click', '[data-bundle-add]', (event, target) => {
      event.preventDefault();
      this.#onRowToggle(target);
    });

    this.delegate('click', '[data-slot-remove]', (event, target) => {
      event.preventDefault();
      this.#removeAt(this.#slotIndexOf(target), { refocus: true });
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

    this.delegate('click', '[data-ref~="submit"]', (event) => {
      event.preventDefault();
      this.addToCart();
    });

    this.#bindQuickAdd();
    this.render();
  }

  teardown() {
    this.#clearPending();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /** @returns {HTMLElement|null} The Summary block, when the merchant has one. */
  get summary() {
    return this.#part('summary');
  }

  /** @returns {number} How many slots — and items — the bundle holds. */
  get size() {
    const configured = Number(this.summary?.dataset.maxItems);
    if (Number.isFinite(configured) && configured > 0) return configured;

    return this.summary?.querySelectorAll('[data-bundle-slot]').length || Infinity;
  }

  /** @returns {number} The fewest items the bundle can be added to the cart with. */
  get minimum() {
    const configured = Math.round(Number(this.summary?.dataset.minItems));
    if (!Number.isFinite(configured) || configured < 1) return 1;

    return Math.min(configured, this.size);
  }

  /** @returns {number} The most of any one product. */
  get maxPerProduct() {
    return Number(this.dataset.maxPerProduct) || Infinity;
  }

  /** @returns {BundleItem[]} A copy — the bundle's own array is never handed out. */
  get items() {
    return this.#items.map((item) => ({ ...item }));
  }

  /** @returns {number} Total units in the bundle, not distinct products. */
  get count() {
    return this.#items.reduce((total, item) => total + item.quantity, 0);
  }

  /** @returns {boolean} No room for another item. */
  get isFull() {
    return this.count >= this.size || this.#items.length >= this.size;
  }

  /** @returns {boolean} Enough items to add the bundle to the cart. */
  get isReady() {
    return this.#items.length > 0 && this.count >= this.minimum;
  }

  /** @returns {BundleDiscount|null} */
  get discount() {
    const summary = this.summary;
    if (!summary) return null;

    const value = Number(summary.dataset.discountValue);
    const code = (summary.dataset.discountCode || '').trim();
    const type = summary.dataset.discountType === 'amount' ? 'amount' : 'percentage';

    if (!Number.isFinite(value) || value <= 0) return code ? { type, value: 0, code } : null;

    return { type, value: type === 'percentage' ? Math.min(value, 100) : value, code };
  }

  /** @returns {boolean} Whether the discount applies to the bundle as it stands. */
  get discountActive() {
    const discount = this.discount;
    return Boolean(discount && discount.value > 0 && this.isReady);
  }

  /** @returns {number} Subtotal in cents, before any discount. */
  get subtotal() {
    return this.#items.reduce((total, item) => total + item.price * item.quantity, 0);
  }

  /** @returns {number} What the bundle is expected to cost after its discount. */
  get total() {
    const subtotal = this.subtotal;
    const discount = this.discount;

    if (!discount || !this.discountActive) return subtotal;

    if (discount.type === 'amount') return Math.max(0, subtotal - discount.value);

    return Math.round(subtotal * (1 - discount.value / 100));
  }

  /** @returns {number} Cents the bundle expects to save at checkout. */
  get savings() {
    return Math.max(0, this.subtotal - this.total);
  }

  /** @returns {number} Percent off, for the line property. Zero for amount discounts. */
  get percent() {
    const discount = this.discount;
    return this.discountActive && discount?.type === 'percentage' ? discount.value : 0;
  }

  /**
   * Put a product in the first free slot.
   *
   * @param {BundleItem} item
   * @returns {boolean} False when the bundle is full or the product is already in it.
   */
  add(item) {
    if (this.#indexOfProduct(item.productId) !== -1) return false;

    if (this.isFull) {
      this.#full();
      return false;
    }

    const room = this.size - this.count;
    const wanted = Math.max(1, Math.round(Number(item.quantity) || 1));
    const quantity = Math.max(1, Math.min(wanted, room, this.maxPerProduct));

    this.#items.push({ ...item, quantity });
    this.#error('');
    this.render();

    announce(
      themeString('bundleAdded', '', {
        product: item.title,
        count: this.count,
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

  /** Empty the bundle, all the way back to how it arrived. */
  clear() {
    this.#items = [];
    this.#error('');
    this.#clearPending();
    this.#resetRowQuantities();
    this.render();
  }

  /**
   * Add every item to the cart in one request, then apply the discount code.
   *
   * @returns {Promise<Object|null>}
   */
  async addToCart() {
    if (this.#submitting || this.#items.length === 0) return null;

    if (!this.isReady) {
      const message = themeString('bundleAddMore', '', { count: this.minimum - this.count });
      this.#error(message);
      announceUrgent(message);
      return null;
    }

    this.#submitting = true;
    this.#setBusy(true);
    this.#error('');

    try {
      const bundleId = this.dataset.bundleId || 'bundle';
      const label = this.summary?.dataset.bundleLabel || '';
      const percent = this.percent;

      const lines = this.#items.map((item, index) => ({
        id: item.variantId,
        quantity: item.quantity,
        properties: {
          _bundle: bundleId,
          _bundle_size: String(this.size),
          _bundle_count: String(this.count),
          _bundle_slot: String(index + 1),
          _bundle_discount: String(percent),
          ...(label ? { [themeString('bundleProperty', 'Bundle')]: label } : {})
        }
      }));

      const code = this.discountActive ? this.discount?.code || '' : '';
      const result = await cart.addItem(lines);

      this.toggleAttribute('data-added', true);
      announce(themeString('bundleAddedToCart', ''));

      // The items are in; the code is priced in the background so the button frees up at once.
      if (code) this.#applyCode(code);

      return result;
    } catch (error) {
      const message = error?.message || themeString('cartError', '');
      this.#error(message);
      announceUrgent(message);
      return null;
    } finally {
      this.#submitting = false;
      this.#setBusy(false);
      this.#renderSubmit();
    }
  }

  /** Redraw every slot, the totals, the button and every row's pressed state. */
  render() {
    this.#renderSlots();
    this.#renderTotals();
    this.#renderProgress();
    this.#renderSubmit();
    this.#syncRows();

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

  /**
   * Listen to the quick add modal for a variant chosen on this bundle's behalf.
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
   * Claim a quick add that was opened on a product this bundle sells.
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
   * Both halves: the dismissal path and `teardown()`.
   *
   * @private
   */
  #clearPending() {
    this.#releaseRow();
    delete this.#quickAdd?.dataset.bundleMode;
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * A named part of the bundle, looked up fresh so an editor re-render of the
   * Summary block never leaves a stale reference behind.
   *
   * @param {string} name
   * @returns {HTMLElement|null}
   * @private
   */
  #part(name) {
    const node = this.querySelector(`[data-ref~="${name}"]`);
    return node instanceof HTMLElement ? node : null;
  }

  /**
   * Merge the bundle's code into whatever codes the cart already carries.
   *
   * @param {string} code
   * @private
   */
  async #applyCode(code) {
    const existing = (cart.state?.attributes?.discount_code || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (existing.includes(code)) return;

    await cart.applyDiscount([...existing, code].join(',')).catch((error) => {
      console.warn('[Boost10] The bundle was added but its discount could not be applied.', error);
    });
  }

  /**
   * @param {boolean} busy
   * @private
   */
  #setBusy(busy) {
    this.setLoading(busy);

    const submit = this.#part('submit');
    if (!(submit instanceof HTMLButtonElement)) return;

    submit.classList.toggle('button--loading', busy);
    submit.setAttribute('aria-busy', String(busy));
    if (busy) submit.disabled = true;
  }

  /** @private */
  #full() {
    const message = themeString('bundleFull', '');
    this.#error(message);
    announceUrgent(message);
  }

  /**
   * @param {number} productId
   * @returns {HTMLElement|null} The picker row for a product, if this bundle has one.
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
    if (button.dataset.loading !== undefined) return;

    const productId = Number(row.dataset.productId);

    if (this.#indexOfProduct(productId) !== -1) {
      this.remove(productId);
      return;
    }

    if (this.isFull) {
      this.#full();
      return;
    }

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
   * @param {() => void} then
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
   * @returns {number} Index in the bundle, or -1.
   * @private
   */
  #indexOfProduct(productId) {
    return this.#items.findIndex((item) => item.productId === productId);
  }

  /**
   * Which slot a control inside the Summary belongs to.
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
   * @param {Object} [options]
   * @param {boolean} [options.refocus=false] Keep keyboard focus inside the slots.
   * @returns {boolean}
   * @private
   */
  #removeAt(index, { refocus = false } = {}) {
    if (index < 0 || index >= this.#items.length) return false;

    const [removed] = this.#items.splice(index, 1);
    this.#error('');
    this.render();

    if (refocus) this.#focusSlot(index);

    announce(themeString('bundleRemoved', '', { product: removed.title }));
    this.dispatch(EVENTS.BUNDLE_ITEM_TOGGLE, { productId: removed.productId, added: false });

    return true;
  }

  /**
   * After a removal, focus the control that took the removed one's place.
   *
   * @param {number} index
   * @private
   */
  #focusSlot(index) {
    const slots = this.#part('slots')?.querySelectorAll('[data-bundle-slot]') ?? [];
    const slot = slots[Math.min(index, this.#items.length)] || slots[0];
    if (!slot) return;

    const target = slot.querySelector(
      slot.getAttribute('data-state') === 'filled' ? '[data-slot-remove]' : '[data-slot-fill]'
    );
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
  }

  /**
   * @param {number} index
   * @param {number} delta
   * @private
   */
  #step(index, delta) {
    if (index < 0 || index >= this.#items.length) return;

    const next = this.#items[index].quantity + delta;

    if (next < 1) {
      this.#removeAt(index, { refocus: true });
      return;
    }

    if (delta > 0 && this.isFull) {
      this.#full();
      return;
    }

    if (next > this.maxPerProduct) return;

    this.#items[index].quantity = next;
    this.#error('');
    this.render();
  }

  /**
   * The next row a customer could add, in the category they are looking at.
   *
   * @private
   */
  #focusPicker() {
    const candidates = this.querySelectorAll(
      '[data-bundle-panel] [data-bundle-row]:not([data-in-bundle]) [data-bundle-add]:not(:disabled)'
    );

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) continue;
      const rendered = candidate.checkVisibility?.() ?? candidate.offsetParent !== null;
      if (!rendered) continue;

      candidate.focus({ preventScroll: true });
      candidate.closest('[data-bundle-row]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
  }

  /**
   * Fill the slots the bundle has, and empty the ones it does not.
   *
   * @private
   */
  #renderSlots() {
    const slots = this.#part('slots')?.querySelectorAll('[data-bundle-slot]') ?? [];
    const full = this.isFull;

    for (const [index, slot] of [...slots].entries()) {
      if (!(slot instanceof HTMLElement)) continue;

      const item = this.#items[index];
      const previous = slot.dataset.productId || '';
      const current = item ? String(item.productId) : '';

      slot.dataset.state = item ? 'filled' : 'empty';
      if (current) slot.dataset.productId = current;
      else delete slot.dataset.productId;

      const filled = slot.querySelector('[data-slot-filled]');
      const fill = slot.querySelector('[data-slot-fill]');

      if (fill instanceof HTMLElement) fill.hidden = Boolean(item);

      if (!item) continue;

      const image = slot.querySelector('[data-slot-image]');
      if (image instanceof HTMLImageElement && item.image && image.getAttribute('src') !== item.image) {
        image.src = item.image;
      }

      const title = slot.querySelector('[data-slot-title]');
      if (title instanceof HTMLElement) {
        title.textContent = item.variantTitle ? `${item.title} — ${item.variantTitle}` : item.title;
      }

      const count = slot.querySelector('[data-slot-count]');
      if (count instanceof HTMLElement) {
        const text = String(item.quantity).padStart(2, '0');
        if (count.textContent !== text) {
          count.textContent = text;
          if (previous === current) play(count, [{ transform: 'translateY(40%)', opacity: 0 }, { transform: 'none', opacity: 1 }], 260);
        }
      }

      const increase = slot.querySelector('[data-slot-increase]');
      if (increase instanceof HTMLButtonElement) {
        increase.disabled = full || item.quantity >= this.maxPerProduct;
      }

      const remove = slot.querySelector('[data-slot-remove]');
      if (remove instanceof HTMLElement) {
        remove.setAttribute(
          'aria-label',
          themeString('bundleRemoveLabel', '', { product: item.title, index: index + 1 })
        );
      }

      if (previous !== current && filled instanceof HTMLElement) {
        play(filled, [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }]);
      }
    }
  }

  /** @private */
  #renderTotals() {
    const total = this.#part('total');
    if (total instanceof HTMLElement) {
      const text = formatMoney(this.total);
      if (total.textContent !== text) {
        total.textContent = text;
        play(total, [{ opacity: 0.2, transform: 'translateY(30%)' }, { opacity: 1, transform: 'none' }], 320);
      }
    }

    const original = this.#part('originalTotal');
    if (original instanceof HTMLElement) {
      const discounted = this.savings > 0;
      original.textContent = discounted ? formatMoney(this.subtotal) : '';
      original.hidden = !discounted;
    }
  }

  /**
   * The discount, written for a sentence: "10%" or "$5.00".
   *
   * @returns {string} Empty when there is no discount value.
   * @private
   */
  get #discountLabel() {
    const discount = this.discount;
    if (!discount || discount.value <= 0) return '';

    return discount.type === 'amount' ? formatMoney(discount.value) : `${Math.round(discount.value * 100) / 100}%`;
  }

  /**
   * The pill under the heading: the merchant's message until something is
   * added, then how far the bundle is from its discount. Its border fills as
   * the bundle approaches the minimum.
   *
   * @private
   */
  #renderProgress() {
    const pill = this.#part('progress');
    const text = this.#part('progressText');
    if (!pill || !text) return;

    const count = this.count;
    const minimum = this.minimum;
    const discount = this.#discountLabel;
    const missing = Math.max(0, minimum - count);

    let message = text.dataset.default || '';

    if (count > 0 && missing > 0) {
      message = discount
        ? themeString('bundleProgress', message, { count: missing, discount })
        : themeString('bundleProgressPlain', message, { count: missing });
    } else if (count > 0) {
      message = discount ? themeString('bundleUnlocked', message, { discount }) : themeString('bundleReady', message);
    }

    const ratio = count > 0 ? Math.min(count / minimum, 1) : 0;
    pill.style.setProperty('--bundle-progress', `${Math.round(ratio * 1000) / 10}%`);
    pill.toggleAttribute('data-complete', ratio >= 1);

    if (text.textContent !== message) {
      text.textContent = message;
      play(text, [{ opacity: 0, transform: 'translateY(35%)' }, { opacity: 1, transform: 'none' }], 360);
    }
  }

  /**
   * The button says what happens next: how many more items, or the price.
   *
   * @private
   */
  #renderSubmit() {
    const submit = this.#part('submit');
    if (!(submit instanceof HTMLButtonElement)) return;

    const ready = this.isReady;

    if (!this.#submitting) submit.disabled = !ready;

    const label = submit.querySelector('[data-button-label]');
    if (!(label instanceof HTMLElement)) return;

    const text = ready
      ? themeString('bundleAddToCartTotal', '', { total: formatMoney(this.total) })
      : this.#items.length === 0
        ? themeString('bundleAddToCart', label.textContent || '')
        : themeString('bundleAddMore', '', { count: this.minimum - this.count });

    if (text && label.textContent !== text) label.textContent = text;
  }

  /**
   * Put every row's control into the state the bundle says it is in.
   *
   * @private
   */
  #syncRows() {
    const full = this.isFull;

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
      button.disabled = unavailable || (full && !inBundle);
    }
  }

  /**
   * @param {string} message
   * @private
   */
  #error(message) {
    const target = this.#part('error');
    if (!(target instanceof HTMLElement)) return;

    target.textContent = message;
    target.hidden = message === '';
  }
}

defineComponent('product-bundle', ProductBundle);

export default ProductBundle;
