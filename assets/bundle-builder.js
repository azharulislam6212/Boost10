/**
 * `<bundle-builder>`, `<bundle-card>` and `<bundle-discount>`.
 *
 * @module @theme/bundle-builder
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { cart } from '@theme/cart-drawer';
import { formatMoney, themeString, announce, announceUrgent, clamp, getRoute } from '@theme/utilities';

/* ==========================================================================
   <bundle-builder>
   ========================================================================== */

export class BundleBuilder extends BaseComponent {
  static requiredRefs = ['slots', 'submit'];

  /**
   * Chosen items, keyed by variant id.
   *
   * @type {Map<string, { id: number, productId: string, title: string,
   *   variantTitle: string, price: number, image: string, url: string }>}
   */
  #selection = new Map();

  setup() {
    this.#selection.clear();

    this.on(this.refs.submit, 'click', (event) => {
      event.preventDefault();
      this.addToCart();
    });

    this.on(this, 'click', (event) => {
      const remove = event.target instanceof Element ? event.target.closest('[data-slot-remove]') : null;
      if (!remove) return;

      event.preventDefault();
      this.remove(remove.dataset.slotRemove, { focusPicker: true });
    });

    this.on(this, EVENTS.BUNDLE_ITEM_TOGGLE, (event) => {
      const { detail } = event;
      if (!detail?.variantId) return;

      if (this.has(detail.variantId)) {
        this.remove(detail.variantId);
      } else {
        this.add(detail);
      }
    });

    this.render();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {number} How many slots the tray holds.
   */
  get size() {
    return Number(this.dataset.size) || 5;
  }

  /**
   * Discount tiers, ascending.
   *
   * @returns {Array<{ quantity: number, percent: number }>}
   */
  get tiers() {
    return (this.dataset.tiers || '')
      .split(',')
      .map((entry) => entry.split(':').map(Number))
      .filter(([quantity, percent]) => Number.isFinite(quantity) && Number.isFinite(percent) && quantity > 0)
      .map(([quantity, percent]) => ({ quantity, percent }))
      .sort((a, b) => a.quantity - b.quantity);
  }

  /**
   * @returns {number}
   */
  get count() {
    return this.#selection.size;
  }

  /**
   * @returns {boolean}
   */
  get isFull() {
    return this.count >= this.size;
  }

  /**
   * @returns {Array<Object>}
   */
  get items() {
    return Array.from(this.#selection.values());
  }

  /**
   * @returns {number} Subtotal in cents, before any tier discount.
   */
  get subtotal() {
    let total = 0;
    for (const item of this.#selection.values()) total += item.price;
    return total;
  }

  /**
   * @returns {number} The percentage currently earned.
   */
  get percent() {
    let earned = 0;
    for (const tier of this.tiers) {
      if (this.count >= tier.quantity) earned = tier.percent;
    }
    return earned;
  }

  /**
   * @returns {number} Money saved in cents.
   */
  get saved() {
    return Math.round((this.subtotal * this.percent) / 100);
  }

  /**
   * @returns {number} What the bundle is expected to cost after the discount.
   */
  get total() {
    return this.subtotal - this.saved;
  }

  /**
   * @returns {{ quantity: number, percent: number }|null} The next tier, if any.
   */
  get nextTier() {
    return this.tiers.find((tier) => this.count < tier.quantity) || null;
  }

  /**
   * @param {string|number} variantId
   * @returns {boolean}
   */
  has(variantId) {
    return this.#selection.has(String(variantId));
  }

  /**
   * Put an item in the next empty slot.
   *
   * @param {Object} item
   * @returns {boolean} False when the tray is full.
   */
  add(item) {
    const key = String(item.variantId);

    if (this.#selection.has(key)) return true;

    if (this.isFull) {
      announceUrgent(themeString('bundleFull', '', { count: this.size }));
      this.#error(themeString('bundleFull', '', { count: this.size }));
      return false;
    }

    this.#selection.set(key, {
      id: Number(item.variantId),
      productId: String(item.productId ?? ''),
      title: item.title ?? '',
      variantTitle: item.variantTitle ?? '',
      price: Number(item.price) || 0,
      image: item.image ?? '',
      url: item.url ?? ''
    });

    this.#error('');
    this.render();

    announce(themeString('bundleAdded', '', { product: item.title, count: this.count, total: this.size }));
    return true;
  }

  /**
   * Take an item out and restore its placeholder.
   *
   * @param {string|number} variantId
   * @param {{ focusPicker?: boolean }} [options]
   */
  remove(variantId, { focusPicker = false } = {}) {
    const key = String(variantId);
    const item = this.#selection.get(key);
    if (!item) return;

    this.#selection.delete(key);
    this.#error('');
    this.render();

    announce(themeString('bundleRemoved', '', { product: item.title }));

    if (!focusPicker) return;

    const card = this.querySelector(`bundle-card[data-variant-id="${CSS.escape(key)}"] [data-bundle-toggle]`);
    if (card instanceof HTMLElement) {
      card.focus({ preventScroll: true });
    } else if (this.refs.slots instanceof HTMLElement) {
      this.refs.slots.focus?.({ preventScroll: true });
    }
  }

  /** Empty the tray. */
  clear() {
    this.#selection.clear();
    this.render();
  }

  /**
   * Add the whole bundle in one request.
   *
   * @returns {Promise<Object|null>}
   */
  async addToCart() {
    if (this.count < this.size) {
      this.#error(themeString('bundleIncomplete', '', { count: this.size - this.count }));
      return null;
    }

    this.setLoading(true);
    this.#error('');

    try {
      const bundleId = this.dataset.bundleId || 'bundle';
      const label = this.dataset.bundleLabel || '';

      const items = this.items.map((item) => ({
        id: item.id,
        quantity: 1,
        properties: {
          _bundle: bundleId,
          _bundle_size: String(this.size),
          _bundle_discount: String(this.percent),
          ...(label ? { [themeString('bundleProperty', 'Bundle')]: label } : {})
        }
      }));

      const result = await cart.addItem(items);

      this.clear();
      announce(themeString('bundleAddedToCart', ''));

      return result;
    } catch (error) {
      const message = error?.message || themeString('cartError', '');
      this.#error(message);
      announceUrgent(message);
      return null;
    } finally {
      this.setLoading(false);
    }
  }

  /** Redraw the tray, the totals and every card's pressed state. */
  render() {
    this.#renderSlots();
    this.#renderTotals();
    this.#renderProgress();
    this.#syncCards();

    if (this.refs.submit instanceof HTMLButtonElement) {
      this.refs.submit.disabled = !this.isFull;
    }

    this.dataset.count = String(this.count);
    this.toggleAttribute('data-full', this.isFull);

    this.dispatch(EVENTS.BUNDLE_CHANGE, {
      count: this.count,
      percent: this.percent,
      subtotal: this.subtotal,
      total: this.total
    });
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /**
   * Draw exactly `size` slots: filled ones first, placeholders after.
   *
   * @private
   */
  #renderSlots() {
    const list = this.refs.slots;
    if (!(list instanceof HTMLElement)) return;

    const template = this.refs.slotTemplate;
    const items = this.items;

    list.replaceChildren();

    for (let index = 0; index < this.size; index += 1) {
      const item = items[index];
      const slot = document.createElement('li');

      slot.className = item ? 'bundle-slot bundle-slot--filled' : 'bundle-slot';
      slot.dataset.slotIndex = String(index + 1);

      if (!item) {
        slot.innerHTML = '';
        const number = document.createElement('span');
        number.className = 'bundle-slot__number';
        number.setAttribute('aria-hidden', 'true');
        number.textContent = String(index + 1);

        const label = document.createElement('span');
        label.className = 'bundle-slot__placeholder';
        label.textContent = themeString('bundleSlotEmpty', '', { index: index + 1 });

        slot.append(number, label);
        list.appendChild(slot);
        continue;
      }

      if (template instanceof HTMLTemplateElement) {
        slot.appendChild(template.content.cloneNode(true));
        this.#fillSlot(slot, item, index);
      } else {
        this.#fillSlotFallback(slot, item, index);
      }

      list.appendChild(slot);
    }
  }

  /**
   * Fill a cloned template. Liquid owns the markup; this owns the values.
   *
   * @param {HTMLElement} slot
   * @param {Object} item
   * @param {number} index
   * @private
   */
  #fillSlot(slot, item, index) {
    const image = slot.querySelector('[data-slot-image]');
    if (image instanceof HTMLImageElement) {
      if (item.image) {
        image.src = item.image;
        image.alt = '';
        image.removeAttribute('hidden');
      } else {
        image.setAttribute('hidden', '');
      }
    }

    const title = slot.querySelector('[data-slot-title]');
    if (title instanceof HTMLElement) title.textContent = item.title;

    const variant = slot.querySelector('[data-slot-variant]');
    if (variant instanceof HTMLElement) {
      const meaningful = item.variantTitle && item.variantTitle !== 'Default Title';
      variant.textContent = meaningful ? item.variantTitle : '';
      variant.toggleAttribute('hidden', !meaningful);
    }

    const price = slot.querySelector('[data-slot-price]');
    if (price instanceof HTMLElement) price.textContent = formatMoney(item.price);

    const remove = slot.querySelector('[data-slot-remove]');
    if (remove instanceof HTMLElement) {
      remove.dataset.slotRemove = String(item.id);
      remove.setAttribute(
        'aria-label',
        themeString('bundleRemoveLabel', '', { product: item.title, index: index + 1 })
      );
    }
  }

  /**
   * Used when the section did not render a slot template.
   *
   * @param {HTMLElement} slot
   * @param {Object} item
   * @param {number} index
   * @private
   */
  #fillSlotFallback(slot, item, index) {
    const title = document.createElement('span');
    title.className = 'bundle-slot__title';
    title.textContent = item.title;

    const price = document.createElement('span');
    price.className = 'bundle-slot__price';
    price.textContent = formatMoney(item.price);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'bundle-slot__remove';
    remove.dataset.slotRemove = String(item.id);
    remove.textContent = '\u00d7';
    remove.setAttribute(
      'aria-label',
      themeString('bundleRemoveLabel', '', { product: item.title, index: index + 1 })
    );

    slot.append(title, price, remove);
  }

  /** @private */
  #renderTotals() {
    const set = (ref, value) => {
      const node = this.refs[ref];
      if (node instanceof HTMLElement) node.textContent = value;
    };

    set('subtotal', formatMoney(this.subtotal));
    set('total', formatMoney(this.total));

    const discount = this.refs.discount;
    if (discount instanceof HTMLElement) {
      const active = this.percent > 0;
      discount.textContent = active
        ? themeString('bundleSavedWithPercent', '', {
            amount: formatMoney(this.saved),
            percent: this.percent
          })
        : '';
      discount.toggleAttribute('hidden', !active);
    }

    const original = this.refs.originalTotal;
    if (original instanceof HTMLElement) {
      const active = this.percent > 0;
      original.textContent = active ? formatMoney(this.subtotal) : '';
      original.toggleAttribute('hidden', !active);
    }

    this.style.setProperty('--bundle-discount', String(this.percent));
  }

  /**
   * The gamified line: how many more items, and what that unlocks.
   *
   * @private
   */
  #renderProgress() {
    const next = this.nextTier;

    const message = next
      ? themeString('bundleProgress', '', {
          count: next.quantity - this.count,
          percent: next.percent
        })
      : this.percent > 0
        ? themeString('bundleUnlocked', '', { percent: this.percent })
        : themeString('bundleStart', '', { count: this.size });

    const target = this.refs.progress;
    if (target instanceof HTMLElement) target.textContent = message;

    const ratio = clamp(this.count / this.size, 0, 1);
    this.style.setProperty('--bundle-progress', String(ratio));

    const track = this.refs.progressTrack;
    if (track instanceof HTMLElement) {
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', String(this.size));
      track.setAttribute('aria-valuenow', String(this.count));
      track.setAttribute('aria-label', message);
    }
  }

  /** @private */
  #syncCards() {
    for (const card of this.querySelectorAll('bundle-card')) {
      card.setSelected?.(this.has(card.dataset.variantId));
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
    target.toggleAttribute('hidden', !message);
  }
}

defineComponent('bundle-builder', BundleBuilder);

/* ==========================================================================
   <bundle-card>
   ========================================================================== */

/** One product in the picker, with its own variant selector. */
export class BundleCard extends BaseComponent {
  static requiredRefs = ['toggle'];

  /** @type {Object[]} */
  #variants = [];

  setup() {
    const script = this.querySelector('[data-variants]');

    try {
      this.#variants = script ? JSON.parse(script.textContent) : [];
    } catch {
      console.warn('[Boost10] Bundle card variant data could not be parsed.');
      this.#variants = [];
    }

    if (this.refs.variantSelect) {
      this.on(this.refs.variantSelect, 'change', () => this.#onVariantChange());
    }

    this.on(this.refs.toggle, 'click', (event) => {
      event.preventDefault();
      this.toggle();
    });

    this.#render();
  }

  /* --------------------------------------------------------- public API -- ---- */

  /**
   * @returns {Object|null}
   */
  get variant() {
    const id = this.refs.variantSelect?.value || this.dataset.variantId;
    return this.#variants.find((item) => String(item.id) === String(id)) || this.#variants[0] || null;
  }

  /**
   * @returns {boolean}
   */
  get available() {
    return Boolean(this.variant?.available);
  }

  /** Ask the builder to add or remove this card's current variant. */
  toggle() {
    const variant = this.variant;

    if (!variant?.available) {
      announceUrgent(themeString('soldOut', ''));
      return;
    }

    this.dispatch(EVENTS.BUNDLE_ITEM_TOGGLE, {
      variantId: variant.id,
      productId: this.dataset.productId,
      title: this.dataset.title || '',
      variantTitle: variant.title,
      price: variant.price,
      image: variant.featured_image?.src || this.dataset.image || '',
      url: this.dataset.url || ''
    });
  }

  /**
   * Reflect the builder's state. Called by the builder, not inferred here.
   *
   * @param {boolean} selected
   */
  setSelected(selected) {
    this.toggleAttribute('data-selected', selected);
    this.refs.toggle.setAttribute('aria-pressed', String(selected));

    const label = selected ? themeString('bundleRemove', '') : themeString('bundleAdd', '');
    const text = this.refs.toggle.querySelector('[data-toggle-label]');

    if (text instanceof HTMLElement) {
      text.textContent = label;
    } else {
      this.refs.toggle.textContent = label;
    }
  }

  /* ---------------------------------------------------------- internals -- ---- */

  /** @private */
  #onVariantChange() {
    const variant = this.variant;
    if (variant) this.dataset.variantId = String(variant.id);

    this.#render();

    if (this.hasAttribute('data-selected')) {
      this.closest('bundle-builder')?.remove?.(this.dataset.previousVariantId || '');
    }

    this.dataset.previousVariantId = variant ? String(variant.id) : '';
  }

  /** @private */
  #render() {
    const variant = this.variant;

    if (this.refs.price instanceof HTMLElement && variant) {
      this.refs.price.textContent = formatMoney(variant.price);
    }

    if (this.refs.stock instanceof HTMLElement) {
      this.refs.stock.textContent = variant?.available ? '' : themeString('soldOut', '');
      this.refs.stock.toggleAttribute('hidden', Boolean(variant?.available));
    }

    if (this.refs.toggle instanceof HTMLButtonElement) {
      this.refs.toggle.disabled = !variant?.available;
    }

    this.toggleAttribute('data-unavailable', !variant?.available);
  }
}

defineComponent('bundle-card', BundleCard);

/* ==========================================================================
   <bundle-discount>
   ========================================================================== */

/** The optional manual promo code field. */
export class BundleDiscount extends BaseComponent {
  static requiredRefs = ['form', 'input'];

  setup() {
    this.on(this.refs.form, 'submit', this.#onSubmit);
  }

  /**
   * @param {SubmitEvent} event
   * @private
   */
  #onSubmit = async (event) => {
    event.preventDefault();

    const code = this.refs.input.value.trim();
    if (!code) return;

    this.setLoading(true);
    this.refs.submit?.setAttribute('disabled', '');

    try {
      await fetch(`${getRoute('rootUrl')}discount/${encodeURIComponent(code)}`, {
        method: 'GET',
        headers: { Accept: 'text/html' }
      }).catch(() => null);

      await cart.applyDiscount(code);

      this.#message(themeString('discountApplied', '', { code }), false);
      this.refs.input.value = '';
    } catch (error) {
      console.warn('[Boost10] The promotion code could not be stored.', error);
      this.#message(themeString('discountFailed', ''), true);
    } finally {
      this.setLoading(false);
      this.refs.submit?.removeAttribute('disabled');
    }
  };

  /**
   * @param {string} text
   * @param {boolean} isError
   * @private
   */
  #message(text, isError) {
    const target = this.refs.message;

    if (target instanceof HTMLElement) {
      target.textContent = text;
      target.toggleAttribute('data-error', isError);
    }

    if (isError) {
      announceUrgent(text);
    } else {
      announce(text);
    }
  }
}

defineComponent('bundle-discount', BundleDiscount);

export default { BundleBuilder, BundleCard, BundleDiscount };
