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
 * **Pricing the cart.** Nothing here changes what anything costs. The tray shows
 * what the merchant's settings say a bundle is worth, `_bundle_discount` is
 * written onto every line, and any codes the slots carry are handed to Shopify —
 * which then prices the cart and is believed. A theme cannot price a cart, and
 * one that pretends to produces a tray that disagrees with checkout, which is
 * the single worst thing a bundle builder can do.
 *
 * The tray's own figures are therefore a quote, not a price. A tier ladder still
 * needs a matching automatic discount in Shopify admin for the money to come
 * off; a slot with a code now gets there on its own.
 *
 * ## Two kinds of discount, and which one a slot gets
 *
 * The ladder is the tray's: fill three slots and the whole tray is 25% off. A
 * **slot discount** is the merchant's answer for one box — a code and a value
 * configured per slot in the theme editor, rendered into
 * `[data-bundle-discounts]` and read here once.
 *
 * They do not stack. A slot with its own discount is priced by it; a slot
 * without one is priced by the ladder. That is what keeps a store that has never
 * opened the new panel behaving exactly as it did, and it is also the only
 * arrangement a merchant can reason about — "40% off, and also 25% off" is not a
 * number anybody can predict from the panel.
 *
 * The discount belongs to the **slot**, not to the product that happens to be
 * sitting in it, and it is derived from the slot's index every time it is
 * needed rather than copied onto the item when it lands. So there is nothing to
 * keep in step: taking slot 2's product out moves slot 3's product into slot 2,
 * and it is priced by slot 2's discount from that moment — it cannot carry the
 * old slot's code with it, because it never held one.
 *
 * Every slot's code is written onto its own line as a property, where an
 * automatic discount's conditions or a Shopify Function can read it, **and** the
 * set of them is handed to Shopify through `cart.applyDiscount()` once the
 * bundle is in the cart. That call is what makes the drawer agree with the tray:
 * Shopify prices the cart, the cart sections are re-rendered from it, and the
 * line prices and total the customer reads are Shopify's own.
 *
 * What survives is Shopify's decision, not this file's. Codes combine only when
 * the merchant marked them combinable, and an order-level code replaces another
 * order-level code — so `applyDiscount` reads the cart back and reports which
 * ones actually applied instead of assuming all of them did.
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
 * This is the shape the payload is built from and the shape the boxes are drawn
 * from, so the number on screen and the number sent to Shopify are the same
 * calculation rather than two that agree by inspection.
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

  /**
   * The merchant's per-slot discounts, keyed by one-based slot position.
   *
   * Read once, from the JSON `sections/product-bundle.liquid` renders. Nothing
   * about a discount is ever read off a slot's markup: the boxes are drawn from
   * this, so a redraw cannot be the thing that changes what a slot costs.
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

  /** @returns {number} Subtotal in cents, before any discount. */
  get subtotal() {
    return this.#items.reduce((total, item) => total + item.price * item.quantity, 0);
  }

  /**
   * The discount configured for a slot, if it has one of its own.
   *
   * By position, deliberately. See the note at the top: a discount that were
   * copied onto an item when it landed would have to be corrected every time the
   * tray closed a gap, and the version that forgot to do it is the bug where
   * removing slot 2 leaves slot 3's product priced by slot 3's code in slot 2.
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
   * The one place a bundle is priced. The boxes, the total and the line
   * properties all read this, so there is no second calculation to drift.
   *
   * @returns {BundleSlot[]}
   */
  get slots() {
    const ladder = this.percent;

    return this.#items.map((item, index) => {
      const subtotal = item.price * item.quantity;
      const discount = this.discountFor(index);

      // A slot with a code but no value is an automatic discount the merchant
      // configured in admin. The code is carried, the price is not touched — a
      // theme that guessed at the value would be quoting a number Shopify never
      // agreed to.
      const prices = discount !== null && discount.value > 0;

      // An amount comes off each unit, not off the line, so a slot holding three
      // of something saves three times — which is what "£5 off this slot's
      // product" means to the customer who pressed + twice.
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

  /**
   * Empty the tray, all the way back to how it arrived.
   *
   * Everything the customer had chosen goes: the slots, the products, their
   * variants, the quantities set on the rows, the error line and any half-open
   * request into the quick add modal. `render()` then redraws from the emptied
   * state rather than from what the boxes happen to be showing — every slot, the
   * tier badges, the progress bar, the total, the saving and every row's
   * pressed state — so there is nothing left over to see.
   *
   * The row steppers are the part that is easy to miss, because they are not
   * this component's state: they are `<quantity-selector>` instances, and
   * emptying the tray without them left a row still offering 3.
   *
   * **Not** what a successful add to cart does — see `addToCart()`. This is the
   * public "start again" for a merchant or a customisation that wants it, and
   * it is complete so that such a caller does not have to know which of those
   * five things it also needed to reset.
   */
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

    // One bundle at a time. `setLoading()` marks the tray busy but does not
    // disable the button, and a second press while the first request is in
    // flight would reach `cart._post`, which aborts the request already running
    // — so the press that started the add is the one that fails, and the tray
    // shows an error for a bundle that is on its way into the cart.
    if (this.#submitting) return null;

    // "Complete" is a merchant setting. A tray that refuses four of six is right
    // for a fixed-price bundle box and wrong for a mix-and-match ladder, where
    // four is simply a smaller discount.
    if (this.dataset.requireFull === 'true' && !this.isFull) {
      this.#error(themeString('bundleIncomplete', '', { count: this.size - this.#items.length }));
      return null;
    }

    // Raised with the spinner and lowered with it, in the same `finally`, so a
    // refusal above cannot leave the tray permanently unable to submit.
    this.#submitting = true;
    this.setLoading(true);
    this.#error('');

    try {
      const bundleId = this.dataset.bundleId || 'bundle';
      const label = this.dataset.bundleLabel || '';

      // From `slots`, never from the boxes. Every value here — the variant, the
      // quantity, the slot's discount and the percentage that produced its price
      // — is the state the tray was priced from a moment ago, so what Shopify is
      // asked for cannot disagree with what the customer was looking at.
      const lines = this.slots.map((slot) => ({
        id: slot.item.variantId,
        quantity: slot.item.quantity,
        properties: {
          // The leading underscore keeps these out of the customer's view of the
          // cart and out of the order confirmation, while staying available to
          // the merchant, to fulfilment tooling and to a discount's own
          // conditions.
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

      // The tray keeps what the customer built.
      //
      // It used to empty here, and emptying is defensible — the bundle is in the
      // cart, the next one starts from nothing. What it looks like on screen is
      // the whole page going blank at the moment of success, with the drawer
      // covering the only evidence anything happened. The customer's work
      // disappears and the confirmation is behind a panel they have to close to
      // see the empty tray underneath.
      //
      // So the slots, the variants, the quantities and the per-slot discounts
      // all stay exactly as they were. `data-added` marks the tray as having
      // reached the cart, and comes off the moment anything in it changes, so it
      // describes the tray on screen rather than a press that happened earlier.
      //
      // The button deliberately stays enabled: pressing it again adds a second
      // copy of the same bundle, which is a real thing to want and is now the
      // only way to do it. `#submitting` is what guards the accidental version —
      // a double click — and it is a different problem with a different fix.
      this.toggleAttribute('data-added', true);
      announce(themeString('bundleAddedToCart', ''));

      // Hand the slots' codes to Shopify, so the cart the customer is about to
      // look at is priced by Shopify rather than only promised by the tray.
      //
      // Added to whatever the cart already carries rather than replacing it: a
      // code the customer typed into the drawer is theirs, and a bundle add is
      // not a reason to silently take it off them. Which of the resulting set
      // survives is Shopify's call — they combine only when the merchant marked
      // them combinable — and `cart.applyDiscount` reports what actually stuck
      // by reading the cart back, so nothing here has to guess.
      const existing = (cart.state?.attributes?.discount_code || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

      const wanted = [...new Set([...existing, ...codes])];

      if (wanted.length > 0 && wanted.join(',') !== existing.join(',')) {
        await cart.applyDiscount(wanted.join(',')).catch((error) => {
          // The bundle is in the cart and every line carries its own
          // `_bundle_discount_code`. A discount that could not be attached is a
          // smaller problem than a bundle reported as failed, so it is logged
          // and not raised.
          console.warn('[Boost10] The bundle was added but its discount could not be applied.', error);
        });
      }

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

    // `data-added` says "the tray on screen is in the cart". Every path that
    // changes what is on screen comes through here, and none of them calls
    // `addToCart()` — so clearing it here is what keeps the flag a statement
    // about the current tray rather than a memory of an earlier press.
    this.removeAttribute('data-added');

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

    // A quick add this tray did not start. See `#claimQuickAdd`.
    //
    // Two hooks, because there are two ways the modal can come to be showing a
    // product. `SECTION_RENDERED` is the fetch, and it is the one that matters
    // for the button's first paint. `OVERLAY_OPEN` is for the reopen:
    // `<quick-add-modal>` does not re-fetch a product it is already holding
    // (`#loadedUrl`), so closing the modal and opening it again on the same
    // product renders nothing at all — and without this, the second visit to a
    // bundle product offered "Add to cart".
    this.on(modal, EVENTS.SECTION_RENDERED, () => this.#claimQuickAdd());
    this.on(modal, EVENTS.OVERLAY_OPEN, () => this.#claimQuickAdd({ redraw: true }));

    // Closing without choosing is a cancelled request, not a failed one. The
    // flag has to come off either way or the next ordinary quick add from a
    // product card would be swallowed by this tray.
    this.on(modal, EVENTS.OVERLAY_CLOSE, () => this.#clearPending());
  }

  /**
   * Claim a quick add that was opened on a product this tray sells.
   *
   * A customer does not only reach the modal through a tray row. They reach it
   * from a product card in a grid further down the page, from a recommendation,
   * from anywhere the theme offers quick add — and for a product the bundle is
   * built out of, the honest button there says "Add to bundle", because that is
   * where the product is going to end up. A modal that promised the cart and
   * then dropped the product into slot 4 would be lying about the press; one
   * that added straight to the cart would silently sell a product outside the
   * bundle the customer is halfway through building.
   *
   * Which products those are is not written down anywhere new. It is the rows
   * this section already rendered — the merchant's categories, their
   * collections, their products. Nothing is matched on a handle, an id or a
   * title, so a merchant who swaps a collection changes what quick add says with
   * no second list to keep in step.
   *
   * The claim is made on `SECTION_RENDERED` wherever it can be, because that
   * fires synchronously from the morph that puts the product in the modal —
   * before `<quick-add-summary>`'s queued render, which is what reads the flag.
   * Claimed any later and the button paints "Add to cart" first and corrects
   * itself a frame afterwards.
   *
   * @param {Object} [options]
   * @param {boolean} [options.redraw=false] Ask the summary to rewrite the
   *   button. Needed only on the reopen path, where nothing rendered.
   * @private
   */
  #claimQuickAdd({ redraw = false } = {}) {
    // This tray already opened it, on a row it is holding. Nothing to claim.
    if (this.#pendingRow) return;

    const modal = this.#quickAdd;
    if (!modal || modal.dataset.bundleMode) return;

    const product = parseJSONScript(modal.querySelector('[data-quick-add-product]'));
    const productId = Number(product?.id);
    const row = product ? this.#rowFor(productId) : null;
    if (!row) return;

    // The product is already in a slot, or the tray is full. Either way this is
    // not an add to the bundle, so quick add stays what it is: the ordinary way
    // to buy one of something.
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

    // Two trays on one page would both be listening on the same modal, and
    // `stopPropagation()` does not stop a sibling listener on the element it is
    // called from. Whichever claimed the modal owns this press.
    if (modal.dataset.bundleMode !== (this.dataset.sectionId || '')) return;

    const product = parseJSONScript(modal.querySelector('[data-quick-add-product]'));
    if (!product) return;

    // The picker is the source of truth for which variant is selected — it owns
    // that state and everything else on a product reflects it. The form field is
    // the fallback, and only that: it is one of several `name="id"` controls the
    // modal can end up with, `FormData` answers with whichever comes first in
    // tree order, and "first in tree order" is not a statement about what the
    // customer chose.
    const picker = modal.querySelector('variant-picker');
    const selected = Number(/** @type {any} */ (picker)?.currentVariant?.id) || 0;
    const variantId = selected || Number(new FormData(form).get('id'));

    const variant = product.variants?.find((entry) => Number(entry.id) === variantId);
    if (!variant) return;

    // Capture phase, so `<product-form>`'s own submit listener on this form is
    // never reached and `/cart/add.js` is never called.
    event.preventDefault();
    event.stopPropagation();

    // Sold out since the modal opened, or a combination that does not exist. The
    // button is disabled in both cases, so this is the keyboard path — and a
    // slot filled with a variant that cannot be bought is a bundle that fails at
    // the one press that matters, six decisions later.
    if (variant.available === false) {
      const message = themeString('soldOut', '');
      this.#error(message);
      announceUrgent(message);
      return;
    }

    // The modal's own stepper, not the row's. A customer who opened the modal
    // to choose a flavour has a quantity control in front of them, and taking
    // the row's number instead would silently overrule the one they just set.
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

    // ---- the modal's own button spins too -------------------------------
    //
    // `stopPropagation()` above is what makes this necessary. It is the whole
    // point of the interception — `<product-form>`'s submit listener never runs,
    // so `/cart/add.js` is never called — but that listener is also the only
    // thing that would have called `setLoading()`, so in bundle mode the modal's
    // button was the one add control in the section that acknowledged nothing.
    // A customer pressed "Add to bundle" and watched a button that had not
    // moved until the modal went away.
    //
    // `setLoading` rather than writing `data-loading` here: it is the
    // component's own public API and it sets `aria-busy` with the flag, so a
    // screen reader is told the button is working rather than only sighted
    // customers seeing it.
    const productForm = form.closest('product-form');
    productForm?.setLoading?.(true);

    // The same beat the row's control takes, for the same reason: dropping a
    // chosen variant into a slot is synchronous, so the spin is the transition
    // rather than a request. Using one constant keeps the two controls in step
    // — pressing add in the modal and pressing + on a simple row should feel
    // like the same action, because they are.
    wait(MIN_SPIN).then(() => {
      // The row's spinner comes off before the product goes in, not after.
      //
      // `add()` redraws the tray, which writes `aria-pressed="true"` onto that
      // row's control — and every glyph on it shares one grid cell, so a tick
      // set while the flag is still up is a tick drawn inside a spinner. The
      // direct path in `#hold` orders these the same way.
      //
      // `#releaseRow` and not `#clearPending`, because the modal's
      // `data-bundle-mode` must outlive this: `<quick-add-summary>` reads it to
      // decide whether the button says "Add to bundle" or "Add to cart", and
      // anything that re-rendered the label between here and the modal actually
      // being gone would flash the wrong one. The close event clears it.
      this.#releaseRow();
      this.add(item);

      // The modal's spinner is released after the exit, not before it. Closing
      // is the answer to the press, so the button should still be working while
      // it happens — and it has to be released at all, because a modal reopened
      // on the same product is not re-fetched (`#loadedUrl` in `dialog.js`) and
      // would come back with a button still spinning.
      Promise.resolve(modal?.close?.()).finally(() => productForm?.setLoading?.(false));
    });
  };

  /**
   * Hand a product with options to the quick add modal.
   *
   * ## The spinner lasts as long as the press does
   *
   * It comes up here and comes off in `#releaseRow`, which means it is up for
   * the fetch, the entrance *and* the whole time the customer is choosing a
   * flavour. That is longer than "until the modal has appeared", and
   * deliberately: the press is not finished when the modal opens, it is
   * finished when the customer has either chosen or given up. A row that went
   * back to a plus the moment the panel appeared was saying the press was over
   * while the thing it started was still on screen.
   *
   * So the row resolves into exactly one of two things, and never needs a third:
   *
   *   added      `#onQuickAddSubmit` releases the row and then adds — the tick
   *   dismissed  the overlay's close event releases it — back to the plus
   *
   * Every path runs `#releaseRow` — the second through `#clearPending`, which
   * releases the modal as well — so there is no way to leave a row spinning at
   * a modal that is gone.
   *
   * @param {HTMLElement} row
   * @private
   */
  #openQuickAddFor(row) {
    const modal = this.#quickAdd;
    const button = row.querySelector('[data-bundle-add]');
    if (!(button instanceof HTMLElement)) return;

    // No modal on the page means quick add is switched off in theme settings.
    // The product page is then the only place the options exist, so that is
    // where the customer goes — a control that does nothing would be worse.
    //
    // The spinner stays on through this: the page is leaving, and a control
    // that settles back to a plus while the browser navigates says the press
    // did nothing.
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

    // The number the customer set on the row, carried into the modal.
    //
    // The row has a stepper and so does the modal, and they were two unrelated
    // controls: setting a row to 3 and pressing + opened a modal that said 1,
    // and 1 is what went into the slot — the modal's stepper is what
    // `#onQuickAddSubmit` reads. So the number the customer had chosen was
    // silently discarded by the step that was meant to ask them for one more
    // decision, not fewer.
    //
    // Read now rather than when the modal lands, so it is the value that was on
    // screen when they pressed the button.
    const quantity = quantityOf(row);

    // `open()` is async and the spinner does not wait on it — the flag is
    // already up and `#clearPending` is what takes it down. What does wait is
    // the quantity: the modal's stepper does not exist until the product's
    // section has been fetched into it, which is what this promise resolves
    // after.
    //
    // The catch is for the case the overlay never opens at all: without it a
    // rejection would leave a row spinning with no modal on screen to close and
    // no way back to the plus.
    Promise.resolve(modal.open?.(button))
      .then(() => this.#applyQuantity(modal, quantity))
      .catch(() => this.#clearPending());
  }

  /**
   * Set the modal's stepper to the number the row was showing.
   *
   * Through `<product-form>`'s own `setQuantity()` where it exists, because
   * that is the method that knows to go through `<quantity-selector>` — which
   * clamps to the product's own min, max and increment, redraws its buttons and
   * announces the change, so the add button's label updates with it. Writing
   * the input directly would set a number past a maximum the merchant had set
   * and leave the label saying the old one.
   *
   * The input is the fallback for the frame before those modules land. It is
   * the value the customer can see either way, and the component reads the
   * input rather than its own state when it arrives.
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
   * Separate from the modal's half because the two want different moments. The
   * row has to settle *before* `add()` redraws the tray onto it; the modal's
   * `data-bundle-mode` has to survive until the modal is actually gone, because
   * `<quick-add-summary>` reads it on every render to decide whether the button
   * says "Add to bundle" or "Add to cart".
   *
   * Idempotent: the submit path releases the row and the close event then
   * arrives on a tray that has already finished.
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

  /* ---------------------------------------------------------- internals -- */

  /**
   * Read the merchant's per-slot discounts, once.
   *
   * Anything malformed is dropped rather than allowed to price a slot: a value
   * that is not a number is a slot the merchant has not finished configuring,
   * and pricing it at zero would be the tray inventing a discount.
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

      // A code with no value is kept. It is an automatic discount the merchant
      // set up in admin, which this cannot price and must not pretend to: the
      // code rides on the slot's line and the slot stays at the ladder's price.
      if (value === 0 && code === '') continue;

      this.#discounts.set(slot, { slot, code, type, value });
    }
  }

  /**
   * The distinct discount codes the filled slots name, in slot order.
   *
   * The order is load-bearing and `Set` is what preserves it. Two order-level
   * codes do not combine, so when a merchant has used the slots as a ladder —
   * slot 1 carries the one-item code, slot 2 the two-item code — the one Shopify
   * ends up keeping should be the one for the tier actually reached, which is
   * the last filled slot's. Sorting or de-duplicating some other way would quietly
   * hand the customer the smallest discount they qualified for.
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
   * Through `<quantity-selector>`'s own `setValue()` where it has arrived, so the
   * number, the buttons' disabled states and the announcement all move together;
   * the input is the fallback for the frame before the module lands, and is the
   * value the customer can see either way.
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

    // A press that is already being acted on.
    //
    // Both paths leave a window where the tray does not yet hold the product,
    // so the duplicate rule above cannot see it: the direct path's is the beat
    // the spinner is up, and the options path's is however long the customer
    // spends choosing a flavour. Either way a second press would start a second
    // one, and on the options path it would re-open a modal that is already on
    // screen over the top of the row.
    if (button.dataset.loading !== undefined) return;

    if (row.dataset.needsOptions === 'true') {
      // The spinner is not this method's to release on this path. It comes up
      // in `#openQuickAddFor` and stays up for as long as the press is unfinished
      // — which is until the customer has chosen a flavour or closed the modal,
      // not until the modal has finished appearing. `#releaseRow` is where both
      // of those meet.
      this.#openQuickAddFor(row);
      return;
    }

    // The quantity is read now rather than when the spin ends, so what goes
    // into the slot is the number the customer was looking at when they
    // pressed — not whatever the stepper says 420ms later.
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
   * This is the direct path only. Dropping a product into a slot is
   * synchronous — it is done before the browser has painted the press — so
   * there is no request here for the spinner to be honest about. What it is
   * honest about is the *transition*: `MIN_SPIN` is how long the plus takes to
   * become a tick, the same way the panel's entrance in `assets/base.css` has a
   * length.
   *
   * Holding the work until the flag comes off is half of the fix for a row that
   * drew both glyphs at once. Adding on the click set `aria-pressed` straight
   * away, so the button was pressed and loading together — and with every glyph
   * in one grid cell, "both shown" means "both drawn on top of each other". Now
   * they cannot overlap in time either: the spinner comes up, the flag comes
   * off, and the product lands in the slot in the same frame the tick replaces
   * it. (The other half is rule order in `assets/base.css`; each alone still
   * left a way to draw both.)
   *
   * The options path does not come through here. Its spinner is not a beat —
   * it stays up for as long as the press is unfinished, which is the whole time
   * the modal is open. See `#openQuickAddFor`.
   *
   * @param {HTMLElement} button
   * @param {() => void} then Run once the spinner has come off, in the same task.
   * @private
   */
  #hold(button, then) {
    button.dataset.loading = '';

    wait(MIN_SPIN).then(() => {
      // The row may have been morphed away by a section re-render while the
      // press was in flight, in which case this is a flag on a detached node
      // and removing it is simply free.
      delete button.dataset.loading;

      // After the flag, never before: `add()` redraws the tray and writes
      // `aria-pressed` onto this button, and doing that while the spinner is
      // still up is the overlap this ordering exists to prevent.
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

      // Outside the branch above, so emptying a slot clears its price rather
      // than parking the last one behind a hidden element — where it would be
      // waiting for the next product to land, under the wrong figures, for the
      // one frame before this runs again.
      this.#renderSlotPricing(slot, pricing);

      // A tier badge is only true once the tray has reached it. Before that it
      // is what filling the slot would unlock, and it says so by being marked
      // locked rather than by changing its words.
      const tier = slot.querySelector('[data-slot-tier]');
      if (tier instanceof HTMLElement) {
        tier.toggleAttribute('data-reached', this.count >= index + 1);
      }
    }
  }

  /**
   * What one filled slot costs, and the code that made it so.
   *
   * Silent when there is nothing to say: a slot priced at its full price shows
   * only the price, and the struck-through figure and the code appear only when
   * money is actually coming off. A code shown beside an unchanged price reads
   * as a discount that did not work.
   *
   * @param {Element} slot
   * @param {BundleSlot|null} pricing
   * @private
   */
  #renderSlotPricing(slot, pricing) {
    const container = slot.querySelector('[data-slot-pricing]');
    if (!(container instanceof HTMLElement)) return;

    // Only a slot with a discount of its own says anything.
    //
    // A ladder discount is order-level — "three items and the order is 25% off"
    // — so printing a share of it under each box would be the tray inventing a
    // per-line price that no line actually has, on every store already running
    // this section. A slot the merchant priced is the opposite: the number under
    // it is the whole reason the panel exists.
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

      // A code with no value of its own names an automatic discount this cannot
      // price. It is shown, because the customer should know it is coming; no
      // amount is shown beside it, because there is no honest one to give.
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

      // A single percentage only describes the saving while the ladder is the
      // only thing discounting. Once a slot is priced by its own code, the
      // amount is the whole of what can honestly be said about the tray — the
      // per-slot line under each box says the rest.
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
   * from a slot, or dropped by `clear()` all come out the same.
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
