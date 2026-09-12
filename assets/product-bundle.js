/**
 * product-bundle.js — Boost10
 *
 * `<product-bundle>` — the tray in `sections/product-bundle.liquid`.
 *
 * ## What it is responsible for
 *
 *   - which products are in the tray, and in which slot
 *   - the one-slot-per-product rule, and what a row's control says because of it
 *   - quantity inside a slot, for the stepper tray style
 *   - the tier reached, the totals, and the line that says what unlocks next
 *   - handing a product with options to the quick add modal and taking the
 *     chosen variant back from it
 *   - one `/cart/add.js` request at the end
 *
 * ## What it is not responsible for
 *
 * **The discount.** Nothing here changes what anything costs. The percentage is
 * shown, `_bundle_discount` is written onto every line, and the money comes off
 * at checkout through an automatic discount the merchant created in Shopify
 * admin. A theme cannot price a cart, and one that pretends to produces a tray
 * that disagrees with checkout — which is the single worst thing a bundle
 * builder can do.
 *
 * **Drawing empty slots.** Liquid renders all of them, at the real size, in the
 * real grid. This only ever swaps a slot's contents. A tray drawn on the client
 * is a hole in the page until the module arrives.
 *
 * ## The rule: a product in a slot cannot be added again
 *
 * Enforced in one place — `#indexOfProduct()` — and expressed three ways so it
 * is never a click that silently does nothing:
 *
 *   the row's control    flips to a check and `aria-pressed="true"`
 *   pressing it again    removes the product, rather than refusing
 *   wanting two          is the stepper inside the slot, not a second slot
 *
 * Pressing a pressed control to undo is the reason it is a toggle rather than a
 * disabled button. A disabled control is the correct way to say "you cannot do
 * this" and the wrong way to say "you have already done this" — the customer
 * can see the product in the tray, so the question they actually have is how to
 * take it out.
 *
 * ## Options go through the modal, never through a guess
 *
 * A product with real options is not added from the row. The quick add modal
 * opens on it, the customer chooses, and the modal's add button reports the
 * chosen variant back here instead of adding to the cart. Choosing the first
 * variant silently is how a customer ends up with a flavour they did not pick,
 * and a bundle is where that is least recoverable — it is five other decisions
 * deep by the time they see the cart.
 *
 * The interception is a capture-phase listener on the modal. Capture runs
 * ancestor-first, so it reaches the `submit` before `<product-form>`'s own
 * listener on the form does, and `stopPropagation()` there means the cart is
 * never called at all.
 *
 * @module @theme/product-bundle
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { cart } from '@theme/cart-drawer';
import { announce, announceUrgent, clamp, formatMoney, parseJSONScript, themeString, wait } from '@theme/utilities';

/**
 * How long a row's spinner turns for at minimum, in milliseconds.
 *
 * Nothing waits on this. The product is in the slot and the tray has redrawn
 * before the first frame of the spin — this only decides when the glyph stops
 * turning and the check replaces it, which is what makes the swap a transition
 * instead of a flicker nobody can see. Roughly two turns of `@keyframes spin`
 * at its 700ms period would be too long; a little over half of one reads as an
 * acknowledgement and is gone before it can feel like a wait.
 */
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
 * Markup — see `sections/product-bundle.liquid`. Abbreviated:
 *
 *   <product-bundle data-size="6" data-tiers="1:10,2:15,3:25" data-tray-style="ladder">
 *     <li data-bundle-row data-product-id="…" data-variant-id="…" data-price="…">
 *       <button data-bundle-add aria-pressed="false">…</button>
 *     </li>
 *     …
 *     <li data-bundle-slot data-index="1" data-state="empty">…</li>
 *     …
 *     <span data-ref="total"></span>
 *     <button data-ref="submit" disabled>…</button>
 *   </product-bundle>
 */
/**
 * How many of this row the customer asked for.
 *
 * Every row carries a `<quantity-selector>` — the theme's own stepper, at its
 * compact size, on the rating's line where the size line used to be. The number
 * is read from the real `<input>` rather than from the component's state,
 * because the component is a lazily loaded module: a customer who presses add
 * before it lands still gets the value the input is showing, which is the one
 * they can see.
 *
 * `clamp` against the input's own `min` and `max`, so a typed value that has
 * not been corrected yet — the stepper deliberately does not clamp on every
 * keystroke — cannot reach the tray as a zero or as more than the slot allows.
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

  setup() {
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

    // An empty slot is a second way into the same list. Rather than opening
    // something, it takes the customer to the products — the tray is on screen
    // beside them on a desktop, and above them on a phone.
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

  /* --------------------------------------------------------- public API -- */

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
   * Same attribute shape `assets/bundle-builder.js` reads, so the two sections
   * describe a ladder the same way and a merchant moving between them is not
   * learning a second format.
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

  /** @returns {number} Subtotal in cents, before any tier discount. */
  get subtotal() {
    return this.#items.reduce((total, item) => total + item.price * item.quantity, 0);
  }

  /**
   * The best tier the tray has reached.
   *
   * Measured in **units**, not distinct products, so three of one thing counts
   * as three towards a ladder — which is what a customer who just pressed plus
   * three times expects, and what the matching Shopify automatic discount will
   * count when it applies its minimum quantity at checkout.
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

  /** @returns {number} What the tray is expected to cost after the discount. */
  get total() {
    return Math.round(this.subtotal * (1 - this.percent / 100));
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

  /** Empty the tray. */
  clear() {
    this.#items = [];
    this.render();
  }

  /**
   * Add every slot to the cart in one request.
   *
   * @returns {Promise<Object|null>}
   */
  async addToCart() {
    if (this.#items.length === 0) return null;

    // "Complete" is a merchant setting. A tray that refuses four of six is right
    // for a fixed-price bundle box and wrong for a mix-and-match ladder, where
    // four is simply a smaller discount.
    if (this.dataset.requireFull === 'true' && !this.isFull) {
      this.#error(themeString('bundleIncomplete', '', { count: this.size - this.#items.length }));
      return null;
    }

    this.setLoading(true);
    this.#error('');

    try {
      const bundleId = this.dataset.bundleId || 'bundle';
      const label = this.dataset.bundleLabel || '';
      const percent = this.percent;

      const lines = this.#items.map((item) => ({
        id: item.variantId,
        quantity: item.quantity,
        properties: {
          // The leading underscore keeps these out of the customer's view of the
          // cart and out of the order confirmation, while staying available to
          // the merchant, to fulfilment tooling and to a discount's own
          // conditions.
          _bundle: bundleId,
          _bundle_size: String(this.size),
          _bundle_count: String(this.count),
          _bundle_discount: String(percent),
          ...(label ? { [themeString('bundleProperty', 'Bundle')]: label } : {})
        }
      }));

      const result = await cart.addItem(lines);

      this.clear();
      announce(themeString('bundleAddedToCart', ''));

      return result;
    } catch (error) {
      // A line that has sold out since the customer chose it is the common
      // failure. Naming it beats a generic error, because the fix is to swap
      // that one item rather than start again.
      const message = error?.message || themeString('cartError', '');
      this.#error(message);
      announceUrgent(message);
      return null;
    } finally {
      this.setLoading(false);
    }
  }

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

    this.dispatch(EVENTS.BUNDLE_CHANGE, {
      count: this.count,
      filled: this.#items.length,
      percent: this.percent,
      subtotal: this.subtotal,
      total: this.total
    });
  }

  /* ------------------------------------------------------ the modal -- */

  /** @type {HTMLElement|null} */
  #pendingRow = null;

  /**
   * Listen to the quick add modal for a variant chosen on this tray's behalf.
   *
   * The listener is attached once and lives as long as the component, rather
   * than being added when a request starts and removed when it ends: an
   * add-and-remove pair around an async open is a listener leak the first time
   * a customer closes the modal by pressing Escape.
   *
   * @private
   */
  #bindQuickAdd() {
    const modal = this.#quickAdd;
    if (!modal) return;

    this.on(modal, 'submit', this.#onQuickAddSubmit, { capture: true });

    // Closing without choosing is a cancelled request, not a failed one. The
    // flag has to come off either way or the next ordinary quick add from a
    // product card would be swallowed by this tray.
    this.on(modal, EVENTS.OVERLAY_CLOSE, () => this.#clearPending());
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
    const product = parseJSONScript(modal?.querySelector('[data-quick-add-product]'));
    if (!product) return;

    const variantId = Number(new FormData(form).get('id'));
    const variant = product.variants?.find((entry) => Number(entry.id) === variantId);
    if (!variant) return;

    // Capture phase, so `<product-form>`'s own submit listener on this form is
    // never reached and `/cart/add.js` is never called.
    event.preventDefault();
    event.stopPropagation();

    // The modal's own stepper, not the row's. A customer who opened the modal
    // to choose a flavour has a quantity control in front of them, and taking
    // the row's number instead would silently overrule the one they just set.
    const quantity = Number(new FormData(form).get('quantity')) || 1;

    this.add({
      productId: Number(product.id),
      variantId,
      title: product.title,
      variantTitle: product.has_only_default_variant ? '' : variant.title,
      image: variant.featured_image?.src || product.featured_image || '',
      price: Number(variant.price) || 0,
      quantity
    });

    this.#clearPending();
    modal?.close?.();
  };

  /**
   * @param {HTMLElement} row
   * @returns {Promise<void>|void} Settles once the modal is open — see `#hold`.
   * @private
   */
  #openQuickAddFor(row) {
    const modal = this.#quickAdd;
    const button = row.querySelector('[data-bundle-add]');

    // No modal on the page means quick add is switched off in theme settings.
    // The product page is then the only place the options exist, so that is
    // where the customer goes — a control that does nothing would be worse.
    if (!modal || !(button instanceof HTMLElement)) {
      if (row.dataset.productUrl) window.location.assign(row.dataset.productUrl);
      return;
    }

    this.#pendingRow = row;
    modal.dataset.bundleMode = this.dataset.sectionId || '';

    button.dataset.productUrl = row.dataset.productUrl || '';
    button.dataset.sectionId = 'quick-add';

    // Returned, not just called. `Overlay.open()` resolves after the product's
    // section has been fetched and the entrance has run, and that promise is
    // the whole reason the row's spinner knows how long to turn — dropping it
    // here would stop the spin on the minimum beat and leave the customer
    // watching a settled button through the rest of the request.
    return modal.open?.(button);
  }

  /** @private */
  #clearPending() {
    this.#pendingRow = null;
    delete this.#quickAdd?.dataset.bundleMode;
  }

  /* ---------------------------------------------------------- internals -- */

  /**
   * @param {HTMLElement} button
   * @private
   */
  #onRowToggle(button) {
    const row = button.closest('[data-bundle-row]');
    if (!(row instanceof HTMLElement)) return;

    const productId = Number(row.dataset.productId);

    // Already in a slot. The rule is that it cannot be added a second time; the
    // affordance is that pressing it again takes it out.
    //
    // No loader on the way out. Removing is local and instant, and a spinner on
    // an undo is a delay the customer can see and nothing else.
    if (this.#indexOfProduct(productId) !== -1) {
      this.remove(productId);
      return;
    }

    // A refusal is an answer, not work. Spinning first would say the press was
    // being acted on and then take it back.
    if (this.isFull) {
      this.#error(themeString('bundleFull', ''));
      announceUrgent(themeString('bundleFull', ''));
      return;
    }

    if (row.dataset.needsOptions === 'true') {
      // The real wait: `#openQuickAddFor` starts a fetch of the product's
      // section, and until this the row gave no sign a press had registered.
      // The spinner is released when the modal is open — or when opening it
      // failed, so a network error leaves a button the customer can press
      // again rather than one spinning forever.
      this.#hold(button, Promise.resolve(this.#openQuickAddFor(row)));
      return;
    }

    this.#hold(button);

    this.add({
      productId,
      variantId: Number(row.dataset.variantId),
      title: row.dataset.title || '',
      variantTitle: '',
      image: row.dataset.image || '',
      price: Number(row.dataset.price) || 0,
      quantity: quantityOf(row)
    });
  }

  /**
   * Spin a row's control while its press is being acted on.
   *
   * The two paths behind one press are very different lengths: opening the
   * quick add modal is a fetch, and dropping a simple product into a slot is
   * synchronous — it is done before the browser has painted the press. A
   * spinner shown only for the slow one is a control that acknowledges some
   * presses and not others, which reads as the fast path being broken.
   *
   * So both spin, and `MIN_SPIN` is the floor. It is not a fake delay: nothing
   * waits on it. The product is in the slot on the same frame either way and
   * the tray has already redrawn — the timer only decides when the glyph stops
   * turning and the check takes over, which is the transition between the two
   * states rather than a pause before one of them.
   *
   * @param {HTMLElement} button
   * @param {Promise<unknown>} [work] Released when this settles, or after `MIN_SPIN`, whichever is later.
   * @private
   */
  #hold(button, work) {
    button.dataset.loading = '';

    const floor = wait(MIN_SPIN);
    const done = work ? Promise.allSettled([work, floor]) : floor;

    done.then(() => {
      // The row may have been morphed away by a section re-render while the
      // press was in flight, in which case this is a flag on a detached node
      // and removing it is simply free.
      delete button.dataset.loading;
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
   * `data-index` is the slot's 1-based position in the grid, and the tray fills
   * from the front, so it is also the item's index plus one.
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

    // Stepping below one is a removal, and saying so is better than a minus
    // button that stops responding at 01 with no explanation.
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
   * Scoped to the panel actually on screen. An unscoped query walks into a
   * category the customer has not opened and focuses a button in it —
   * `focus()` on an element that is not rendered moves focus nowhere at all,
   * and the customer is left with the focus ring gone and no idea where it
   * went.
   *
   * ## Why this asks the layout instead of reading an attribute
   *
   * It used to be `[data-bundle-panel]:not([hidden])`, from when
   * `collection-tabs.js` opened and closed the categories by writing `hidden`
   * on them. Nothing writes that attribute any more: the picker is a radio
   * group and `assets/base.css` shows the checked category's panel with
   * `:has(> :checked)`. So `:not([hidden])` had stopped narrowing anything and
   * matched every panel, open or closed — which is the bug it was written to
   * prevent, arrived at from the other direction.
   *
   * `checkVisibility` is the question actually being asked: is this element
   * rendered. It answers for `display: none` on any ancestor, which is how a
   * closed category is closed now, and it would still answer for `hidden` — so
   * this does not care how the panels come to be hidden, only that they are.
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
   * Every slot already exists in the DOM — this never creates or destroys one,
   * so the grid never reflows as the tray fills and a slot's tier badge is
   * whatever Liquid wrote on it.
   *
   * @private
   */
  #renderSlots() {
    const slots = this.refs.slots?.querySelectorAll('[data-bundle-slot]') ?? [];

    for (const [index, slot] of [...slots].entries()) {
      const item = this.#items[index];

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
        // Zero-padded to two digits, as the drawing has it. `padStart` rather
        // than a conditional, so 10 and above are left alone.
        if (count instanceof HTMLElement) count.textContent = String(item.quantity).padStart(2, '0');

        const remove = slot.querySelector('[data-slot-remove]');
        if (remove instanceof HTMLElement) {
          remove.setAttribute(
            'aria-label',
            themeString('bundleRemoveLabel', '', { product: item.title, index: index + 1 })
          );
        }
      }

      // A tier badge is only true once the tray has reached it. Before that it
      // is what filling the slot would unlock, and it says so by being marked
      // locked rather than by changing its words.
      const tier = slot.querySelector('[data-slot-tier]');
      if (tier instanceof HTMLElement) {
        tier.toggleAttribute('data-reached', this.count >= index + 1);
      }
    }
  }

  /** @private */
  #renderTotals() {
    const total = this.refs.total;
    if (total instanceof HTMLElement) total.textContent = formatMoney(this.total);

    const original = this.refs.originalTotal;
    if (original instanceof HTMLElement) {
      const discounted = this.percent > 0 && this.subtotal > 0;
      original.textContent = discounted ? formatMoney(this.subtotal) : '';
      original.hidden = !discounted;
    }

    const discount = this.refs.discount;
    if (discount instanceof HTMLElement) {
      const saved = this.subtotal - this.total;
      const active = saved > 0;

      discount.textContent = active
        ? themeString('bundleSavedWithPercent', '', {
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
   * Three states, in order of what is most useful to know:
   *   a tier is within reach   how many more, and for what
   *   every tier is reached    the discount that is on
   *   neither                  the merchant's own note, untouched
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
   * This is the rule made visible. It runs on every render rather than being
   * toggled at the point of a click, so a row added through the modal, removed
   * from a slot, or cleared by a successful add to cart all come out the same.
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

      // A full tray disables what cannot be added, and leaves what is already in
      // it pressable — that control is now the way back out.
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
