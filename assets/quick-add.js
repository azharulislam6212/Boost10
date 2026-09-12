/**
 * quick-add.js — Boost10
 *
 * `<quick-add-summary>` — the one piece of the quick add modal that cannot be
 * written in Liquid.
 *
 * The drawing has the add button reading "Add To Cart · $35.92 · Avocados": the
 * price and the chosen option, on the control that commits to them. Both change
 * without a request, so both have to be written here.
 *
 * ## Why this is a separate element and not part of `<product-form>`
 *
 * `product-form.js` owns that button. On every variant change it sets
 * `button.textContent`, which is the right thing for it to do — it is the
 * component that knows whether a variant is available, sold out or a preorder,
 * and those three words are the button's real state.
 *
 * Writing the price from inside that component would mean teaching it about
 * selling plan allocations and money formatting, which belong to the modal.
 * Writing it from a second component that also sets `textContent` would be two
 * writers racing over one node.
 *
 * So this one never competes: it runs after the form has written, and only when
 * the form has left the button **enabled**. A sold-out variant keeps the form's
 * word for it, with no price appended to a button nobody can press.
 *
 * "After" is a `queueMicrotask`, not a guess at listener order. Both components
 * listen for `variant:change` on the same root; the order they were upgraded in
 * decides who hears it first, and that order depends on which custom element
 * definition arrived first — not something markup should have to depend on.
 *
 * ## Bundle mode
 *
 * The same modal chooses a variant for a bundle slot. `<product-bundle>` sets
 * `data-bundle-mode` on the modal while such a request is pending, and the
 * label becomes "Add to bundle" — the button must not promise a cart it is not
 * going to reach. Nothing else about the modal changes.
 *
 * @module @theme/quick-add
 */

import { BaseComponent, defineComponent } from '@theme/component';
import { EVENTS } from '@theme/events';
import { formatMoney, parseJSONScript, themeString, labelTarget } from '@theme/utilities';

/**
 * What joins the label, the price and the chosen option on the add button.
 *
 * It is a constant because it is read as well as written — see `#renderButton`,
 * which recovers the form's own label by splitting the button on it.
 */
const SEPARATOR = ' · ';

/**
 * Markup:
 *
 *   <quick-add-summary data-product-id="123" data-add-label="Add to cart">
 *   </quick-add-summary>
 *
 * It renders nothing itself. Everything it writes belongs to elements its
 * siblings already put on the page.
 */
export class QuickAddSummary extends BaseComponent {
  /** @type {Object|null} */
  #product = null;

  /** @type {Record<string, Array<{id:number,name:string,price:number}>>} */
  #allocations = {};

  /** @type {number|null} */
  #variantId = null;

  /** @type {number|null} */
  #planId = null;

  /** @type {number} */
  #quantity = 1;

  setup() {
    this.#product = parseJSONScript(this.root.querySelector?.('[data-quick-add-product]')) || null;
    this.#allocations = parseJSONScript(this.root.querySelector?.('[data-allocations]')) || {};

    const picker = this.root.querySelector?.('variant-picker');
    this.#variantId = Number(picker?.currentVariant?.id) || this.#firstVariantId();

    this.on(this.root, EVENTS.VARIANT_CHANGE, (event) => {
      this.#variantId = Number(event.detail?.variant?.id) || null;
      this.schedule();
    });

    this.on(this.root, EVENTS.VARIANT_UNAVAILABLE, () => {
      this.#variantId = null;
      this.schedule();
    });

    this.on(this.root, EVENTS.SELLING_PLAN_CHANGE, (event) => {
      const value = event.detail?.sellingPlan ?? event.detail?.selling_plan ?? null;
      this.#planId = value ? Number(value) : null;
      this.schedule();
    });

    this.on(this.root, EVENTS.QUANTITY_CHANGE, (event) => {
      const value = Number(event.detail?.quantity);
      if (Number.isFinite(value) && value > 0) this.#quantity = value;
      this.schedule();
    });

    this.schedule();
  }

  /* --------------------------------------------------------- public API -- */

  /**
   * The modal, not the document.
   *
   * A modal opened over a product page has the page's `<variant-picker>` and
   * `<product-form>` behind it. Scoping to the fetched content is what stops
   * this writing the page's button instead of the modal's.
   *
   * @returns {HTMLElement|Document}
   */
  get root() {
    return this.closest('[data-quick-add-content]') || this.closest('[data-product-root]') || document;
  }

  /**
   * Run `render()` once the current event has finished being delivered.
   *
   * @returns {void}
   */
  schedule() {
    if (this.#pending) return;
    this.#pending = true;

    queueMicrotask(() => {
      this.#pending = false;
      this.render();
    });
  }

  /**
   * @returns {void}
   */
  render() {
    this.#renderPlanPrices();
    this.#renderButton();
  }

  /* ---------------------------------------------------------- internals -- */

  /** @type {boolean} */
  #pending = false;

  /**
   * @returns {number|null}
   * @private
   */
  #firstVariantId() {
    const first = this.#product?.variants?.find((variant) => variant.available) || this.#product?.variants?.[0];
    return first ? Number(first.id) : null;
  }

  /**
   * @returns {Object|null}
   * @private
   */
  get #variant() {
    if (!this.#variantId) return null;
    return this.#product?.variants?.find((variant) => Number(variant.id) === this.#variantId) || null;
  }

  /**
   * What one unit costs right now: the selling plan's price when one is chosen,
   * the variant's price otherwise.
   *
   * @returns {number|null} Cents.
   * @private
   */
  get #unitPrice() {
    const variant = this.#variant;
    if (!variant) return null;

    if (this.#planId) {
      const plans = this.#allocations?.[String(variant.id)] || [];
      const plan = plans.find((entry) => Number(entry.id) === this.#planId);
      if (plan && Number.isFinite(Number(plan.price))) return Number(plan.price);
    }

    return Number.isFinite(Number(variant.price)) ? Number(variant.price) : null;
  }

  /**
   * Keep each purchase-option card's price in step with the chosen variant.
   *
   * A product whose flavours are priced differently otherwise shows the first
   * flavour's price on a card the customer has just moved away from.
   *
   * @private
   */
  #renderPlanPrices() {
    const variant = this.#variant;
    if (!variant) return;

    // `[data-price-current]` and `[data-price-compare]` are the hooks
    // `snippets/price.liquid` writes — matching on them rather than on a class
    // means the markup can be restyled without this silently stopping.
    const oneTime = this.root.querySelector('[data-one-time-price] [data-price-current]');
    if (oneTime instanceof HTMLElement) oneTime.textContent = formatMoney(Number(variant.price));

    this.#renderSaving('[data-one-time-price]', Number(variant.compare_at_price), Number(variant.price));

    const plans = this.#allocations?.[String(variant.id)] || [];
    const chosen = plans.find((entry) => Number(entry.id) === this.#planId) || plans[0];

    const planPrice = this.root.querySelector('[data-plan-price] [data-price-current]');
    if (planPrice instanceof HTMLElement && chosen) planPrice.textContent = formatMoney(Number(chosen.price));

    const planCompare = this.root.querySelector('[data-plan-price] [data-price-compare]');
    if (planCompare instanceof HTMLElement && chosen) {
      const compare = Number(chosen.compare_at_price);
      const show = Number.isFinite(compare) && compare > Number(chosen.price);

      planCompare.textContent = show ? formatMoney(compare) : '';
      planCompare.toggleAttribute('hidden', !show);
    }

    if (chosen) {
      this.#renderSaving('[data-plan-price]', Number(chosen.compare_at_price), Number(chosen.price));
    }
  }

  /**
   * Keep one card's saving badge in step with the price above it.
   *
   * The percentage was the one part of a price nothing updated. The figures
   * either side of it are rewritten on every flavour change, so a product whose
   * flavours discount differently showed the new prices with the old card's
   * percentage between them — two numbers that disagreed, on the line the
   * customer is deciding from.
   *
   * Percentage only, and always. `price.liquid` offers the merchant an amount
   * or a plain word as well, and honouring that here would mean re-reading
   * which one they chose from a string this has just replaced. The badge is
   * hidden outright when there is no saving, so a flavour that is not on sale
   * does not keep the last one's.
   *
   * @param {string} scope Selector for the card's price container.
   * @param {number} compare
   * @param {number} price
   * @private
   */
  #renderSaving(scope, compare, price) {
    const badge = this.root.querySelector(`${scope} [data-price-saving]`);
    if (!(badge instanceof HTMLElement)) return;

    const saving = Number.isFinite(compare) && Number.isFinite(price) && compare > price;
    badge.toggleAttribute('hidden', !saving);
    if (!saving) return;

    const percent = Math.round(((compare - price) / compare) * 100);
    badge.textContent = themeString('salePercent', '', { percent }) || `-${percent}%`;
  }

  /**
   * Append the total and the chosen option to whatever `product-form.js` last
   * wrote on the button.
   *
   * The form's own words are never replaced — they are the state. This adds to
   * them, and only when the button is something a customer can press.
   *
   * @private
   */
  #renderButton() {
    const button = this.root.querySelector('product-form [data-ref="submit"]');
    if (!(button instanceof HTMLButtonElement)) return;

    // Sold out, unavailable, loading. The form is saying something more
    // important than a price, and it keeps the whole button.
    if (button.disabled) return;

    // `<product-bundle>` sets the flag on the modal element, which is an
    // ancestor of everything the section rendered into it.
    const bundleMode = this.closest('[data-bundle-mode]') !== null;

    // The form's current word for the button, taken fresh every time.
    //
    // It is read back off the button rather than remembered, because the form
    // rewrites it: "Add to cart" for an ordinary variant, "Pre-order" for one
    // on backorder. A remembered first value would still say "Add to cart"
    // after the customer switched to a variant that is a pre-order.
    //
    // Splitting on the separator is what makes re-reading safe. Every run ends
    // with `<label>{SEPARATOR}<price>…`, so taking the first segment recovers
    // exactly what the form wrote, whether this has run before or not — and no
    // label the form writes contains the separator.
    // The span the form writes into when the button has one, and the button
    // otherwise. Reading the base label from the same element the next line
    // writes to is what keeps the round trip exact — taking it off the button
    // while writing to a span inside it would fold the spinner's own (empty)
    // text into the label on every pass.
    const label = labelTarget(button);

    const base = bundleMode
      ? themeString('bundleAdd', this.dataset.addLabel || '')
      : label.textContent.split(SEPARATOR)[0].trim() || this.dataset.addLabel || '';

    const parts = [base];

    const unit = this.#unitPrice;
    if (Number.isFinite(unit)) parts.push(formatMoney(unit * this.#quantity));

    // The option only earns a place when there is a real one to name. A product
    // with a single default variant has "Default Title" and nothing to say.
    const variant = this.#variant;
    if (variant && this.#product?.has_only_default_variant === false && variant.title) {
      parts.push(variant.title);
    }

    label.textContent = parts.join(SEPARATOR);
  }
}

defineComponent('quick-add-summary', QuickAddSummary);

export default { QuickAddSummary };
